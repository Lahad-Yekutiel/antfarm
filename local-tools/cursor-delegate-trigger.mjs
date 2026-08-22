#!/usr/bin/env node
// Standalone host-side delegation trigger — NOT wired into any agent role
// or openclaw.json yet. Runs on the real host filesystem (full read-write,
// no sandbox), so it's the only thing in the whole design allowed to
// actually invoke `agent -p` with write access.
//
// Run:
//   DELEGATE_TOKEN=some-secret node cursor-delegate-trigger.mjs
//
// Required env:
//   DELEGATE_TOKEN   bearer secret the caller must present
// Optional env:
//   DELEGATE_PORT         default 3336
//   DELEGATE_LOG_DIR      default ~/.openclaw/delegate-logs
//   DELEGATE_TIMEOUT_MS   default 25 minutes (must stay under ~30-minute agent step timeout)
//   DELEGATE_AGENT_BIN    default "agent" — binary to spawn for delegation

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const PORT = process.env.DELEGATE_PORT ? Number(process.env.DELEGATE_PORT) : 3336;
const TOKEN = process.env.DELEGATE_TOKEN;
const LOG_DIR = process.env.DELEGATE_LOG_DIR?.trim()
  || path.join(os.homedir(), ".openclaw", "delegate-logs");
const DELEGATE_TIMEOUT_MS = process.env.DELEGATE_TIMEOUT_MS
  ? Number(process.env.DELEGATE_TIMEOUT_MS)
  : 25 * 60 * 1000;
const AGENT_BIN = process.env.DELEGATE_AGENT_BIN?.trim() || "agent";

/** @type {Map<string, { id: string; repo: string; startedAt: string }>} */
const activeByRepo = new Map();

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

function statusPath(id) {
  return path.join(LOG_DIR, `${id}.status.json`);
}

function readStatus(id) {
  const p = statusPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function writeStatus(id, patch) {
  const existing = readStatus(id) || { id };
  const next = { ...existing, ...patch, id };
  fs.writeFileSync(statusPath(id), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function resolveRepoPath(repo) {
  return path.resolve(repo);
}

function startDelegation({ repo, prompt, force }) {
  const id = runId();
  const resolvedRepo = resolveRepoPath(repo);
  const logPath = path.join(LOG_DIR, `${id}.log`);
  const startedAt = new Date().toISOString();

  writeStatus(id, { state: "running", startedAt, endedAt: null, exitCode: null, repo: resolvedRepo });

  const logFd = fs.openSync(logPath, "a");

  const args = ["-p"];
  if (force) args.push("--force");
  args.push("--output-format", "json", prompt);

  const child = spawn(AGENT_BIN, args, {
    cwd: resolvedRepo,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  let timeoutHandle = null;
  if (Number.isFinite(DELEGATE_TIMEOUT_MS) && DELEGATE_TIMEOUT_MS > 0) {
    timeoutHandle = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* best effort */ }
      }
      writeStatus(id, {
        state: "timeout",
        endedAt: new Date().toISOString(),
        exitCode: null,
      });
      activeByRepo.delete(resolvedRepo);
      try { fs.closeSync(logFd); } catch { /* already closed */ }
    }, DELEGATE_TIMEOUT_MS);
    if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
  }

  child.on("error", (err) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    fs.appendFileSync(logPath, `\n[delegate-trigger] spawn error: ${err.message}\n`);
    writeStatus(id, {
      state: "spawn_failed",
      endedAt: new Date().toISOString(),
      exitCode: null,
      error: err.message,
    });
    activeByRepo.delete(resolvedRepo);
    try { fs.closeSync(logFd); } catch { /* ignore */ }
  });

  child.on("exit", (code, signal) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const status = readStatus(id);
    if (status?.state === "timeout" || status?.state === "spawn_failed") {
      activeByRepo.delete(resolvedRepo);
      try { fs.closeSync(logFd); } catch { /* ignore */ }
      return;
    }
    writeStatus(id, {
      state: "exited",
      endedAt: new Date().toISOString(),
      exitCode: code,
      signal: signal ?? null,
    });
    activeByRepo.delete(resolvedRepo);
    try { fs.closeSync(logFd); } catch { /* ignore */ }
  });

  child.unref();

  return { id, pid: child.pid, logPath, repo: resolvedRepo };
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

    const resolvedRepo = resolveRepoPath(repo);
    if (activeByRepo.has(resolvedRepo)) {
      const active = activeByRepo.get(resolvedRepo);
      return json(res, {
        ok: false,
        error: "delegation already running for this repo",
        activeId: active?.id,
      }, 409);
    }

    try {
      const result = startDelegation({ repo, prompt, force });
      activeByRepo.set(resolvedRepo, { id: result.id, repo: resolvedRepo, startedAt: new Date().toISOString() });
      return json(res, { ok: true, ...result, prompt }, 202);
    } catch (err) {
      return json(res, { ok: false, error: err?.message || String(err) }, 500);
    }
  }

  if (p === "/logs" && req.method === "GET") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);
    const id = url.searchParams.get("id") || "";
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return json(res, { ok: false, error: "invalid id" }, 400);
    const logPath = path.join(LOG_DIR, `${id}.log`);
    const status = readStatus(id);
    const raw = url.searchParams.get("raw") === "1";

    if (!status && !fs.existsSync(logPath)) {
      return json(res, { ok: false, error: "not found" }, 404);
    }

    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
    if (raw) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(log);
    }

    return json(res, {
      ok: true,
      state: status?.state ?? (log ? "exited" : "running"),
      exitCode: status?.exitCode ?? null,
      log,
    });
  }

  json(res, { ok: false, error: "not found" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Cursor delegate trigger: http://127.0.0.1:${PORT}`);
  console.log(`Logs: ${LOG_DIR}`);
  console.log("This is a standalone smoke-test server — not wired into any agent role yet.");
});
