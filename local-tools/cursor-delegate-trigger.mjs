#!/usr/bin/env node
// Standalone host-side delegation trigger — NOT wired into any agent role
// or openclaw.json yet. Runs on the real host filesystem (full read-write,
// no sandbox), so it's the only thing in the whole design allowed to
// actually invoke `agent -p` with write access. A sandboxed OpenClaw
// container (workspaceAccess: "ro") would eventually call this over HTTP
// instead of shelling out to `agent -p` directly — but for now this is
// just being smoke-tested on its own, by hand, from this WSL2 shell.
//
// Modeled directly on local-tools/coordinator-trigger.mjs's pattern:
// bearer-token auth, detached spawn, log-file + polling (not a blocking
// HTTP response), since `agent -p` calls can be slow.
//
// Run:
//   DELEGATE_TOKEN=some-secret node cursor-delegate-trigger.mjs
//
// Required env:
//   DELEGATE_TOKEN   bearer secret the caller must present
// Optional env:
//   DELEGATE_PORT    default 3336

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const PORT = process.env.DELEGATE_PORT ? Number(process.env.DELEGATE_PORT) : 3336;
const TOKEN = process.env.DELEGATE_TOKEN;
const LOG_DIR = path.join(process.cwd(), "delegate-logs");

if (!TOKEN) {
  console.error("DELEGATE_TOKEN is not set — refusing to start (would be an open door).");
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
  const a = Buffer.from(value);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function runId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}-${crypto.randomBytes(3).toString("hex")}`;
}

function startDelegation({ repo, prompt, force }) {
  const id = runId();
  const logPath = path.join(LOG_DIR, `${id}.log`);
  const logFd = fs.openSync(logPath, "a");

  const args = ["-p"];
  if (force) args.push("--force");
  args.push("--output-format", "json", prompt);

  const child = spawn("agent", args, {
    cwd: repo,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  return { id, pid: child.pid, logPath };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === "/health" && req.method === "GET") {
    return json(res, { ok: true, service: "cursor-delegate-trigger", time: new Date().toISOString() });
  }

  if (p === "/delegate" && req.method === "POST") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, { ok: false, error: "invalid JSON body" }, 400);
    const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const force = body.force !== false;
    if (!repo) return json(res, { ok: false, error: "'repo' (absolute path, string) is required" }, 400);
    if (!fs.existsSync(repo)) return json(res, { ok: false, error: `repo path does not exist: ${repo}` }, 400);
    if (!prompt) return json(res, { ok: false, error: "'prompt' (string) is required" }, 400);

    try {
      const result = startDelegation({ repo, prompt, force });
      return json(res, { ok: true, ...result, repo, prompt }, 202);
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

  json(res, { ok: false, error: "not found" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Cursor delegate trigger: http://127.0.0.1:${PORT}`);
  console.log(`Logs: ${LOG_DIR}`);
  console.log("This is a standalone smoke-test server — not wired into any agent role yet.");
});
