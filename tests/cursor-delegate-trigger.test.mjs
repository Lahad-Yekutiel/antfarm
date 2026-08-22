import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
