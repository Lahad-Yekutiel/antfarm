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
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PORT = process.env.COORDINATOR_PORT ? Number(process.env.COORDINATOR_PORT) : 3335;
const TOKEN = process.env.COORDINATOR_TOKEN;
const ANTFARM_ROOT = process.cwd();
const ANTFARM_CLI = process.env.COORDINATOR_ANTFARM_CLI || path.join(ANTFARM_ROOT, "dist", "cli", "cli.js");
const LOG_DIR = path.join(ANTFARM_ROOT, "local-tools", "logs");
// Same location antfarm's getDb() uses (see src/db.ts / resolveOpenClawStateDir).
const ANTFARM_DB =
  process.env.COORDINATOR_ANTFARM_DB ||
  path.join(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"), "antfarm", "antfarm.db");
const WORKFLOWS_DIR = path.join(ANTFARM_ROOT, "workflows");
const QUEUE_PATH =
  process.env.COORDINATOR_QUEUE_PATH ||
  path.join(ANTFARM_ROOT, "local-tools", "coordinator-queue.json");
const DEFAULT_WORKFLOW = "thecoach-dev";

/** Expected ownership by workflow step_id — the delegation-authenticity map. */
const EXPECTED_OWNERSHIP = {
  plan: "Claude Code",
  setup: "Cursor",
  implement: "Cursor",
  verify: "Claude Code",
  test: "Cursor",
  "browser-qa": "Claude Code",
  pr: "Cursor",
  review: "Claude Code",
  merge: "Cursor",
};

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

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

/**
 * Classify a role's live AGENTS.md title into ownership, matching
 * local-tools/config-dashboard.mjs's classifyDelegation().
 * Returns a human label for the coordinator: "Cursor" | "Claude Code".
 */
function classifyAssignedAgent(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("cursor-delegated")) return "Cursor";
  // cursor-assisted = Claude decides (may use Cursor as a tool); claude-only / bare = Claude Code
  return "Claude Code";
}

