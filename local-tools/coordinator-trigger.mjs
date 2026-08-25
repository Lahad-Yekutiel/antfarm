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
//   COORDINATOR_TOKEN   bearer secret — full access to every endpoint
// Optional env:
//   COORDINATOR_LOOP_TOKEN  weaker bearer for the unattended 2-hourly loop;
//     allowlisted read/dispatch endpoints only (never POST /trigger or POST /queue).
//     Unset/empty means the loop token does not exist (never matches).
//   COORDINATOR_PORT       default 3335
//   COORDINATOR_ANTFARM_CLI   default "<ANTFARM_ROOT>/dist/cli/cli.js" — this
//     repo's `antfarm` isn't installed as a global command (only declared as
//     a `bin` in package.json, never `npm link`ed), so it's invoked as
//     `node dist/cli/cli.js ...` directly, same as config-dashboard.mjs does.
//   COORDINATOR_THECOACH_REPO  Windows TheCoach checkout (WSL path). Used to
//     read _SSoT/ROADMAP.md and local/cursor_loop/developer_todo.json when the
//     queue is empty. Never a default repoPath for dispatched work. Unset or
//     unreadable judgment files throw (do not fail open into an empty-queue
//     response). Agent/parse failures become nothing-dispatchable.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PORT = process.env.COORDINATOR_PORT ? Number(process.env.COORDINATOR_PORT) : 3335;
const TOKEN = process.env.COORDINATOR_TOKEN;
/** Weaker token for scheduled loop — may be undefined or "" (treated as absent). */
const LOOP_TOKEN = process.env.COORDINATOR_LOOP_TOKEN;
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
/** Trial clone dispatched work actually runs against. Not COORDINATOR_THECOACH_REPO. */
const DEFAULT_QUEUE_REPO_PATH = "/home/lahad/trials/thecoach-antfarm-trial";
const ROADMAP_RELATIVE_PATH = path.join("_SSoT", "ROADMAP.md");
const TODO_RELATIVE_PATH = path.join("local", "cursor_loop", "developer_todo.json");
const IDLE_STATE_RELATIVE_PATH = path.join("local", "cursor_loop", "coordinator_idle_state.json");
const ROADMAP_AUTO_SOURCE = "coordinator:roadmap-auto";
const OPEN_QUESTION_CEILING = 10;
const IDLE_ESCALATION_EVERY = 12;
const TODO_STATUS_OPEN = "open";
const TODO_STATUS_RESOLVED = "resolved";
const TODO_STATUS_DECLINED = "declined";
const SCOPE_GLOBAL = "*";
const RECORD_QUESTION_TYPES = new Set(["blocked", "passed-awaiting-dev", "roadmap-decision", "other"]);
/** Windows checkout — judgment inputs only. Loaded from EnvironmentFile, never a unit Environment= line. */
const THECOACH_REPO = (process.env.COORDINATOR_THECOACH_REPO || "").trim();
const PLANNER_AGENT_ID = "thecoach-dev_planner";
const PLANNER_MODEL = "anthropic/claude-sonnet-5";
// Measured live scan latency is 4–7s. Named-tunnel 524 empirically fires at
// ~125.3s (120s request survived; 128s request returned HTTP 524). CLI timeout
// sits well above the 4–7s band; execFile timeout sits a few seconds above the
// CLI so the CLI's own --timeout can fire cleanly. Both stay under the 125s ceiling.
const PLANNER_CLI_TIMEOUT_SEC = 100;
const PLANNER_EXEC_TIMEOUT_MS = 105_000;

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

/** Mechanical PR base gate — only "staging" is allowed (not prompt prose). */
const EXPECTED_PR_BASE = "staging";

/** Real GitHub PR URLs as they appear in step `output` text. */
const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

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

/**
 * Constant-time compare. Unset/empty `expected` NEVER matches — including
 * against a missing/empty presented value. Getting this wrong would open
 * the service when COORDINATOR_LOOP_TOKEN is unset.
 */
