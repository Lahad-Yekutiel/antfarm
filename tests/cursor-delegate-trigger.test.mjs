import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveAgentBin,
  logAgentBinPreflightFailure,
} from "../local-tools/cursor-delegate-trigger.mjs";

const triggerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "local-tools",
  "cursor-delegate-trigger.mjs",
);

function request(port, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: data, json: data ? JSON.parse(data) : null });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("resolveAgentBin", () => {
  it("resolves a valid absolute path to an executable binary", () => {
    const result = resolveAgentBin(process.execPath);
    assert.equal(result.ok, true);
    assert.equal(result.resolved, process.execPath);
  });

  it("reports an invalid absolute path", () => {
    const missing = "/nonexistent/agent-binary-for-test";
    const result = resolveAgentBin(missing);
    assert.equal(result.ok, false);
    assert.equal(result.configured, missing);
    assert.equal(result.reason, "path does not exist");
  });

  it("resolves a bare command name from PATH", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = path.dirname(process.execPath);
    try {
      const binName = path.basename(process.execPath);
      const result = resolveAgentBin(binName);
      assert.equal(result.ok, true);
      assert.equal(result.resolved, process.execPath);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("reports an unresolvable bare command name", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = resolveAgentBin("definitely-not-a-real-binary-xyz123");
      assert.equal(result.ok, false);
      assert.equal(result.configured, "definitely-not-a-real-binary-xyz123");
      assert.equal(result.reason, "not found in PATH");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("logs a hard-to-miss preflight failure banner", () => {
    const lines = [];
    const originalError = console.error;
    console.error = (...args) => lines.push(args.join(" "));
    try {
      logAgentBinPreflightFailure({
        ok: false,
        configured: "/missing/agent",
        reason: "path does not exist",
      });
    } finally {
      console.error = originalError;
    }

    const output = lines.join("\n");
    assert.match(output, /^={72}$/m);
    assert.match(output, /ERROR: DELEGATE_AGENT_BIN preflight failed/);
    assert.match(output, /"\/missing\/agent"/);
    assert.match(output, /path does not exist/);
    assert.match(output, /DELEGATE_AGENT_BIN and the service's PATH/);
  });
});

describe("cursor-delegate-trigger", () => {
  let port;
  let logDir;
  let child;
  const token = "test-delegate-token";

  before(async () => {
    port = 34000 + Math.floor(Math.random() * 1000);
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-trigger-test-"));
    child = spawn(process.execPath, [triggerPath], {
      env: {
        ...process.env,
        DELEGATE_TOKEN: token,
        DELEGATE_PORT: String(port),
        DELEGATE_LOG_DIR: logDir,
        DELEGATE_AGENT_BIN: "/nonexistent/agent-binary-for-test",
        DELEGATE_TIMEOUT_MS: "5000",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 30; i++) {
      try {
        const res = await request(port, "GET", "/health", null, token);
        if (res.status === 200) return;
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("delegate trigger server failed to start");
  });

  after(async () => {
    if (child && !child.killed) child.kill("SIGTERM");
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("records spawn_failed in status sidecar for a missing agent binary", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-repo-"));
    const delegate = await request(port, "POST", "/delegate", {
      repo,
      prompt: "echo test",
      force: true,
    }, token);

    assert.equal(delegate.status, 202);
    assert.equal(delegate.json.ok, true);
    const id = delegate.json.id;

    let status = null;
    for (let i = 0; i < 40; i++) {
      status = JSON.parse(fs.readFileSync(path.join(logDir, `${id}.status.json`), "utf-8"));
      if (status.state !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(status.state, "spawn_failed");

    const logs = await request(port, "GET", `/logs?id=${encodeURIComponent(id)}`, null, token);
    assert.equal(logs.status, 200);
    assert.equal(logs.json.state, "spawn_failed");
    assert.ok(typeof logs.json.log === "string");

    fs.rmSync(repo, { recursive: true, force: true });
  });
});
