#!/usr/bin/env node
// Authenticated HTTP trigger for Antfarm workflow runs — lets the
// scheduled cloud coordinator (no WSL2 shell access) kick off a real
// `antfarm workflow run <workflowId> "<task>"` from outside the machine,
// via a Cloudflare Tunnel pointed at this server.
//
// Run from the antfarm root so `antfarm` resolves and relative paths
// (logs/) land in a sane place:
//   cd ~/.openclaw/workspace/antfarm && node local-tools/coordinator-trigger.mjs
//
// Required env:
//   COORDINATOR_TOKEN   bearer secret the caller must present
// Optional env:
//   COORDINATOR_PORT       default 3335
//   COORDINATOR_ANTFARM_CLI   default "<ANTFARM_ROOT>/dist/cli/cli.js" — this
//     repo's `antfarm` isn't installed as a global command (only declared as
//     a `bin` in package.json, never `npm link`ed), so it's invoked as
//     `node dist/cli/cli.js ...` directly, same as config-dashboard.mjs does.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";

const PORT = process.env.COORDINATOR_PORT ? Number(process.env.COORDINATOR_PORT) : 3335;
const TOKEN = process.env.COORDINATOR_TOKEN;
const ANTFARM_ROOT = process.cwd();
const ANTFARM_CLI = process.env.COORDINATOR_ANTFARM_CLI || path.join(ANTFARM_ROOT, "dist", "cli", "cli.js");
const LOG_DIR = path.join(ANTFARM_ROOT, "local-tools", "logs");

if (!TOKEN) {
  console.error("COORDINATOR_TOKEN is not set — refusing to start (would be an open door).");
  process.exit(1);
}

if (!fs.existsSync(ANTFARM_CLI)) {
  console.error(`Antfarm CLI not found at ${ANTFARM_CLI} — set COORDINATOR_ANTFARM_CLI or run from the antfarm root.`);
  process.exit(1);
}

fs.mkdirSync(LOG_DIR, { recursive: true });

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      try {
        resolve(chunks ? JSON.parse(chunks) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function checkAuth(req) {
  const header = req.headers["authorization"] || "";
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || !value) return false;
  // constant-time compare
  const a = Buffer.from(value);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function runId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}-${crypto.randomBytes(3).toString("hex")}`;
}

function startWorkflowRun({ workflow, task }) {
  const id = runId();
  const logPath = path.join(LOG_DIR, `${id}.log`);
  const logFd = fs.openSync(logPath, "a");

  const child = spawn(process.execPath, [ANTFARM_CLI, "workflow", "run", workflow, task], {
    cwd: ANTFARM_ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  return { id, pid: child.pid, logPath };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;

  // Unauthenticated health check — used to confirm the tunnel is reachable.
  if (p === "/health" && req.method === "GET") {
    return json(res, { ok: true, service: "coordinator-trigger", time: new Date().toISOString() });
  }

  if (p === "/trigger" && req.method === "POST") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, { ok: false, error: "invalid JSON body" }, 400);
    const workflow = typeof body.workflow === "string" && body.workflow.trim() ? body.workflow.trim() : "thecoach-dev";
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (!task) return json(res, { ok: false, error: "'task' (string) is required" }, 400);

    try {
      const result = startWorkflowRun({ workflow, task });
      return json(res, { ok: true, ...result, workflow, task }, 202);
    } catch (err) {
      return json(res, { ok: false, error: err?.message || String(err) }, 500);
    }
  }

  if (p === "/logs" && req.method === "GET") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);
    const id = url.searchParams.get("id") || "";
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return json(res, { ok: false, error: "invalid id" }, 400);
    const logPath = path.join(LOG_DIR, `${id}.log`);
    if (!fs.existsSync(logPath)) return json(res, { ok: false, error: "not found" }, 404);
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(fs.readFileSync(logPath, "utf-8"));
  }

  // Real live step-by-step status via antfarm's own CLI — query is a task
  // substring or run-ID prefix (antfarm's own semantics, not ours), or
  // omit for a list of recent runs. Runs synchronously; antfarm's CLI
  // returns quickly for a status check (unlike `workflow run`, which is
  // fire-and-forget via /trigger above).
  if (p === "/status" && req.method === "GET") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);
    const query = url.searchParams.get("query") || "";
    const args = ["workflow", "status"];
    if (query) args.push(query);
    execFile(process.execPath, [ANTFARM_CLI, ...args], { cwd: ANTFARM_ROOT, timeout: 15_000 }, (err, stdout, stderr) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(stdout || stderr || (err ? String(err) : ""));
    });
    return;
  }

  json(res, { ok: false, error: "not found" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Coordinator trigger server: http://127.0.0.1:${PORT}`);
  console.log(`Antfarm root: ${ANTFARM_ROOT}`);
  console.log(`Antfarm CLI: ${ANTFARM_CLI}`);
  console.log(`Logs: ${LOG_DIR}`);
});