function timingSafeTokenEqual(presented, expected) {
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractBearerToken(req) {
  const header = req.headers?.authorization || "";
  const [scheme, value] = header.split(" ");
  if (scheme !== "Bearer" || !value) return null;
  return value;
}

/** @returns {"full"|"loop"|null} */
function identifyAuthRole(req) {
  const value = extractBearerToken(req);
  if (!value) return null;
  if (timingSafeTokenEqual(value, TOKEN)) return "full";
  // LOOP_TOKEN unset/empty → timingSafeTokenEqual is always false (never a match).
  if (timingSafeTokenEqual(value, LOOP_TOKEN)) return "loop";
  return null;
}

/**
 * Explicit allowlist for the loop token. Future endpoints default to
 * forbidden for loop — never add a denylist.
 */
const LOOP_TOKEN_ALLOWLIST = new Set([
  "GET /queue/check",
  "GET /queue",
  "GET /status",
  "GET /steps",
  "POST /queue/dispatch-next",
]);

/**
 * Identify which token was presented, then authorize by endpoint.
 * @returns {{ ok: true, role: "full"|"loop" } | { ok: false, status: number, error: string }}
 */
function authorizeEndpoint(req, method, pathname) {
  const role = identifyAuthRole(req);
  if (!role) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  if (role === "full") {
    return { ok: true, role };
  }
  const key = `${method} ${pathname}`;
  if (LOOP_TOKEN_ALLOWLIST.has(key)) {
    return { ok: true, role };
  }
  return {
    ok: false,
    status: 403,
    error: "forbidden: loop token is not permitted on this endpoint",
  };
}

/** Returns true if the request may proceed; otherwise writes 401/403 JSON and returns false. */
function requireAuth(req, res, method, pathname) {
  const auth = authorizeEndpoint(req, method, pathname);
  if (!auth.ok) {
    json(res, { ok: false, error: auth.error }, auth.status);
    return false;
  }
  return true;
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

function logDispatchNext(message) {
  console.log(`[queue/dispatch-next] ${message}`);
}

function logDispatchNextError(message) {
  console.error(`[queue/dispatch-next] ${message}`);
}

function defaultIdleState() {
  return { consecutive_idle: 0, last_idle_at: null, last_escalated_at: null };
}

function isOpenTodoStatus(status) {
  return (status ?? TODO_STATUS_OPEN) === TODO_STATUS_OPEN;
}

function parseDeveloperTodoEntries(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("developer_todo.json is not a JSON array");
  }
  return parsed;
}

function normaliseBlocks(entry) {
  if (!Array.isArray(entry?.blocks)) {
    logDispatchNext(`schema-violation todo_id=${entry?.id} reason="missing blocks"`);
    return [SCOPE_GLOBAL];
  }
  return entry.blocks;
}

function summarizeOpenTodos(entries) {
  const open = entries.filter((e) => isOpenTodoStatus(e.status));
  const blockedScopes = new Set(open.flatMap((e) => normaliseBlocks(e)));
  return {
    open,
    open_count: open.length,
    todo_ids: open.map((e) => e.id).filter((id) => id != null),
    blockedScopes,
  };
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
}

function writeDeveloperTodoAtomic(thecoachRepo, entries) {
  writeJsonAtomic(path.join(thecoachRepo, TODO_RELATIVE_PATH), entries);
}

function nextTodoId(entries) {
  let max = 0;
  for (const e of entries) {
    const m = String(e.id || "").match(/^TODO-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `TODO-${String(max + 1).padStart(4, "0")}`;
}

function appendDeveloperTodoEntry(thecoachRepo, draft, deps = {}) {
  const readTodo = deps.readTodo || readDeveloperTodoFile;
  const writeTodo = deps.writeTodo || writeDeveloperTodoAtomic;
  const entries = parseDeveloperTodoEntries(readTodo(thecoachRepo));
  const open = entries.filter((e) => isOpenTodoStatus(e.status));
  if (open.some((e) => e.summary === draft.summary)) {
    return { appended: false, reason: "duplicate-summary", entries };
  }
  if (!Array.isArray(draft.blocks)) {
    throw new Error("writer requires an explicit blocks array");
  }
  const entry = {
    id: nextTodoId(entries),
    added_at: new Date().toISOString(),
    source: draft.source,
    type: draft.type,
    summary: draft.summary,
    why: draft.why,
    evidence: draft.evidence,
    reply_needed: draft.reply_needed,
    status: TODO_STATUS_OPEN,
    resolved_at: null,
    resolution: null,
    blocks: draft.blocks,
  };
  const next = [...entries, entry];
  writeTodo(thecoachRepo, next);
  return { appended: true, entry, entries: next };
}

function loadIdleState(thecoachRepo) {
  const filePath = path.join(thecoachRepo, IDLE_STATE_RELATIVE_PATH);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return {
    consecutive_idle: Number(parsed.consecutive_idle) || 0,
    last_idle_at: parsed.last_idle_at ?? null,
    last_escalated_at: parsed.last_escalated_at ?? null,
  };
}

function saveIdleState(thecoachRepo, state) {
  writeJsonAtomic(path.join(thecoachRepo, IDLE_STATE_RELATIVE_PATH), state);
}

function applyIdleTelemetry({ dispatched, reason }, deps = {}) {
  const load = deps.loadIdle || loadIdleState;
  const save = deps.saveIdle || saveIdleState;
  const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
  try {
    if (reason === "active-run" || reason === "developer-attention-required") {
      return { escalated: false };
    }
    if (!deps.loadIdle && !repo) {
      return { escalated: false };
    }
    let state;
    try {
      state = load(repo);
    } catch {
      state = defaultIdleState();
    }
    if (dispatched === true) {
      state = { ...state, consecutive_idle: 0 };
      save(repo, state);
      return { escalated: false, idle_state: state };
    }
    if (reason === "nothing-dispatchable") {
      const now = new Date().toISOString();
      const consecutive_idle = (state.consecutive_idle || 0) + 1;
      state = { ...state, consecutive_idle, last_idle_at: now };
      let escalated = false;
      if (consecutive_idle > 0 && consecutive_idle % IDLE_ESCALATION_EVERY === 0) {
        escalated = true;
        state.last_escalated_at = now;
      }
      save(repo, state);
      return { escalated, idle_state: state };
    }
    return { escalated: false };
  } catch (err) {
    logDispatchNextError(`idle-state telemetry failed (swallowed): ${err?.message || String(err)}`);
    return { escalated: false, telemetry_error: err?.message || String(err) };
  }
}

function evaluateDispatchBackstop(scopes, blockedScopes) {
  const blocked = blockedScopes instanceof Set ? blockedScopes : new Set(blockedScopes || []);
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { ok: false, reason: "missing-or-empty-scopes", scopes: scopes ?? null, blocked: [...blocked] };
  }
  const intersection = scopes.filter((s) => blocked.has(s));
  if (intersection.length > 0) {
    return { ok: false, reason: "intersects-blocked", scopes, blocked: [...blocked], intersection };
  }
  return { ok: true, scopes, blocked: [...blocked] };
}

function attachOpenSnapshot(body, snapshot) {
  if (body.dispatched === true) return body;
  return {
    ...body,
    open_count: snapshot?.open_count ?? body.open_count ?? 0,
    todo_ids: snapshot?.todo_ids ?? body.todo_ids ?? [],
  };
}

function withIdleTelemetry(body, deps) {
  const telem = applyIdleTelemetry(body, deps);
  if (telem.escalated) return { ...body, escalated: true };
  return body;
}

/**
 * Same shape POST /queue builds for a human-submitted item, plus optional
 * source / roadmap_ref for coordinator auto-queue.
 */
function buildQueueItem({ task, repoPath, branchHint = null, source, roadmap_ref }) {
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
  if (source !== undefined) item.source = source;
  if (roadmap_ref !== undefined) item.roadmap_ref = roadmap_ref;
  return item;
}

function enqueueQueueItem(fields) {
  const item = buildQueueItem(fields);
  const queue = loadQueue();
  queue.push(item);
  saveQueue(queue);
  return item;
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

function readTheCoachJudgmentFile(thecoachRepo, relativePath) {
  const filePath = path.join(thecoachRepo, relativePath);
  return fs.readFileSync(filePath, "utf-8");
}

function readRoadmapFile(thecoachRepo) {
  return readTheCoachJudgmentFile(thecoachRepo, ROADMAP_RELATIVE_PATH);
}

function readDeveloperTodoFile(thecoachRepo) {
  return readTheCoachJudgmentFile(thecoachRepo, TODO_RELATIVE_PATH);
}

function formatBlockedScopes(blockedScopes) {
  const list = [...blockedScopes];
  if (list.length === 0) return "(none)";
  return list.join(", ");
}

function buildRoadmapScanPrompt(roadmapContent, todoContent, blockedScopes) {
  const exclusion = formatBlockedScopes(blockedScopes);
  return `You are deciding whether the coordinator should queue the next piece of TheCoach work.

You are given two read-only inputs from the Windows TheCoach checkout working tree (not a git ref — ROADMAP.md is a manual hand-merge):
1) _SSoT/ROADMAP.md
2) local/cursor_loop/developer_todo.json (open developer decisions / blockers)

HARD EXCLUSION LIST — you MUST NOT dispatch any item whose scopes intersect this set: ${exclusion}

Scope grammar (for both dispatch "scopes" and record-question "blocks"):
- phase:<id>   e.g. phase:4B, phase:9
- oq:<id>      e.g. oq:OQ-12
- task:<slug>  e.g. task:ci-workflow
- *            blocks everything (use only when the question truly gates all work)
- []           (record-question only) the question needs an answer but gates no dispatchable work

Reply with ONLY one JSON object, nothing else — no prose before or after, no markdown fences, no trailing commentary. Exactly one of these three shapes:

{"decision":"dispatch","title":"<short task title>","description":"<what to build, specific enough for a dev agent to act on without more context>","roadmap_ref":"<which phase/line this came from, quoted or closely paraphrased>","scopes":["phase:<id>"]}

{"decision":"record-question","summary":"<one line>","why":"<why this needs a human>","source":"<TASK-NNN or roadmap:PhaseX>","type":"roadmap-decision","evidence":"<short evidence>","reply_needed":"<what answer resolves this>","blocks":["phase:<id>"]}

{"decision":"nothing-to-do"}

Rules:
- "dispatch" is only correct for work that is well-defined AND already decided — no open product/design choice, no explicit "deferred"/"blocked on"/"needs sign-off" language in the roadmap text itself.
- Every dispatch MUST include a non-empty "scopes" array naming what the work belongs to (phase, oq, and/or task). Never dispatch work whose scopes intersect the exclusion list.
- You MAY skip a blocked/deferred roadmap checkbox and continue looking for the next phase's actionable work whose scopes are outside the exclusion list. If the next well-defined item is blocked by the exclusion list, skip it and keep looking.
- Do not return needs-developer-decision — that decision is retired. If you find a question that needs a developer answer, return record-question with an explicitly-reasoned "blocks" array: what specifically does this gate — which phase, which open question, which task? If it gates no dispatchable work, answer with an empty list.
- When genuinely uncertain whether something is ready to dispatch, choose record-question or nothing-to-do, never a speculative dispatch. A missed dispatch costs one idle cycle; a wrong dispatch costs a whole run plus review time.
- Dispatch only the first thing you find that is genuinely ready and unblocked. Do not queue multiple items in one scan.

--- ROADMAP.md (_SSoT/ROADMAP.md working tree) ---
${roadmapContent}

--- developer_todo.json ---
${todoContent}
`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Strict parse of the agent's final text reply. Rejects extra keys, missing
 * fields, non-objects, and anything that isn't exactly one of the three shapes.
 * needs-developer-decision is retired and parsed as unknown.
 */
function parseAgentDecision(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text).trim());
  } catch (err) {
    return { ok: false, error: `agent reply is not JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "agent reply is not a JSON object" };
  }
  const keys = Object.keys(parsed).sort();
  const decision = parsed.decision;
  if (decision === "dispatch") {
    const keyStr = keys.join(",");
    if (keyStr !== "decision,description,roadmap_ref,title" && keyStr !== "decision,description,roadmap_ref,scopes,title") {
      return { ok: false, error: `dispatch object has unexpected keys: ${keyStr}` };
    }
    if (!isNonEmptyString(parsed.title) || !isNonEmptyString(parsed.description) || !isNonEmptyString(parsed.roadmap_ref)) {
      return { ok: false, error: "dispatch is missing a required non-empty string field" };
    }
    return { ok: true, decision: parsed };
  }
  if (decision === "record-question") {
    if (keys.join(",") !== "blocks,decision,evidence,reply_needed,source,summary,type,why") {
      return { ok: false, error: `record-question object has unexpected keys: ${keys.join(",")}` };
    }
    if (
      !isNonEmptyString(parsed.summary) ||
      !isNonEmptyString(parsed.why) ||
      !isNonEmptyString(parsed.source) ||
      !isNonEmptyString(parsed.type) ||
      !isNonEmptyString(parsed.evidence) ||
      !isNonEmptyString(parsed.reply_needed)
    ) {
      return { ok: false, error: "record-question is missing a required non-empty string field" };
    }
    if (!RECORD_QUESTION_TYPES.has(parsed.type)) {
      return { ok: false, error: `record-question type is not allowed: ${parsed.type}` };
    }
    if (!Array.isArray(parsed.blocks)) {
      return { ok: false, error: "record-question blocks must be an array" };
    }
    return { ok: true, decision: parsed };
  }
  if (decision === "nothing-to-do") {
    if (keys.join(",") !== "decision") {
      return { ok: false, error: `nothing-to-do object has unexpected keys: ${keys.join(",")}` };
    }
    return { ok: true, decision: parsed };
  }
  return { ok: false, error: `unknown decision: ${JSON.stringify(decision)}` };
}

/**
 * Pull the agent's final text out of `openclaw agent --json` stdout.
 * Gateway-backed shape uses payloads[].text; exec-style uses `final`.
 */
function extractAgentReplyText(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) throw new Error("openclaw agent produced empty stdout");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`openclaw agent stdout is not JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("openclaw agent JSON is not an object");
  }
  if (parsed.ok === false || parsed.status === "error" || parsed.status === "timeout") {
    const msg = parsed.error?.message || parsed.status || "not ok";
    throw new Error(`openclaw agent status is ${msg}`);
  }
  if (typeof parsed.final === "string" && parsed.final.trim()) return parsed.final.trim();
  if (Array.isArray(parsed.payloads)) {
    const text = parsed.payloads
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  if (parsed.result && typeof parsed.result === "object") {
    const nested = parsed.result;
    if (typeof nested.final === "string" && nested.final.trim()) return nested.final.trim();
    if (Array.isArray(nested.payloads)) {
      const text = nested.payloads
        .map((p) => (p && typeof p.text === "string" ? p.text : ""))
        .join("")
        .trim();
      if (text) return text;
    }
  }
  throw new Error("openclaw agent JSON has no agent text reply");
}

function runPlannerAgentTurn(prompt) {
  const tmpFile = path.join(
    os.tmpdir(),
    `coordinator-roadmap-scan-${process.pid}-${crypto.randomBytes(4).toString("hex")}.txt`,
  );
  const sessionKey = `roadmap-scan-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmpFile, prompt, "utf-8");
  return new Promise((resolve, reject) => {
    execFile(
      "openclaw",
      [
        "agent",
        "--agent",
        PLANNER_AGENT_ID,
        "--session-key",
        sessionKey,
        "--model",
        PLANNER_MODEL,
        "--message-file",
        tmpFile,
        "--timeout",
        String(PLANNER_CLI_TIMEOUT_SEC),
        "--json",
      ],
      { timeout: PLANNER_EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // ignore cleanup failure
        }
        if (err) {
          const detail = stderr ? ` — ${String(stderr).trim()}` : "";
          return reject(new Error(`openclaw agent failed: ${err.message}${detail}`));
        }
        resolve(stdout);
      },
    );
  }).catch((err) => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // already cleaned up, or never created
    }
    throw err;
  });
}

/**
 * Empty-queue scan. File-read failures throw (do not fail open). Agent/parse
 * failures become nothing-dispatchable. Dispatched work still uses
 * DEFAULT_QUEUE_REPO_PATH. ROADMAP.md and developer_todo.json are both read
 * from COORDINATOR_THECOACH_REPO (working tree).
 */
async function scanRoadmapForWork(deps = {}) {
  const readRoadmap = deps.readRoadmap || readRoadmapFile;
  const readTodo = deps.readTodo || readDeveloperTodoFile;
  const runAgent = deps.runAgent || runPlannerAgentTurn;
  const appendTodo = deps.appendTodo || ((repo, draft) => appendDeveloperTodoEntry(repo, draft, deps));
  const thecoachRepo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;

  if (!thecoachRepo) {
    throw new Error("COORDINATOR_THECOACH_REPO is unset");
  }

  const todoRaw = readTodo(thecoachRepo);
  const entries = parseDeveloperTodoEntries(todoRaw);
  const snapshot = summarizeOpenTodos(entries);
  const snapshotFields = {
    open_count: snapshot.open_count,
    todo_ids: snapshot.todo_ids,
    blockedScopes: [...snapshot.blockedScopes],
  };

  if (snapshot.open_count >= OPEN_QUESTION_CEILING) {
    return { outcome: "developer-attention-required", ...snapshotFields };
  }

  if (snapshot.blockedScopes.has(SCOPE_GLOBAL)) {
    const offending = snapshot.open.filter((e) => normaliseBlocks(e).includes(SCOPE_GLOBAL)).map((e) => e.id);
    return { outcome: "nothing-dispatchable", ...snapshotFields, offending_ids: offending };
  }

  const roadmap = readRoadmap(thecoachRepo);

  let parsed;
  try {
    const prompt = buildRoadmapScanPrompt(roadmap, todoRaw, snapshot.blockedScopes);
    const cliStdout = await runAgent(prompt);
    const replyText = extractAgentReplyText(cliStdout);
    parsed = parseAgentDecision(replyText);
    if (!parsed.ok) {
      return { outcome: "nothing-dispatchable", ...snapshotFields, failReason: parsed.error };
    }
  } catch (err) {
    return { outcome: "nothing-dispatchable", ...snapshotFields, failReason: err?.message || String(err) };
  }

  if (parsed.decision.decision === "dispatch") {
    const backstop = evaluateDispatchBackstop(parsed.decision.scopes, snapshot.blockedScopes);
    if (!backstop.ok) {
      logDispatchNext(
        `backstop-rejected-dispatch scopes=${JSON.stringify(parsed.decision.scopes)} blocked=${JSON.stringify([...snapshot.blockedScopes])}`,
      );
      return { outcome: "nothing-dispatchable", ...snapshotFields, backstop_rejected: true };
    }
    return { outcome: "dispatch", decision: parsed.decision, ...snapshotFields };
  }

  if (parsed.decision.decision === "record-question") {
    try {
      const written = appendTodo(thecoachRepo, parsed.decision);
      if (!written.appended) {
        logDispatchNext(`todo writer skipped duplicate summary=${JSON.stringify(parsed.decision.summary)}`);
      }
    } catch (err) {
      logDispatchNextError(`todo writer failed: ${err?.message || String(err)}`);
    }
    return { outcome: "nothing-dispatchable", ...snapshotFields };
  }

  return { outcome: "nothing-dispatchable", ...snapshotFields };
}

function snapshotTodosBestEffort(deps = {}) {
  const readTodo = deps.readTodo || readDeveloperTodoFile;
  const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
  try {
    if (!repo) return { open_count: 0, todo_ids: [], blockedScopes: new Set() };
    return summarizeOpenTodos(parseDeveloperTodoEntries(readTodo(repo)));
  } catch (err) {
    logDispatchNextError(`todo snapshot failed (swallowed): ${err?.message || String(err)}`);
    return { open_count: 0, todo_ids: [], blockedScopes: new Set() };
  }
}

function buildQueuedTaskText({ repoPath, branch, task }) {
  return `REPO: ${repoPath}\nBRANCH: ${branch}\n\n${task}`;
}

/**
 * Core of POST /queue/dispatch-next. Injectors exist so --self-test-roadmap-scan
 * can cover empty-queue scan outcomes without spawning a real workflow.
 */
async function handleDispatchNext(deps = {}) {
  const findActive = deps.findActive || findActiveThecoachRun;
  const load = deps.load || loadQueue;
  const save = deps.save || saveQueue;
  const scan = deps.scan || scanRoadmapForWork;
  const repoExists = deps.repoExists || ((p) => fs.existsSync(p));
  const fetchStaging = deps.fetchStaging || fetchOriginStagingTip;
  const startRun = deps.startRun || startWorkflowRun;
  const waitRun = deps.waitRun || waitForAntfarmRunId;

  const active = findActive();
  if (active) {
    const snapshot = snapshotTodosBestEffort(deps);
    return {
      status: 200,
      body: attachOpenSnapshot(
        {
          ok: true,
          dispatched: false,
          reason: "active-run",
          activeRunId: active.id,
          activeStatus: active.status,
          activeRunNumber: active.run_number ?? null,
        },
        snapshot,
      ),
    };
  }

  let queue = load();
  let idx = queue.findIndex((it) => it.status === "pending");
  if (idx < 0) {
    let scanResult;
    try {
      scanResult = await scan();
    } catch (err) {
      logDispatchNextError(`roadmap scan failed: ${err?.message || String(err)}`);
      return { status: 500, body: { ok: false, error: err?.message || String(err) } };
    }

    const snapshot = {
      open_count: scanResult.open_count ?? 0,
      todo_ids: scanResult.todo_ids ?? [],
    };

    if (scanResult.outcome === "dispatch") {
      const backstop = evaluateDispatchBackstop(scanResult.decision.scopes, scanResult.blockedScopes);
      if (!backstop.ok) {
        logDispatchNext(
          `backstop-rejected-dispatch scopes=${JSON.stringify(scanResult.decision.scopes)} blocked=${JSON.stringify(scanResult.blockedScopes ?? [])}`,
        );
        const body = withIdleTelemetry(
          attachOpenSnapshot(
            {
              ok: true,
              dispatched: false,
              reason: "nothing-dispatchable",
              backstop_rejected: true,
            },
            snapshot,
          ),
          deps,
        );
        return { status: 200, body };
      }
      const d = scanResult.decision;
      const autoItem = buildQueueItem({
        task: `${d.title}\n\n${d.description}`,
        repoPath: DEFAULT_QUEUE_REPO_PATH,
        source: ROADMAP_AUTO_SOURCE,
        roadmap_ref: d.roadmap_ref,
      });
      queue.push(autoItem);
      save(queue);
      idx = queue.length - 1;
      logDispatchNext(`roadmap auto-queued ${autoItem.id} ref=${d.roadmap_ref}`);
    } else if (scanResult.outcome === "developer-attention-required") {
      return {
        status: 200,
        body: attachOpenSnapshot(
          {
            ok: true,
            dispatched: false,
            reason: "developer-attention-required",
          },
          snapshot,
        ),
      };
    } else {
      if (scanResult.failReason) {
        logDispatchNextError(`roadmap scan agent/parse failed; nothing-dispatchable: ${scanResult.failReason}`);
      }
      const body = withIdleTelemetry(
        attachOpenSnapshot(
          {
            ok: true,
            dispatched: false,
            reason: "nothing-dispatchable",
            ...(scanResult.backstop_rejected ? { backstop_rejected: true } : {}),
          },
          snapshot,
        ),
        deps,
      );
      return { status: 200, body };
    }
  }

  const item = queue[idx];

  if (!repoExists(item.repoPath)) {
    return { status: 400, body: { ok: false, error: `repoPath does not exist: ${item.repoPath}` } };
  }

  let stagingTip;
  try {
    stagingTip = await fetchStaging(item.repoPath);
  } catch (err) {
    return { status: 500, body: { ok: false, error: err?.message || String(err) } };
  }

  const branch = `feature/thecoach-dev-coordinator-${item.id}`;
  const taskText = buildQueuedTaskText({
    repoPath: item.repoPath,
    branch,
    task: item.task,
  });

  let spawnResult;
  try {
    spawnResult = startRun({ workflow: DEFAULT_WORKFLOW, task: taskText });
  } catch (err) {
    return { status: 500, body: { ok: false, error: err?.message || String(err) } };
  }

  const antfarmRun = await waitRun(taskText);
  if (!antfarmRun) {
    return {
      status: 504,
      body: {
        ok: false,
        error: "workflow spawn started but antfarm run id not observed in DB within timeout",
        spawnLogId: spawnResult.id,
        logPath: spawnResult.logPath,
        stagingTip,
        branch,
      },
    };
  }

  item.status = "dispatched";
  item.runId = antfarmRun.id;
  item.dispatchedAt = new Date().toISOString();
  item.note = `dispatched; staging tip ${stagingTip}; branch ${branch}; antfarm run #${antfarmRun.run_number}`;
  item.branch = branch;
  item.stagingTip = stagingTip;
  save(queue);

  const body = withIdleTelemetry(
    {
      ok: true,
      dispatched: true,
      runId: antfarmRun.id,
      runNumber: antfarmRun.run_number,
      branch,
      stagingTip,
      spawnLogId: spawnResult.id,
      item,
    },
    deps,
  );
  return { status: 200, body };
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

/** Collect unique GitHub PR URLs from a single text blob (typically pr-step output). */
function extractPrUrlsFromText(text) {
  const found = [];
  const seen = new Set();
  const raw = typeof text === "string" ? text : "";
  if (!raw) return found;
  PR_URL_RE.lastIndex = 0;
  let m;
  while ((m = PR_URL_RE.exec(raw)) !== null) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    found.push(url);
  }
  return found;
}

function getPrStep(stepsResult) {
  return (stepsResult.steps || []).find((s) => s.stepId === "pr") || null;
}

function truncateForNote(text, maxLen = 400) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return "(empty)";
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen)}…`;
}

/** Reject anything that is not a canonical https GitHub pull URL before execFile. */
function isSafeGhPrViewArg(value) {
  return (
    typeof value === "string" &&
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(value)
  );
}

/**
 * Pure mechanical gate: baseRefName must be exactly EXPECTED_PR_BASE.
 * Used by /queue/check and by --self-test-pr-base-gate (no network).
 */
function evaluatePrBaseRef(baseRefName) {
  if (baseRefName === EXPECTED_PR_BASE) {
    return { ok: true, baseRefName };
  }
  return {
    ok: false,
    baseRefName,
    reason: `PR base is "${baseRefName}", expected "${EXPECTED_PR_BASE}"`,
  };
}

function fetchPrBaseRefName(prUrl) {
  return new Promise((resolve, reject) => {
    if (!isSafeGhPrViewArg(prUrl)) {
      return reject(new Error("PR URL failed validation"));
    }
    execFile(
      "gh",
      ["pr", "view", prUrl, "--json", "baseRefName"],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(
            new Error(`${err.message}${stderr ? ` — ${String(stderr).trim()}` : ""}`),
          );
        }
        try {
          const parsed = JSON.parse(stdout);
          const baseRefName = typeof parsed.baseRefName === "string" ? parsed.baseRefName : null;
          if (!baseRefName) {
            return reject(new Error("gh pr view returned no baseRefName"));
          }
          resolve(baseRefName);
        } catch (parseErr) {
          reject(new Error(`gh pr view JSON parse failed: ${parseErr.message}`));
        }
      },
    );
  });
}

/**
 * PR base gate using the workflow's named `pr` step as discriminator.
 * - pr step not successfully done → no PR expected (not a failure).
 * - pr step done but no URL in its output → PARSE FAILURE → flag.
 * - URL found → gh base must be staging; gh errors → flag (never done).
 * `done` only when checked-and-correct, or positively no-PR-expected.
 *
 * Step-level status vocabulary is done/failed/pending/running/waiting
 * (not run-level "completed").
 *
 * @param {object} stepsResult
 * @param {{ resolveBaseRef?: (url: string) => Promise<string> }} [opts]
 *   Optional injector for self-tests (avoids calling gh).
 */
async function verifyPrBaseBranch(stepsResult, opts = {}) {
  const resolveBaseRef = opts.resolveBaseRef || fetchPrBaseRefName;
  const prStep = getPrStep(stepsResult);
  const prSucceeded = Boolean(prStep && prStep.status === "done");

  if (!prSucceeded) {
    const why = !prStep
      ? "pr step absent from run"
      : `pr step status is "${prStep.status}" (not done) — no PR expected`;
    return {
      noPr: true,
      noPrReason: why,
      mismatches: [],
      bases: [],
    };
  }

  const urls = extractPrUrlsFromText(prStep.output);
  if (urls.length === 0) {
    return {
      noPr: false,
      noPrReason: null,
      mismatches: [
        {
          reason: `unparseable PR URL: pr step done but no GitHub PR URL matched in its output; output snippet: ${truncateForNote(prStep.output)}`,
        },
      ],
      bases: [],
    };
  }

  const mismatches = [];
  const bases = [];
  for (const url of urls) {
    if (!isSafeGhPrViewArg(url)) {
      mismatches.push({ pr: url, reason: "PR URL failed validation" });
      continue;
    }
    try {
      const baseRefName = await resolveBaseRef(url);
      bases.push({ pr: url, baseRefName });
      const ev = evaluatePrBaseRef(baseRefName);
      if (!ev.ok) {
        mismatches.push({ pr: url, baseRefName, reason: ev.reason });
      }
    } catch (err) {
      // gh / network / parse errors MUST flag — never resolve to done.
      mismatches.push({
        pr: url,
        reason: `could not determine PR base: ${err?.message || String(err)}`,
      });
    }
  }
  return { noPr: false, noPrReason: null, mismatches, bases };
}

/**
 * Shared resolution used by /queue/check and --self-test-pr-base-gate.
 * `done` only when ownership ok AND (base verified staging OR positively no PR expected).
 */
function resolveQueueVerification(ownershipMismatches, baseCheck) {
  const noteParts = [];
  if (ownershipMismatches.length > 0) {
    noteParts.push(
      `ownership mismatch: ${ownershipMismatches
        .map((m) => `${m.stepId}: ${m.reason}`)
        .join("; ")}`,
    );
  }
  if (baseCheck.mismatches.length > 0) {
    noteParts.push(`PR base gate: ${baseCheck.mismatches.map((m) => m.reason).join("; ")}`);
  }

  if (noteParts.length === 0) {
    const note = baseCheck.noPr
      ? `verified: all steps match expected ownership; ${baseCheck.noPrReason}`
      : "verified: all steps match expected ownership";
    return {
      status: "done",
      note,
      prBases: baseCheck.bases,
      noPr: baseCheck.noPr,
      noPrReason: baseCheck.noPrReason || null,
      mismatches: ownershipMismatches,
      prBaseMismatches: baseCheck.mismatches,
    };
  }
  return {
    status: "flagged",
    note: noteParts.join("; "),
    prBases: baseCheck.bases,
    noPr: baseCheck.noPr,
    noPrReason: baseCheck.noPrReason || null,
    mismatches: ownershipMismatches,
    prBaseMismatches: baseCheck.mismatches,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;

  // Unauthenticated health check — used to confirm the tunnel is reachable.
  if (p === "/health" && req.method === "GET") {
    return json(res, { ok: true, service: "coordinator-trigger", time: new Date().toISOString() });
  }

  if (p === "/trigger" && req.method === "POST") {
    if (!requireAuth(req, res, "POST", "/trigger")) return;
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
    if (!requireAuth(req, res, "GET", "/logs")) return;
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
    if (!requireAuth(req, res, "GET", "/status")) return;
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
    if (!requireAuth(req, res, "GET", "/steps")) return;
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
    if (!requireAuth(req, res, "GET", "/queue")) return;
    return json(res, { ok: true, queue: loadQueue() });
  }

  if (p === "/queue" && req.method === "POST") {
    if (!requireAuth(req, res, "POST", "/queue")) return;
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, { ok: false, error: "invalid JSON body" }, 400);
    const task = typeof body.task === "string" ? body.task.trim() : "";
    const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
    const branchHint = typeof body.branchHint === "string" ? body.branchHint.trim() : "";
    if (!task) return json(res, { ok: false, error: "'task' (string) is required" }, 400);
    if (!repoPath) return json(res, { ok: false, error: "'repoPath' (string) is required" }, 400);

    const item = enqueueQueueItem({ task, repoPath, branchHint });
    return json(res, { ok: true, item }, 201);
  }

  if (p === "/queue/dispatch-next" && req.method === "POST") {
    if (!requireAuth(req, res, "POST", "/queue/dispatch-next")) return;
    try {
      const result = await handleDispatchNext();
      return json(res, result.body, result.status);
    } catch (err) {
      logDispatchNextError(`unhandled: ${err?.message || String(err)}`);
      return json(res, { ok: false, error: err?.message || String(err) }, 500);
    }
  }

  if (p === "/queue/check" && req.method === "GET") {
    if (!requireAuth(req, res, "GET", "/queue/check")) return;

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

      const ownershipMismatches = verifyRunOwnership(stepsResult);
      const baseCheck = await verifyPrBaseBranch(stepsResult);
      item.resolvedAt = new Date().toISOString();

      const outcome = resolveQueueVerification(ownershipMismatches, baseCheck);
      item.status = outcome.status;
      item.note = outcome.note;
      changed.push({
        id: item.id,
        runId: item.runId,
        change: outcome.status,
        runStatus: run.status,
        prBases: outcome.prBases,
        noPr: outcome.noPr,
        noPrReason: outcome.noPrReason,
        mismatches: outcome.mismatches,
        prBaseMismatches: outcome.prBaseMismatches,
      });
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

// Mechanical self-check of evaluatePrBaseRef + PR-step discriminator gate.
// Does not bind the port or touch the queue file. Invoke:
//   COORDINATOR_TOKEN=x node local-tools/coordinator-trigger.mjs --self-test-pr-base-gate
if (process.argv.includes("--self-test-pr-base-gate")) {
  const evaluateCases = ["staging", "main", "master", "develop"].map((input) => ({
    input,
    result: evaluatePrBaseRef(input),
  }));

  // Fabricated stepsResult fixtures — ownership map satisfied via stub titles skipped;
  // we only exercise verifyPrBaseBranch + resolveQueueVerification here.
  const ownershipOk = [];

  async function caseOutcome(label, steps, resolveBaseRef) {
    const baseCheck = await verifyPrBaseBranch({ steps }, { resolveBaseRef });
    const outcome = resolveQueueVerification(ownershipOk, baseCheck);
    return {
      case: label,
      status: outcome.status,
      note: outcome.note,
      noPr: outcome.noPr,
      noPrReason: outcome.noPrReason,
      prBaseMismatches: outcome.prBaseMismatches,
    };
  }

  const sampleUrl = "https://github.com/example/repo/pull/42";

  const gateCases = await Promise.all([
    caseOutcome("pr-step-absent", [
      { stepId: "implement", status: "done", output: "done" },
    ]),
    caseOutcome("pr-step-succeeded-but-unparseable", [
      {
        stepId: "pr",
        status: "done",
        output: "Opened a pull request but forgot the URL — see PR #42 against main.",
      },
    ]),
    caseOutcome(
      "parsed-base-staging",
      [
        {
          stepId: "pr",
          status: "done",
          output: `PR ready: ${sampleUrl}`,
        },
      ],
      async () => "staging",
    ),
    caseOutcome(
      "parsed-base-main",
      [
        {
          stepId: "pr",
          status: "done",
          output: `PR ready: ${sampleUrl}`,
        },
      ],
      async () => "main",
    ),
  ]);

  console.log(JSON.stringify({ evaluatePrBaseRef: evaluateCases, gateCases }, null, 2));
  process.exit(0);
}

// Authorization matrix — calls the REAL authorizeEndpoint / timingSafeTokenEqual.
// Does not bind the port or touch the queue. Invoke with known test secrets:
//   COORDINATOR_TOKEN=full-test COORDINATOR_LOOP_TOKEN=loop-test \
//     node local-tools/coordinator-trigger.mjs --self-test-auth-matrix
// And again without COORDINATOR_LOOP_TOKEN to prove unset loop never opens the door.
if (process.argv.includes("--self-test-auth-matrix")) {
  const endpoints = [
    ["POST", "/trigger"],
    ["POST", "/queue"],
    ["GET", "/queue/check"],
    ["POST", "/queue/dispatch-next"],
    ["GET", "/no-such-endpoint"],
  ];
  const loopConfigured = typeof LOOP_TOKEN === "string" && LOOP_TOKEN.length > 0;
  const tokenCases = [
    { label: "full", value: TOKEN },
    { label: "loop", value: loopConfigured ? LOOP_TOKEN : null },
    { label: "wrong", value: "definitely-wrong-token-value" },
    { label: "absent", value: null },
  ];

  function fakeReq(tokenValue) {
    if (tokenValue == null) return { headers: {} };
    return { headers: { authorization: `Bearer ${tokenValue}` } };
  }

  function statusOf(auth) {
    return auth.ok ? 200 : auth.status;
  }

  const matrix = [];
  for (const tok of tokenCases) {
    for (const [method, pathname] of endpoints) {
      const auth = authorizeEndpoint(fakeReq(tok.value), method, pathname);
      matrix.push({
        token: tok.label,
        loopTokenPresented: tok.label === "loop" ? (loopConfigured ? "yes" : "n/a-unset") : undefined,
        method,
        path: pathname,
        status: statusOf(auth),
        error: auth.ok ? null : auth.error,
      });
    }
  }

  const unsetSafety = {
    loopTokenConfigured: loopConfigured,
    loopTokenEnvType: LOOP_TOKEN === undefined ? "undefined" : typeof LOOP_TOKEN,
    loopTokenEnvLength: typeof LOOP_TOKEN === "string" ? LOOP_TOKEN.length : null,
    // Critical: empty/empty must never match
    timingSafeEmptyVsEmpty: timingSafeTokenEqual("", ""),
    timingSafeEmptyVsUndefined: timingSafeTokenEqual("", undefined),
    timingSafeEmptyVsLoopToken: timingSafeTokenEqual("", LOOP_TOKEN),
    absentHeaderOnQueueCheck: (() => {
      const auth = authorizeEndpoint({ headers: {} }, "GET", "/queue/check");
      return { status: statusOf(auth), error: auth.error };
    })(),
    emptyBearerOnQueueCheck: (() => {
      const auth = authorizeEndpoint({ headers: { authorization: "Bearer " } }, "GET", "/queue/check");
      return { status: statusOf(auth), error: auth.error };
    })(),
    malformedHeaderOnTrigger: (() => {
      const auth = authorizeEndpoint({ headers: { authorization: "Basic nope" } }, "POST", "/trigger");
      return { status: statusOf(auth), error: auth.error };
    })(),
  };

  console.log(JSON.stringify({ matrix, unsetSafety }, null, 2));
  process.exit(0);
}

// Roadmap empty-queue scan — fixtures + injected handleDispatchNext.
// Does not bind the port, does not spawn workflows, does not touch the live
// queue file. Invoke:
//   COORDINATOR_TOKEN=x node local-tools/coordinator-trigger.mjs --self-test-roadmap-scan
if (process.argv.includes("--self-test-roadmap-scan")) {
  const failures = [];

  function check(label, cond, detail) {
    if (!cond) failures.push({ label, detail });
    return { case: label, ok: Boolean(cond), detail: cond ? null : detail };
  }

  function memoryQueue(initial = []) {
    let q = initial;
    return {
      load: () => q,
      save: (next) => {
        q = next;
      },
      get: () => q,
    };
  }

  function memoryIdle(initial = defaultIdleState()) {
    let s = { ...initial };
    return {
      loadIdle: () => ({ ...s }),
      saveIdle: (_repo, next) => {
        s = { ...next };
      },
      get: () => s,
    };
  }

  const capturedLogs = [];
  const origLog = console.log;
  console.log = (...args) => {
    capturedLogs.push(args.map(String).join(" "));
    origLog(...args);
  };

  const dispatchReply = {
    decision: "dispatch",
    title: "Add reliability note",
    description: "Write the Phase 4 reliability paragraph into README.md",
    roadmap_ref: "Phase 4 / reliability patch acceptance",
    scopes: ["phase:9"],
  };
  const dispatchReplyNoScopes = {
    decision: "dispatch",
    title: "Add reliability note",
    description: "Write the Phase 4 reliability paragraph into README.md",
    roadmap_ref: "Phase 4 / reliability patch acceptance",
  };
  const recordQuestionReply = {
    decision: "record-question",
    summary: "Need a yes/no on adding CI",
    why: "Spends Actions minutes",
    source: "roadmap:Phase9",
    type: "roadmap-decision",
    evidence: "no .github/workflows",
    reply_needed: "yes or no",
    blocks: ["task:ci-workflow"],
  };
  const needsReply = {
    decision: "needs-developer-decision",
    todo_id: "todo-42",
    summary: "Blocked on Lahad: product copy for the empty-state CTA",
  };

  const parseCases = [
    check("parse-dispatch", parseAgentDecision(JSON.stringify(dispatchReply)).ok === true),
    check("parse-dispatch-without-scopes", parseAgentDecision(JSON.stringify(dispatchReplyNoScopes)).ok === true),
    check("parse-record-question", parseAgentDecision(JSON.stringify(recordQuestionReply)).ok === true),
    check("parse-nothing-to-do", parseAgentDecision('{"decision":"nothing-to-do"}').ok === true),
    check("reject-needs-developer-decision", parseAgentDecision(JSON.stringify(needsReply)).ok === false),
    check("reject-todo-id-null", parseAgentDecision('{"decision":"needs-developer-decision","todo_id":null,"summary":"Blocked on whom: unknown"}').ok === false),
    check("reject-extra-prose", parseAgentDecision(`Sure.\n${JSON.stringify(dispatchReply)}`).ok === false),
    check("reject-markdown-fence", parseAgentDecision("```json\n{\"decision\":\"nothing-to-do\"}\n```").ok === false),
    check("reject-unknown-decision", parseAgentDecision('{"decision":"maybe"}').ok === false),
    check("reject-dispatch-missing-title", parseAgentDecision(JSON.stringify({ decision: "dispatch", description: "x", roadmap_ref: "y" })).ok === false),
    check("reject-dispatch-extra-key", parseAgentDecision(JSON.stringify({ ...dispatchReply, extra: true })).ok === false),
    check("reject-empty-string-field", parseAgentDecision(JSON.stringify({ ...dispatchReply, title: "  " })).ok === false),
  ];

  const extractCases = [
    check(
      "extract-payloads-text",
      extractAgentReplyText(JSON.stringify({ payloads: [{ text: JSON.stringify(dispatchReply) }] })) ===
        JSON.stringify(dispatchReply),
    ),
    check(
      "extract-final",
      extractAgentReplyText(JSON.stringify({ ok: true, status: "ok", final: '{"decision":"nothing-to-do"}' })) ===
        '{"decision":"nothing-to-do"}',
    ),
    check("extract-empty-throws", (() => {
      try {
        extractAgentReplyText("");
        return false;
      } catch {
        return true;
      }
    })()),
    check("extract-status-error-throws", (() => {
      try {
        extractAgentReplyText(JSON.stringify({ ok: false, status: "error", error: { message: "nope" } }));
        return false;
      } catch {
        return true;
      }
    })()),
  ];

  const parsedBlocked = parseAgentDecision(JSON.stringify({
    decision: "dispatch",
    title: "OAuth client wiring",
    description: "Wire Google OAuth into auth",
    roadmap_ref: "Phase 4B",
    scopes: ["phase:4B"],
  }));
  const blockedBackstop = evaluateDispatchBackstop(parsedBlocked.decision.scopes, new Set(["phase:4B", "oq:OQ-12"]));
  const missingScopesBackstop = evaluateDispatchBackstop(undefined, new Set());
  const emptyScopesBackstop = evaluateDispatchBackstop([], new Set());
  const emptyBlocksBackstop = evaluateDispatchBackstop(["phase:9"], new Set(summarizeOpenTodos([{ id: "TODO-0006", status: "open", blocks: [] }]).blockedScopes));
  const backstopDirectCases = [
    check("backstop-blocked-scope-direct", parsedBlocked.ok === true && blockedBackstop.ok === false, blockedBackstop),
    check("backstop-missing-scopes-direct", missingScopesBackstop.ok === false, missingScopesBackstop),
    check("backstop-empty-scopes-direct", emptyScopesBackstop.ok === false, emptyScopesBackstop),
    check("backstop-empty-blocks-does-not-block", emptyBlocksBackstop.ok === true, emptyBlocksBackstop),
  ];

  const dispatchMocks = () => ({
    findActive: () => null,
    repoExists: () => true,
    fetchStaging: async () => "staging-tip-abc",
    startRun: ({ workflow, task }) => {
      dispatchMocks.started.push({ workflow, task });
      return { id: "spawn-log-1", pid: 1, logPath: "/tmp/spawn-log-1.log" };
    },
    waitRun: async () => ({ id: "run-uuid-1", status: "running", run_number: 9 }),
  });
  dispatchMocks.started = [];

  const mqDispatch = memoryQueue([]);
  let scanCalledOnDispatch = 0;
  const dispatchResult = await handleDispatchNext({
    ...dispatchMocks(),
    load: mqDispatch.load,
    save: mqDispatch.save,
    scan: async () => {
      scanCalledOnDispatch += 1;
      return { outcome: "dispatch", decision: dispatchReply, blockedScopes: [], open_count: 0, todo_ids: [] };
    },
  });
  const dispatchedItem = dispatchResult.body.item;
  const dispatchCases = [
    check("1-status-200", dispatchResult.status === 200, dispatchResult.status),
    check("1-dispatched-true", dispatchResult.body.dispatched === true),
    check("1-scan-ran-once", scanCalledOnDispatch === 1, scanCalledOnDispatch),
    check("1-startRun-called", dispatchMocks.started.length === 1, dispatchMocks.started.length),
    check("1-source", dispatchedItem?.source === ROADMAP_AUTO_SOURCE, dispatchedItem?.source),
    check("1-roadmap-ref", dispatchedItem?.roadmap_ref === dispatchReply.roadmap_ref, dispatchedItem?.roadmap_ref),
    check(
      "1-repoPath-is-trial-clone",
      dispatchedItem?.repoPath === DEFAULT_QUEUE_REPO_PATH,
      dispatchedItem?.repoPath,
    ),
    check(
      "1-repoPath-is-not-thecoach-env",
      dispatchedItem?.repoPath !== "/mnt/c/Users/lahad/Projects/TheCoach",
      dispatchedItem?.repoPath,
    ),
    check("1-queue-item-dispatched", dispatchedItem?.status === "dispatched", dispatchedItem?.status),
    check(
      "1-task-contains-title-and-description",
      typeof dispatchedItem?.task === "string" &&
        dispatchedItem.task.includes(dispatchReply.title) &&
        dispatchedItem.task.includes(dispatchReply.description),
      dispatchedItem?.task,
    ),
    check(
      "1-startRun-task-uses-trial-clone",
      dispatchMocks.started[0]?.task?.includes(`REPO: ${DEFAULT_QUEUE_REPO_PATH}`),
      dispatchMocks.started[0]?.task,
    ),
    check("1-reason-not-needs-developer-decision", dispatchResult.body.reason !== "needs-developer-decision"),
  ];

  const mqBlocked = memoryQueue([]);
  let startRunOnBlocked = 0;
  const blockedHttp = await handleDispatchNext({
    findActive: () => null,
    load: mqBlocked.load,
    save: mqBlocked.save,
    scan: async () => ({
      outcome: "dispatch",
      decision: { ...dispatchReply, scopes: ["phase:4B"] },
      blockedScopes: ["phase:4B", "oq:OQ-12"],
      open_count: 1,
      todo_ids: ["TODO-0004"],
    }),
    startRun: () => {
      startRunOnBlocked += 1;
      throw new Error("startRun must not run on blocked-scope");
    },
  });
  const blockedScopeCases = [
    check("blocked-scope-status-200", blockedHttp.status === 200, blockedHttp.status),
    check("blocked-scope-not-dispatched", blockedHttp.body.dispatched === false),
    check("blocked-scope-reason", blockedHttp.body.reason === "nothing-dispatchable", blockedHttp.body.reason),
    check("blocked-scope-backstop-rejected", blockedHttp.body.backstop_rejected === true, blockedHttp.body),
    check("blocked-scope-open-count", blockedHttp.body.open_count === 1, blockedHttp.body.open_count),
    check("blocked-scope-todo-ids", JSON.stringify(blockedHttp.body.todo_ids) === JSON.stringify(["TODO-0004"]), blockedHttp.body.todo_ids),
    check("blocked-scope-no-queue-item", mqBlocked.get().length === 0, mqBlocked.get().length),
    check("blocked-scope-startRun-not-called", startRunOnBlocked === 0, startRunOnBlocked),
    check(
      "blocked-scope-logged",
      capturedLogs.some((l) => l.includes("backstop-rejected-dispatch") && l.includes("phase:4B")),
      capturedLogs.filter((l) => l.includes("backstop")),
    ),
  ];

  const mqMissingScopes = memoryQueue([]);
  let startRunOnMissingScopes = 0;
  const missingScopesHttp = await handleDispatchNext({
    findActive: () => null,
    load: mqMissingScopes.load,
    save: mqMissingScopes.save,
    scan: async () => ({
      outcome: "dispatch",
      decision: dispatchReplyNoScopes,
      blockedScopes: [],
      open_count: 0,
      todo_ids: [],
    }),
    startRun: () => {
      startRunOnMissingScopes += 1;
      throw new Error("startRun must not run on missing scopes");
    },
  });
  const missingScopesCases = [
    check("missing-scopes-not-dispatched", missingScopesHttp.body.dispatched === false),
    check("missing-scopes-reason", missingScopesHttp.body.reason === "nothing-dispatchable", missingScopesHttp.body.reason),
    check("missing-scopes-backstop-rejected", missingScopesHttp.body.backstop_rejected === true, missingScopesHttp.body),
    check("missing-scopes-startRun-not-called", startRunOnMissingScopes === 0, startRunOnMissingScopes),
  ];

  const mqEmptyBlocks = memoryQueue([]);
  dispatchMocks.started = [];
  let emptyBlocksAgentCalls = 0;
  const emptyBlocksHttp = await handleDispatchNext({
    ...dispatchMocks(),
    load: mqEmptyBlocks.load,
    save: mqEmptyBlocks.save,
    scan: async () =>
      scanRoadmapForWork({
        thecoachRepo: "/tmp/thecoach-does-not-matter",
        readTodo: () => JSON.stringify([{ id: "TODO-0006", status: "open", summary: "billing", blocks: [] }]),
        readRoadmap: () => "# ROADMAP",
        runAgent: async () => {
          emptyBlocksAgentCalls += 1;
          return JSON.stringify({ payloads: [{ text: JSON.stringify(dispatchReply) }] });
        },
      }),
  });
  const emptyBlocksCases = [
    check("empty-blocks-agent-called", emptyBlocksAgentCalls === 1, emptyBlocksAgentCalls),
    check("empty-blocks-dispatched", emptyBlocksHttp.body.dispatched === true, emptyBlocksHttp.body),
  ];

  const schemaLogsBefore = capturedLogs.length;
  const missingBlocksTodo = [{ id: "TODO-0007", status: "open", summary: "unscoped" }];
  let missingBlocksAgentCalls = 0;
  const missingBlocksScan = await scanRoadmapForWork({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    readTodo: () => JSON.stringify(missingBlocksTodo),
    readRoadmap: () => "# ROADMAP",
    runAgent: async () => {
      missingBlocksAgentCalls += 1;
      throw new Error("runAgent must not run when blocks missing (treated as *)");
    },
  });
  const schemaLogs = capturedLogs.slice(schemaLogsBefore);
  const missingBlocksHttp = await handleDispatchNext({
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    scan: async () => missingBlocksScan,
    startRun: () => {
      throw new Error("startRun must not run on missing-blocks star");
    },
  });
  const missingBlocksCases = [
    check("missing-blocks-agent-not-called", missingBlocksAgentCalls === 0, missingBlocksAgentCalls),
    check("missing-blocks-outcome", missingBlocksScan.outcome === "nothing-dispatchable", missingBlocksScan),
    check("missing-blocks-star", missingBlocksScan.blockedScopes.includes(SCOPE_GLOBAL), missingBlocksScan.blockedScopes),
    check(
      "missing-blocks-logged",
      schemaLogs.some((l) => l.includes('schema-violation todo_id=TODO-0007 reason="missing blocks"')),
      schemaLogs,
    ),
    check("missing-blocks-http-not-dispatched", missingBlocksHttp.body.dispatched === false),
    check("missing-blocks-http-reason", missingBlocksHttp.body.reason === "nothing-dispatchable", missingBlocksHttp.body.reason),
  ];

  const tenOpen = Array.from({ length: 10 }, (_, i) => ({
    id: `TODO-${String(i + 1).padStart(4, "0")}`,
    status: "open",
    summary: `q${i}`,
    blocks: [],
  }));
  let ceilingAgentCalls = 0;
  let ceilingScan = { outcome: "threw-before-return" };
  try {
    ceilingScan = await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      readTodo: () => JSON.stringify(tenOpen),
      readRoadmap: () => "# ROADMAP",
      runAgent: async () => {
        ceilingAgentCalls += 1;
        return JSON.stringify({ payloads: [{ text: JSON.stringify(dispatchReply) }] });
      },
    });
  } catch (err) {
    ceilingScan = { outcome: "threw", error: err?.message || String(err) };
  }
  const ceilingHttp = await handleDispatchNext({
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    scan: async () => ceilingScan,
    startRun: () => {
      throw new Error("startRun must not run on ceiling");
    },
  });
  const ceilingCases = [
    check("ceiling-agent-not-called", ceilingAgentCalls === 0, ceilingAgentCalls),
    check("ceiling-outcome", ceilingScan.outcome === "developer-attention-required", ceilingScan.outcome),
    check("ceiling-reason", ceilingHttp.body.reason === "developer-attention-required", ceilingHttp.body.reason),
    check("ceiling-open-count", ceilingHttp.body.open_count === 10, ceilingHttp.body.open_count),
    check("ceiling-not-dispatched", ceilingHttp.body.dispatched === false),
  ];

  const nineOpen = Array.from({ length: 9 }, (_, i) => ({
    id: `TODO-${String(i + 1).padStart(4, "0")}`,
    status: "open",
    summary: `q${i}`,
    blocks: [],
  }));
  let nineAgentCalls = 0;
  dispatchMocks.started = [];
  const mqNine = memoryQueue([]);
  const nineHttp = await handleDispatchNext({
    ...dispatchMocks(),
    load: mqNine.load,
    save: mqNine.save,
    scan: async () =>
      scanRoadmapForWork({
        thecoachRepo: "/tmp/thecoach-does-not-matter",
        readTodo: () => JSON.stringify(nineOpen),
        readRoadmap: () => "# ROADMAP",
        runAgent: async () => {
          nineAgentCalls += 1;
          return JSON.stringify({ payloads: [{ text: JSON.stringify(dispatchReply) }] });
        },
      }),
  });
  const nineEmptyCases = [
    check("nine-empty-blocks-agent-called", nineAgentCalls === 1, nineAgentCalls),
    check("nine-empty-blocks-dispatched", nineHttp.body.dispatched === true, nineHttp.body),
  ];

  const mqNothing = memoryQueue([]);
  const idleNothing = memoryIdle();
  const nothingResult = await handleDispatchNext({
    findActive: () => null,
    load: mqNothing.load,
    save: mqNothing.save,
    loadIdle: idleNothing.loadIdle,
    saveIdle: idleNothing.saveIdle,
    thecoachRepo: "/tmp/idle",
    scan: async () => ({ outcome: "nothing-dispatchable", open_count: 2, todo_ids: ["TODO-0004", "TODO-0006"] }),
    startRun: () => {
      throw new Error("startRun must not run");
    },
  });
  const nothingCases = [
    check("3-status-200", nothingResult.status === 200),
    check("3-reason-nothing-dispatchable", nothingResult.body.reason === "nothing-dispatchable", nothingResult.body.reason),
    check("3-open-count", nothingResult.body.open_count === 2, nothingResult.body.open_count),
    check("3-todo-ids", JSON.stringify(nothingResult.body.todo_ids) === JSON.stringify(["TODO-0004", "TODO-0006"]), nothingResult.body.todo_ids),
    check("3-no-queue-item", mqNothing.get().length === 0),
    check("3-no-needs-developer-decision", nothingResult.body.reason !== "needs-developer-decision"),
    check("3-idle-incremented", idleNothing.get().consecutive_idle === 1, idleNothing.get()),
  ];

  const agentFailScans = [];
  agentFailScans.push(
    await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      readRoadmap: () => "# ROADMAP",
      readTodo: () => "[]",
      runAgent: async () => {
        const err = new Error("openclaw agent failed: spawn ETIMEDOUT");
        err.code = "ETIMEDOUT";
        throw err;
      },
    }),
  );
  agentFailScans.push(
    await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      readRoadmap: () => "# ROADMAP",
      readTodo: () => "[]",
      runAgent: async () => {
        throw new Error("openclaw agent failed: Command failed: openclaw agent");
      },
    }),
  );
  agentFailScans.push(
    await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      readRoadmap: () => "# ROADMAP",
      readTodo: () => "[]",
      runAgent: async () => "this is not json {",
    }),
  );
  agentFailScans.push(
    await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      readRoadmap: () => "# ROADMAP",
      readTodo: () => "[]",
      runAgent: async () => JSON.stringify({ payloads: [{ text: "I think we should dispatch something." }] }),
    }),
  );
  const agentFailHttp = [];
  for (const [i, scanResult] of agentFailScans.entries()) {
    const mq = memoryQueue([]);
    const httpResult = await handleDispatchNext({
      findActive: () => null,
      load: mq.load,
      save: mq.save,
      scan: async () => scanResult,
      startRun: () => {
        throw new Error("startRun must not run on agent-fail");
      },
    });
    agentFailHttp.push(
      check(
        `4-agent-fail-${i}-http`,
        httpResult.status === 200 &&
          httpResult.body.dispatched === false &&
          httpResult.body.reason === "nothing-dispatchable" &&
          mq.get().length === 0,
        { status: httpResult.status, body: httpResult.body, queueLen: mq.get().length, failReason: scanResult.failReason },
      ),
    );
  }
  const agentFailScanOutcomes = agentFailScans.map((s, i) =>
    check(`4-scan-${i}-nothing-dispatchable`, s.outcome === "nothing-dispatchable" && Boolean(s.failReason), s),
  );

  let roadmapThrowAgent = 0;
  let roadmapThrew = false;
  try {
    await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      readTodo: () => "[]",
      readRoadmap: () => {
        throw new Error("ENOENT: no such file or directory, open '.../_SSoT/ROADMAP.md'");
      },
      runAgent: async () => {
        roadmapThrowAgent += 1;
        throw new Error("runAgent must not run after ROADMAP.md read failure");
      },
    });
  } catch {
    roadmapThrew = true;
  }
  const missingRepo = path.join(os.tmpdir(), `no-such-thecoach-${Date.now()}`);
  let missingRepoAgent = 0;
  let missingRepoThrew = false;
  let missingRepoErr = null;
  try {
    await scanRoadmapForWork({
      thecoachRepo: missingRepo,
      runAgent: async () => {
        missingRepoAgent += 1;
        throw new Error("runAgent must not run after developer_todo.json ENOENT");
      },
    });
  } catch (err) {
    missingRepoThrew = true;
    missingRepoErr = err;
  }
  const mqFileFail = memoryQueue([]);
  let fileFailAgent = 0;
  const fileFailHttp = await handleDispatchNext({
    findActive: () => null,
    load: mqFileFail.load,
    save: mqFileFail.save,
    scan: async () =>
      scanRoadmapForWork({
        thecoachRepo: missingRepo,
        runAgent: async () => {
          fileFailAgent += 1;
          throw new Error("runAgent must not run");
        },
      }),
    startRun: () => {
      throw new Error("startRun must not run on file-fail");
    },
  });
  let unsetRepoAgent = 0;
  let unsetRepoThrew = false;
  try {
    await scanRoadmapForWork({
      thecoachRepo: "",
      runAgent: async () => {
        unsetRepoAgent += 1;
        throw new Error("runAgent must not run when repo unset");
      },
    });
  } catch {
    unsetRepoThrew = true;
  }
  const fileFailCases = [
    check("file-roadmap-throws", roadmapThrew === true && roadmapThrowAgent === 0, { roadmapThrew, roadmapThrowAgent }),
    check("file-missing-repo-throws", missingRepoThrew === true && missingRepoAgent === 0, { missingRepoThrew, missingRepoAgent, code: missingRepoErr?.code }),
    check("file-missing-repo-enoent", missingRepoErr?.code === "ENOENT", missingRepoErr?.code),
    check("file-fail-http-not-queue-empty", fileFailHttp.status === 500 && fileFailHttp.body.reason !== "queue empty" && fileFailHttp.body.ok === false, fileFailHttp),
    check("file-fail-http-not-nothing-dispatchable", fileFailHttp.body.reason !== "nothing-dispatchable", fileFailHttp.body),
    check("file-fail-agent-not-called", fileFailAgent === 0, fileFailAgent),
    check("file-unset-repo-throws", unsetRepoThrew === true && unsetRepoAgent === 0, { unsetRepoThrew, unsetRepoAgent }),
  ];

  const humanItem = {
    id: "human-pending-1",
    task: "human submitted task",
    repoPath: "/tmp/human-repo",
    branchHint: null,
    status: "pending",
    runId: null,
    createdAt: new Date().toISOString(),
    dispatchedAt: null,
    resolvedAt: null,
    note: null,
  };
  const mqOccupied = memoryQueue([humanItem]);
  let occupiedScanCalls = 0;
  const occupiedStarted = [];
  const occupiedResult = await handleDispatchNext({
    findActive: () => null,
    load: mqOccupied.load,
    save: mqOccupied.save,
    scan: async () => {
      occupiedScanCalls += 1;
      throw new Error("scan must not run when queue is not empty");
    },
    repoExists: () => true,
    fetchStaging: async () => "occupied-tip",
    startRun: ({ workflow, task }) => {
      occupiedStarted.push({ workflow, task });
      return { id: "spawn-human", pid: 2, logPath: "/tmp/spawn-human.log" };
    },
    waitRun: async () => ({ id: "run-human", status: "running", run_number: 3 }),
  });
  const occupiedCases = [
    check("5-scan-never-ran", occupiedScanCalls === 0, occupiedScanCalls),
    check("5-dispatched-true", occupiedResult.body.dispatched === true),
    check("5-same-human-item", occupiedResult.body.item?.id === "human-pending-1", occupiedResult.body.item?.id),
    check("5-no-auto-source", occupiedResult.body.item?.source === undefined, occupiedResult.body.item?.source),
    check(
      "5-task-is-human",
      occupiedStarted[0]?.task?.includes("human submitted task"),
      occupiedStarted[0]?.task,
    ),
  ];

  const activeHttp = await handleDispatchNext({
    findActive: () => ({ id: "run-active", status: "running", run_number: 7 }),
    load: () => {
      throw new Error("load must not run on active-run");
    },
    scan: async () => {
      throw new Error("scan must not run on active-run");
    },
    startRun: () => {
      throw new Error("startRun must not run on active-run");
    },
  });
  const activeCases = [
    check("active-run-reason", activeHttp.body.reason === "active-run", activeHttp.body.reason),
    check("active-run-not-dispatched", activeHttp.body.dispatched === false),
    check("active-run-has-open-count", typeof activeHttp.body.open_count === "number", activeHttp.body),
    check("active-run-has-todo-ids", Array.isArray(activeHttp.body.todo_ids), activeHttp.body),
    check("active-run-not-needs-developer-decision", activeHttp.body.reason !== "needs-developer-decision"),
  ];

  let todoMissingThrew = false;
  let todoMissingCode = null;
  try {
    readDeveloperTodoFile(missingRepo);
  } catch (err) {
    todoMissingThrew = true;
    todoMissingCode = err?.code || null;
  }
  const todoCases = [
    check("todo-missing-throws", todoMissingThrew === true, todoMissingCode),
    check("todo-missing-is-enoent", todoMissingCode === "ENOENT", todoMissingCode),
  ];

  const fetchedDuringScan = [];
  const roadmapRepos = [];
  const todoRepos = [];
  const pathScan = await scanRoadmapForWork({
    thecoachRepo: "/mnt/c/Users/lahad/Projects/TheCoach",
    fetchStaging: async (p) => {
      fetchedDuringScan.push(p);
      return "tip";
    },
    readRoadmap: (repo) => {
      roadmapRepos.push(repo);
      return "# ROADMAP\n## Phase 4A\n";
    },
    readTodo: (repo) => {
      todoRepos.push(repo);
      return '[{"id":"TODO-0001","status":"open","blocks":[]}]';
    },
    runAgent: async () => JSON.stringify({ payloads: [{ text: '{"decision":"nothing-to-do"}' }] }),
  });
  const pathCases = [
    check("path-scan-nothing-dispatchable", pathScan.outcome === "nothing-dispatchable" && !pathScan.failReason, pathScan),
    check("path-scan-does-not-fetch", fetchedDuringScan.length === 0, fetchedDuringScan),
    check("path-roadmap-is-thecoach-env", roadmapRepos[0] === "/mnt/c/Users/lahad/Projects/TheCoach", roadmapRepos),
    check("path-todo-is-thecoach-env", todoRepos[0] === "/mnt/c/Users/lahad/Projects/TheCoach", todoRepos),
    check("path-roadmap-is-not-trial-clone", roadmapRepos[0] !== DEFAULT_QUEUE_REPO_PATH, roadmapRepos),
  ];

  const timeoutCases = [
    check("timeout-exec-above-cli", PLANNER_EXEC_TIMEOUT_MS > PLANNER_CLI_TIMEOUT_SEC * 1000, {
      cliSec: PLANNER_CLI_TIMEOUT_SEC,
      execMs: PLANNER_EXEC_TIMEOUT_MS,
    }),
    check("timeout-cli-above-measured-band", PLANNER_CLI_TIMEOUT_SEC >= 100, PLANNER_CLI_TIMEOUT_SEC),
  ];

  const idle = memoryIdle();
  const idleResults = [];
  for (let i = 1; i <= 24; i += 1) {
    const r = await handleDispatchNext({
      findActive: () => null,
      load: memoryQueue([]).load,
      save: () => {},
      loadIdle: idle.loadIdle,
      saveIdle: idle.saveIdle,
      thecoachRepo: "/tmp/idle",
      scan: async () => ({ outcome: "nothing-dispatchable", open_count: 0, todo_ids: [] }),
      startRun: () => {
        throw new Error("startRun must not run");
      },
    });
    idleResults.push({ i, escalated: r.body.escalated === true, consecutive: idle.get().consecutive_idle });
  }
  dispatchMocks.started = [];
  const idleAfterDispatch = memoryIdle({ consecutive_idle: 5, last_idle_at: "t", last_escalated_at: null });
  await handleDispatchNext({
    ...dispatchMocks(),
    load: memoryQueue([]).load,
    save: () => {},
    loadIdle: idleAfterDispatch.loadIdle,
    saveIdle: idleAfterDispatch.saveIdle,
    thecoachRepo: "/tmp/idle",
    scan: async () => ({ outcome: "dispatch", decision: dispatchReply, blockedScopes: [], open_count: 0, todo_ids: [] }),
  });
  const idleBeforeActive = memoryIdle({ consecutive_idle: 3, last_idle_at: "t", last_escalated_at: null });
  await handleDispatchNext({
    findActive: () => ({ id: "x", status: "running", run_number: 1 }),
    loadIdle: idleBeforeActive.loadIdle,
    saveIdle: idleBeforeActive.saveIdle,
    thecoachRepo: "/tmp/idle",
  });
  const idleBeforeCeiling = memoryIdle({ consecutive_idle: 3, last_idle_at: "t", last_escalated_at: null });
  await handleDispatchNext({
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    loadIdle: idleBeforeCeiling.loadIdle,
    saveIdle: idleBeforeCeiling.saveIdle,
    thecoachRepo: "/tmp/idle",
    scan: async () => ({ outcome: "developer-attention-required", open_count: 10, todo_ids: tenOpen.map((e) => e.id) }),
  });
  let idleThrowLoads = 0;
  const idleSwallowHttp = await handleDispatchNext({
    ...dispatchMocks(),
    load: memoryQueue([]).load,
    save: () => {},
    loadIdle: () => {
      idleThrowLoads += 1;
      throw new Error("idle read boom");
    },
    saveIdle: () => {
      throw new Error("idle write boom");
    },
    thecoachRepo: "/tmp/idle",
    scan: async () => ({ outcome: "dispatch", decision: dispatchReply, blockedScopes: [], open_count: 0, todo_ids: [] }),
  });
  const idleCases = [
    check("idle-count-after-24", idle.get().consecutive_idle === 24, idle.get()),
    check("idle-escalate-at-12", idleResults[11].escalated === true && idleResults[11].consecutive === 12, idleResults[11]),
    check("idle-escalate-at-24", idleResults[23].escalated === true && idleResults[23].consecutive === 24, idleResults[23]),
    check("idle-not-at-11", idleResults[10].escalated === false, idleResults[10]),
    check("idle-not-at-13", idleResults[12].escalated === false, idleResults[12]),
    check("idle-reset-on-dispatch", idleAfterDispatch.get().consecutive_idle === 0, idleAfterDispatch.get()),
    check("idle-untouched-on-active-run", idleBeforeActive.get().consecutive_idle === 3, idleBeforeActive.get()),
    check("idle-untouched-on-ceiling", idleBeforeCeiling.get().consecutive_idle === 3, idleBeforeCeiling.get()),
    check("idle-failure-swallowed", idleSwallowHttp.body.dispatched === true, idleSwallowHttp.body),
  ];

  const storedTodos = [
    { id: "TODO-0001", status: "open", summary: "Need a yes/no on adding CI", blocks: [] },
  ];
  const writes = [];
  const dupScan = await scanRoadmapForWork({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    readTodo: () => JSON.stringify(storedTodos),
    readRoadmap: () => "# ROADMAP",
    writeTodo: (_repo, entries) => {
      writes.push(entries);
    },
    runAgent: async () => JSON.stringify({ payloads: [{ text: JSON.stringify(recordQuestionReply) }] }),
  });
  const freshWrites = [];
  const freshStored = [];
  const appendScan = await scanRoadmapForWork({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    readTodo: () => JSON.stringify(freshStored),
    readRoadmap: () => "# ROADMAP",
    writeTodo: (_repo, entries) => {
      freshWrites.push(JSON.parse(JSON.stringify(entries)));
      freshStored.splice(0, freshStored.length, ...entries);
    },
    runAgent: async () =>
      JSON.stringify({
        payloads: [{ text: JSON.stringify({ ...recordQuestionReply, summary: "brand new question", blocks: [] }) }],
      }),
  });
  const writerCases = [
    check("dup-summary-no-write", writes.length === 0, writes.length),
    check("dup-summary-nothing-dispatchable", dupScan.outcome === "nothing-dispatchable", dupScan.outcome),
    check("append-wrote-once", freshWrites.length === 1, freshWrites.length),
    check("append-status-open", freshStored[0]?.status === "open", freshStored[0]),
    check("append-blocks-empty", Array.isArray(freshStored[0]?.blocks) && freshStored[0].blocks.length === 0, freshStored[0]),
    check("append-id", freshStored[0]?.id === "TODO-0001", freshStored[0]?.id),
    check("append-outcome", appendScan.outcome === "nothing-dispatchable", appendScan.outcome),
  ];

  console.log = origLog;

  const allCases = [
    ...parseCases,
    ...extractCases,
    ...backstopDirectCases,
    ...dispatchCases,
    ...blockedScopeCases,
    ...missingScopesCases,
    ...emptyBlocksCases,
    ...missingBlocksCases,
    ...ceilingCases,
    ...nineEmptyCases,
    ...nothingCases,
    ...agentFailScanOutcomes,
    ...agentFailHttp,
    ...fileFailCases,
    ...occupiedCases,
    ...activeCases,
    ...todoCases,
    ...pathCases,
    ...timeoutCases,
    ...idleCases,
    ...writerCases,
  ];

  const report = {
    ok: failures.length === 0,
    failed: failures.length,
    failures,
    cases: allCases,
  };
  origLog(JSON.stringify(report, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

server.requestTimeout = 300_000;
server.headersTimeout = 310_000;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Coordinator trigger server: http://127.0.0.1:${PORT}`);
  console.log(`Antfarm root: ${ANTFARM_ROOT}`);
  console.log(`Antfarm CLI: ${ANTFARM_CLI}`);
  console.log(`Antfarm DB (read-only): ${ANTFARM_DB}`);
  console.log(`Queue file: ${QUEUE_PATH}`);
  console.log(`TheCoach repo (roadmap + todo): ${THECOACH_REPO || "(unset)"}`);
  console.log(`Logs: ${LOG_DIR}`);
});