function readAgentOwnership(workflowId, agentRole) {
  // steps.agent_id is like "thecoach-dev_setup" — role is the suffix after the last "_",
  // but workflow agent dirs use short ids ("setup"). Prefer the short role from step_id's
  // agent column in workflow.yml; fall back to stripping the workflow prefix.
  const candidates = [];
  if (agentRole) candidates.push(agentRole);
  const underscore = agentRole.lastIndexOf("_");
  if (underscore >= 0) candidates.push(agentRole.slice(underscore + 1));
  // Also try stripping "<workflowId>_"
  if (workflowId && agentRole.startsWith(workflowId + "_")) {
    candidates.push(agentRole.slice(workflowId.length + 1));
  }

  for (const role of candidates) {
    const agentsMd = path.join(WORKFLOWS_DIR, workflowId, "agents", role, "AGENTS.md");
    if (!fs.existsSync(agentsMd)) continue;
    try {
      const first = fs.readFileSync(agentsMd, "utf-8").split("\n").find((l) => l.trim().length > 0) ?? "";
      const title = first.replace(/^#\s*/, "").trim();
      return {
        assignedAgent: classifyAssignedAgent(title),
        ownershipTitle: title,
        agentRole: role,
      };
    } catch {
      // fall through
    }
  }
  return {
    assignedAgent: "Claude Code",
    ownershipTitle: null,
    agentRole: agentRole,
  };
}

/**
 * Read-only query of antfarm.db steps for a run. Opens the DB with
 * { readOnly: true } — no writes, no migrate(), no WAL pragma changes.
 */
function queryStepsForRun(runIdParam) {
  if (!fs.existsSync(ANTFARM_DB)) {
    const err = new Error(`antfarm.db not found at ${ANTFARM_DB}`);
    err.code = "DB_MISSING";
    throw err;
  }
  const db = new DatabaseSync(ANTFARM_DB, { readOnly: true });
  try {
    const run = db.prepare("SELECT id, workflow_id, status, run_number FROM runs WHERE id = ?").get(runIdParam);
    if (!run) return { found: false, steps: [] };

    const rows = db
      .prepare(
        `SELECT id, run_id, step_id, agent_id, step_index, status, output,
                type, retry_count, max_retries, created_at, updated_at
         FROM steps
         WHERE run_id = ?
         ORDER BY step_index ASC`,
      )
      .all(runIdParam);

    const workflowId = run.workflow_id;
    const steps = rows.map((row) => {
      const ownership = readAgentOwnership(workflowId, row.agent_id);
      return {
        id: row.id,
        runId: row.run_id,
        stepId: row.step_id,
        stepIndex: row.step_index,
        agentId: row.agent_id,
        agentRole: ownership.agentRole,
        assignedAgent: ownership.assignedAgent,
        ownershipTitle: ownership.ownershipTitle,
        status: row.status,
        type: row.type,
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        // Full output text — not truncated. This is the DB `output` column
        // (completed + failed steps). The `evidence` object on step.failed
        // events is event-only and is NOT a DB column.
        output: row.output ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });

    return {
      found: true,
      run: {
        id: run.id,
        workflowId: run.workflow_id,
        status: run.status,
        runNumber: run.run_number,
      },
      steps,
    };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

// ─── Task queue (service state file — the only write path this feature uses) ───

function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  try {
    const raw = fs.readFileSync(QUEUE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  const dir = path.dirname(QUEUE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${QUEUE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, QUEUE_PATH);
}

function newQueueItemId() {
  return crypto.randomBytes(6).toString("hex");
}

/** Read-only: any thecoach-dev run still in non-terminal status. */
function findActiveThecoachRun() {
  if (!fs.existsSync(ANTFARM_DB)) return null;
  const db = new DatabaseSync(ANTFARM_DB, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT id, status, run_number, created_at
         FROM runs
         WHERE workflow_id = ?
           AND status NOT IN ('completed', 'failed', 'cancelled', 'canceled')
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(DEFAULT_WORKFLOW);
    return row || null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/** Read-only: look up a run's status by id. */
function getRunStatus(runIdParam) {
  if (!fs.existsSync(ANTFARM_DB)) return null;
  const db = new DatabaseSync(ANTFARM_DB, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT id, workflow_id, status, run_number, task, created_at, updated_at FROM runs WHERE id = ?")
        .get(runIdParam) || null
    );
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/**
 * After spawning workflow run (fire-and-forget like /trigger), poll the DB
 * read-only until the real antfarm run UUID appears for this exact task text.
 */
async function waitForAntfarmRunId(taskText, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(ANTFARM_DB)) {
      const db = new DatabaseSync(ANTFARM_DB, { readOnly: true });
      try {
        const row = db
          .prepare(
            `SELECT id, status, run_number FROM runs
             WHERE workflow_id = ? AND task = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(DEFAULT_WORKFLOW, taskText);
        if (row) return row;
      } finally {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

function fetchOriginStagingTip(repoPath) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoPath, "fetch", "origin"], { timeout: 120_000 }, (fetchErr, _o, fetchStderr) => {
      if (fetchErr) {
        return reject(new Error(`git fetch origin failed: ${fetchErr.message}${fetchStderr ? ` — ${fetchStderr}` : ""}`));
      }
      execFile("git", ["-C", repoPath, "rev-parse", "origin/staging"], { timeout: 15_000 }, (rpErr, stdout, rpStderr) => {
        if (rpErr) {
          return reject(new Error(`git rev-parse origin/staging failed: ${rpErr.message}${rpStderr ? ` — ${rpStderr}` : ""}`));
        }
        resolve(stdout.trim());
      });
    });
  });
}

function buildQueuedTaskText({ repoPath, branch, task }) {
  return `REPO: ${repoPath}\nBRANCH: ${branch}\n\n${task}`;
}

function verifyRunOwnership(stepsResult) {
  const mismatches = [];
  const expectedSteps = Object.keys(EXPECTED_OWNERSHIP);
  const byStepId = new Map((stepsResult.steps || []).map((s) => [s.stepId, s]));

  for (const stepId of expectedSteps) {
    const expected = EXPECTED_OWNERSHIP[stepId];
    const step = byStepId.get(stepId);
    if (!step) {
      mismatches.push({ stepId, expected, actual: null, reason: "step missing from run" });
      continue;
    }
    if (step.assignedAgent !== expected) {
      mismatches.push({
        stepId,
        expected,
        actual: step.assignedAgent,
        reason: `assignedAgent is "${step.assignedAgent}", expected "${expected}"`,
      });
    }
  }
  return mismatches;
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

  // Per-step output for a run — read-only SELECT against antfarm.db.
  // /status above only surfaces CLI status text; this returns the full
  // `steps.output` column so a coordinator can verify Cursor-delegated
  // steps actually reported Cursor work (vs Claude Code doing it inline).
  if (p === "/steps" && req.method === "GET") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);
    const runIdParam = (url.searchParams.get("run_id") || "").trim();
    if (!runIdParam) return json(res, { ok: false, error: "'run_id' query param is required" }, 400);
    if (!/^[a-zA-Z0-9_-]+$/.test(runIdParam)) {
      return json(res, { ok: false, error: "invalid run_id" }, 400);
    }
    try {
      const result = queryStepsForRun(runIdParam);
      if (!result.found) {
        return json(res, { ok: false, error: "run not found", run_id: runIdParam, steps: [] }, 404);
      }
      // Primary payload is the steps array; wrap with ok/run metadata.
      return json(res, { ok: true, run: result.run, steps: result.steps });
    } catch (err) {
      const status = err?.code === "DB_MISSING" ? 503 : 500;
      return json(res, { ok: false, error: err?.message || String(err) }, status);
    }
  }

  // ─── Task queue ───────────────────────────────────────────────────────────

  if (p === "/queue" && req.method === "GET") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);
    return json(res, { ok: true, queue: loadQueue() });
  }

  if (p === "/queue" && req.method === "POST") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, { ok: false, error: "invalid JSON body" }, 400);
    const task = typeof body.task === "string" ? body.task.trim() : "";
    const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
    const branchHint = typeof body.branchHint === "string" ? body.branchHint.trim() : "";
    if (!task) return json(res, { ok: false, error: "'task' (string) is required" }, 400);
    if (!repoPath) return json(res, { ok: false, error: "'repoPath' (string) is required" }, 400);

    const item = {
      id: newQueueItemId(),
      task,
      repoPath,
      branchHint: branchHint || null,
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      resolvedAt: null,
      note: null,
    };
    const queue = loadQueue();
    queue.push(item);
    saveQueue(queue);
    return json(res, { ok: true, item }, 201);
  }

  if (p === "/queue/dispatch-next" && req.method === "POST") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);

    const active = findActiveThecoachRun();
    if (active) {
      return json(res, {
        ok: true,
        dispatched: false,
        reason: "run in progress",
        activeRunId: active.id,
        activeStatus: active.status,
        activeRunNumber: active.run_number ?? null,
      });
    }

    const queue = loadQueue();
    const idx = queue.findIndex((it) => it.status === "pending");
    if (idx < 0) {
      return json(res, { ok: true, dispatched: false, reason: "queue empty" });
    }
    const item = queue[idx];

    if (!fs.existsSync(item.repoPath)) {
      return json(res, { ok: false, error: `repoPath does not exist: ${item.repoPath}` }, 400);
    }

    let stagingTip;
    try {
      stagingTip = await fetchOriginStagingTip(item.repoPath);
    } catch (err) {
      return json(res, { ok: false, error: err?.message || String(err) }, 500);
    }

    const branch = `feature/thecoach-dev-coordinator-${item.id}`;
    const taskText = buildQueuedTaskText({
      repoPath: item.repoPath,
      branch,
      task: item.task,
    });

    let spawnResult;
    try {
      spawnResult = startWorkflowRun({ workflow: DEFAULT_WORKFLOW, task: taskText });
    } catch (err) {
      return json(res, { ok: false, error: err?.message || String(err) }, 500);
    }

    const antfarmRun = await waitForAntfarmRunId(taskText);
    if (!antfarmRun) {
      return json(
        res,
        {
          ok: false,
          error: "workflow spawn started but antfarm run id not observed in DB within timeout",
          spawnLogId: spawnResult.id,
          logPath: spawnResult.logPath,
          stagingTip,
          branch,
        },
        504,
      );
    }

    item.status = "dispatched";
    item.runId = antfarmRun.id;
    item.dispatchedAt = new Date().toISOString();
    item.note = `dispatched; staging tip ${stagingTip}; branch ${branch}; antfarm run #${antfarmRun.run_number}`;
    item.branch = branch;
    item.stagingTip = stagingTip;
    saveQueue(queue);

    return json(res, {
      ok: true,
      dispatched: true,
      runId: antfarmRun.id,
      runNumber: antfarmRun.run_number,
      branch,
      stagingTip,
      spawnLogId: spawnResult.id,
      item,
    });
  }

  if (p === "/queue/check" && req.method === "GET") {
    if (!checkAuth(req)) return json(res, { ok: false, error: "unauthorized" }, 401);

    const queue = loadQueue();
    const changed = [];

    for (const item of queue) {
      if (item.status !== "dispatched" || !item.runId) continue;

      const run = getRunStatus(item.runId);
      if (!run) {
        changed.push({
          id: item.id,
          runId: item.runId,
          change: "skipped",
          reason: "run not found in DB",
        });
        continue;
      }
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        changed.push({
          id: item.id,
          runId: item.runId,
          change: "still-running",
          runStatus: run.status,
        });
        continue;
      }

      let stepsResult;
      try {
        stepsResult = queryStepsForRun(item.runId);
      } catch (err) {
        changed.push({
          id: item.id,
          runId: item.runId,
          change: "error",
          reason: err?.message || String(err),
        });
        continue;
      }

      const mismatches = verifyRunOwnership(stepsResult);
      item.resolvedAt = new Date().toISOString();
      if (mismatches.length === 0) {
        item.status = "done";
        item.note = "verified: all steps match expected ownership";
        changed.push({
          id: item.id,
          runId: item.runId,
          change: "done",
          runStatus: run.status,
        });
      } else {
        item.status = "flagged";
        item.note = `ownership mismatch: ${mismatches
          .map((m) => `${m.stepId}: ${m.reason}`)
          .join("; ")}`;
        changed.push({
          id: item.id,
          runId: item.runId,
          change: "flagged",
          runStatus: run.status,
          mismatches,
        });
      }
    }

    saveQueue(queue);
    return json(res, {
      ok: true,
      summary: {
        checked: changed.length,
        done: changed.filter((c) => c.change === "done").length,
        flagged: changed.filter((c) => c.change === "flagged").length,
        stillRunning: changed.filter((c) => c.change === "still-running").length,
      },
      changed,
      queue,
    });
  }

  json(res, { ok: false, error: "not found" }, 404);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Coordinator trigger server: http://127.0.0.1:${PORT}`);
  console.log(`Antfarm root: ${ANTFARM_ROOT}`);
  console.log(`Antfarm CLI: ${ANTFARM_CLI}`);
  console.log(`Antfarm DB (read-only): ${ANTFARM_DB}`);
  console.log(`Queue file: ${QUEUE_PATH}`);
  console.log(`Logs: ${LOG_DIR}`);
});
