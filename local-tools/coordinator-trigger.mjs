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
import { spawn, execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PROTECTED_PATH_PATTERNS } from "../dist/lib/protected-paths.js";
import {
  evaluateTaskScopeGate,
  maskManualDispatchRoadmap,
  parseDispatchFromMarkdown,
  SCOPE_GATE_SKIPPED_LOG,
} from "../dist/lib/task-dispatch-gate.js";

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
const OPEN_QUESTION_CEILING = 50;
const IDLE_ESCALATION_EVERY = 12;
const TODO_STATUS_OPEN = "open";
const TODO_STATUS_RESOLVED = "resolved";
const TODO_STATUS_DECLINED = "declined";
const SCOPE_GLOBAL = "*";
const RECORD_QUESTION_TYPES = new Set(["blocked", "passed-awaiting-dev", "roadmap-decision", "other"]);
const SCAN_STATE_PATH =
  process.env.COORDINATOR_SCAN_STATE_PATH ||
  path.join(ANTFARM_ROOT, "local-tools", "coordinator-scan-state.json");
const LEDGER_PATH =
  process.env.COORDINATOR_LEDGER_PATH ||
  path.join(ANTFARM_ROOT, "local-tools", "coordinator-dispatch-ledger.json");
/**
 * Lock TTL vs worst-case scan:
 *   planner exec 105s + git fetch 25s + rev-parse 15s + waitRun 20s = 165s
 *   TTL 300s → 135s headroom (was 40s at the 120s fetch cap).
 */
const SCAN_LOCK_TTL_MS = 5 * 60 * 1000;

// ─── Item 8: automatic diagnose-and-retry of a failed run ───────────────────
/** Automatic retries per queue item. Cap 2 → at most 3 runs (1 original + 2). */
const AUTO_RETRY_CAP = 2;
/**
 * A `diagnosis-pending` ledger entry older than this is treated as a failed
 * diagnosis and parked. Without it, a coordinator killed mid-diagnosis would
 * leave the key in a non-blocking state forever. Same shape as SCAN_LOCK_TTL_MS.
 */
const DIAGNOSIS_TTL_MS = 10 * 60 * 1000;
const DIAGNOSIS_AGENT_ID = "thecoach-dev_verifier";
const DIAGNOSIS_MODEL = "anthropic/claude-sonnet-5";
const LEDGER_OUTCOME_FAILED = "failed";
const LEDGER_OUTCOME_DIAGNOSIS_PENDING = "diagnosis-pending";
const LEDGER_OUTCOME_RETRY_PENDING = "retry-pending";
const AUTO_RETRY_SOURCE = "coordinator:auto-retry";
const AUTO_RETRY_FEEDBACK_HEADER = "PRIOR ATTEMPT FEEDBACK (attempt ";
/**
 * TASK-048 (2026-09-01). Marker for the dispatch-time prior-progress block.
 * Distinct from AUTO_RETRY_FEEDBACK_HEADER: that one carries a DIAGNOSIS of a
 * previous failure into the next attempt; this one carries the target
 * branch's CURRENT STATE into the plan step. Independent — both can appear.
 */
const PRIOR_PROGRESS_HEADER = "PRIOR PROGRESS ALREADY COMMITTED ON THIS BRANCH";
/** Cap on files listed in the preamble. The count reported is always exact. */
const PRIOR_PROGRESS_FILE_SAMPLE = 40;
const FAILURE_CLASSES = new Set(["transient", "fixable", "structural"]);
/**
 * Classes that resume the existing antfarm run at its failed step instead of
 * dispatching a fresh run. Structural never retries (parked above this). If
 * resume itself errors, finishFailureHandling falls back to today's redispatch.
 */
const AUTO_RETRY_RESUME_CLASSES = new Set(["transient", "fixable"]);
/** Wall-clock budget for `antfarm workflow resume` — DB reset plus cron ensure. */
const AUTO_RETRY_RESUME_TIMEOUT_MS = 30_000;
const AUTO_RETRY_RESUME_NOTE_PREFIX = "auto-retry resume of run ";
const FAILED_RUN_STATUS = "failed";
/** Sorted-key join the diagnosis reply must match exactly (parseAgentDecision style). */
const DIAGNOSIS_REPLY_KEYS = "class,evidence,reason,retry_guidance";
const AUTO_RETRY_HISTORY_LIMIT = 20;
/**
 * sprint:<id> / phase:<id> / oq:OQ-<n> / task:TASK-<n> / * — compared after
 * canonicalizeScopeToken().
 *
 * `sprint:` is what the scan derives now. `phase:` stays accepted, read-only:
 * developer_todo.json still holds entries whose `blocks` name a phase (e.g.
 * TODO-0022, `phase:5`), and dropping the token from the grammar would make
 * those entries unparseable — a schema violation that blocks dispatch
 * globally. Nothing derives a `phase:` scope any more.
 */
const SCOPE_TOKEN_RE = /^(?:\*|sprint:[a-z0-9]+|phase:[a-z0-9]+|oq:oq-\d+|task:task-\d+)$/;
const TASK_ID_RE = /TASK-(\d+)/i;
/** Task files live here, read from COORDINATOR_THECOACH_REPO — same as ROADMAP.md. */
const TASKS_RELATIVE_DIR = path.join("_SSoT", "tasks");
/** The only Dev agent this coordinator can actually spawn today. */
const DISPATCHABLE_TOOL = "Cursor";
/**
 * Conservative branch-name extract from a ## Branch section. Requires a
 * feature/fix/feat/docs prefix so prose like "Never `main`" or a WSL path
 * cannot be mistaken for the intended git branch.
 */
const TASK_BRANCH_NAME_RE = /\b((?:feature|fix|feat|docs)\/[A-Za-z0-9._-]+)/;
/**
 * The only base the thecoach-dev workflow can actually cut from today: its
 * setup step hardcodes `git checkout staging && git pull` before
 * `git checkout -b {{branch}}`. A task file asking for any other base cannot
 * be honoured, so it is refused rather than silently cut from staging —
 * that silent substitution is what killed antfarm run #17 (TASK-025).
 */
const DISPATCHABLE_BASE = "staging";
/**
 * Base clause inside a ## Branch section: "cut from `staging`",
 * "(new branch off `main`)". Checked in order; first hit wins.
 */
const TASK_BASE_CUT_FROM_RE = /\bcut\s+from\s+([A-Za-z0-9._/-]+)/i;
const TASK_BASE_OFF_RE = /\b(?:branch\s+)?off\s+(?:of\s+)?([A-Za-z0-9._/-]+)/i;
/**
 * "continue existing branch" / "continue on X" / "stay on X" — the task wants
 * an existing branch, not a fresh cut. Setup does `git checkout -b`, which
 * fails on an existing branch, so this is never dispatchable today.
 */
const TASK_BASE_CONTINUE_RE = /\b(?:continue\s+(?:on|existing\s+branch)|stay\s+on|already\s+the\s+working\s+branch)\b/i;
/**
 * A base clause must name something branch-shaped. Without this, prose like
 * "or a `fix/` branch cut from it" yields the base "it" (TASK-021, TASK-040).
 */
const TASK_BASE_SHAPE_RE = /^(?:staging|main|master|(?:feature|fix|feat|docs|release|chore)\/[A-Za-z0-9._-]+)$/i;
/**
 * ## Status values that must never dispatch, matched anywhere in the status'
 * first line — "Ready — blocked until PR #22" is not ready either.
 */
const TASK_STATUS_NOT_READY_RE = /\b(blocked|hold|superseded|deferred|abandoned|wontfix|do\s+not\s+dispatch|not\s+dispatchable)\b/i;
/**
 * Dispatch ground truth is a `## Sprint NN — <flow>` entry and the unchecked
 * `- [ ] … (TASK-nnn)` lines under it, written by Routine 9 at Sprint Start.
 *
 * There is no `## Phase N` fallback, deliberately. The live ROADMAP.md has had
 * no such heading since 2026-09-02, but `_SSoT/archive/ROADMAP_2026-09-02_pre-
 * reset.md` still does — with unchecked TASK-nnn lines (TASK-025's among them)
 * that must stay un-dispatched. A fallback would make the archive dispatchable
 * the moment anyone pointed a reader at it. Only ROADMAP_RELATIVE_PATH is ever
 * read, and only Sprint headings are ever matched.
 *
 * `\d+[a-z]?` matches `Sprint 01` and `Sprint 1a`, and deliberately does NOT
 * match the `## Sprint NN — <one-line demonstrable flow>` line in the roadmap's
 * own "Sprint entry template" section: `NN` is not digits, so the template's
 * placeholder `- [ ] <short description> (TASK-nnn)` sits under no heading.
 */
const SPRINT_HEADING_RE = /sprint\s+(\d+[a-z]?)\b/i;
/** `## Sprint 1a — The site is on the internet` — ground truth for dispatch. */
const SPRINT_HEADING_LINE_RE = /^##\s+Sprint\s+(\d+[a-z]?)\b/i;
/** Open checklist items only. `[x]` / `[X]` are completed and must not dispatch. */
const OPEN_CHECKBOX_LINE_RE = /^\s*-\s*\[\s*\]/;
const RESOLVED_CHECKBOX_LINE_RE = /^\s*-\s*\[[xX]\]/;
/**
 * Wall-clock budget for a single ROADMAP.md walk. A zero-length-regex hang
 * would never return; this is the guard that makes that class of bug visible.
 */
const ROADMAP_PARSE_BUDGET_MS = 2_000;
/**
 * Measured 2026-08-26 on the trial clone: git fetch origin = 873ms / 928ms
 * (two consecutive runs), rev-parse = 1.8ms. 25s is ~27× observed fetch and
 * the middle of the 20–30s band. Combined with rev-parse 15s + waitRun 20s,
 * spawnPendingQueueItem worst case is 60s (Cloudflare edge cutoff ~125s).
 */
const GIT_FETCH_TIMEOUT_MS = 25_000;
const GIT_REVPARSE_TIMEOUT_MS = 15_000;
const WAIT_FOR_RUN_TIMEOUT_MS = 20_000;
/** Windows checkout — judgment inputs only. Loaded from EnvironmentFile, never a unit Environment= line. */
const THECOACH_REPO = (process.env.COORDINATOR_THECOACH_REPO || "").trim();
const PLANNER_AGENT_ID = "thecoach-dev_planner";
const PLANNER_MODEL = "anthropic/claude-sonnet-5";
// These bound the *agent call*, not the HTTP request. The empty-queue scan
// still runs in the background (reason: scan-started) because the planner
// alone is 105s. spawnPendingQueueItem stays inline: worst case is
// GIT_FETCH_TIMEOUT_MS + GIT_REVPARSE_TIMEOUT_MS + WAIT_FOR_RUN_TIMEOUT_MS
// = 60s, under the ~125s Cloudflare cutoff.
const PLANNER_CLI_TIMEOUT_SEC = 100;
const PLANNER_EXEC_TIMEOUT_MS = 105_000;
/** Test hook: scan-must-not-fetch observers. Production never registers any. */
const stagingFetchObservers = [];

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
/** Run statuses that are terminal AND unsuccessful — must not resolve as queue "done". */
const FAILED_RUN_STATUSES = new Set(["failed", "cancelled", "canceled"]);
const SUCCESS_RUN_STATUS = "completed";

/** Mechanical PR base gate — only "staging" is allowed (not prompt prose). */
const EXPECTED_PR_BASE = "staging";

/**
 * TASK-044 refusal reason: the TheCoach checkout itself could not be read, so
 * no task contract is knowable and nothing may dispatch. Distinct from
 * "task-file-missing", which is a readable repo with no file for that id.
 */
const THECOACH_REPO_UNREADABLE = "thecoach-repo-unreadable";

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
  "GET /queue/scan-state",
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
 * Resume a failed antfarm run at its failed step/story. Sync because
 * finishFailureHandling must know success vs error before choosing the
 * fresh-redispatch fallback. `deps.resumeRun` is the test seam.
 */
function resumeWorkflowRun(runIdParam, deps = {}) {
  if (typeof deps.resumeRun === "function") return deps.resumeRun(runIdParam);
  try {
    const stdout = execFileSync(
      process.execPath,
      [ANTFARM_CLI, "workflow", "resume", runIdParam],
      {
        cwd: ANTFARM_ROOT,
        encoding: "utf-8",
        timeout: AUTO_RETRY_RESUME_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );
    return { ok: true, stdout: String(stdout || "") };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      stdout: err?.stdout ? String(err.stdout) : "",
      stderr: err?.stderr ? String(err.stderr) : "",
    };
  }
}

/** Live antfarm run status, or null if the DB is missing/unreadable. */
function tryGetLiveRunStatus(runIdParam, deps = {}) {
  if (typeof deps.getRunStatus === "function") {
    try {
      return deps.getRunStatus(runIdParam)?.status ?? null;
    } catch {
      return null;
    }
  }
  try {
    return getRunStatus(runIdParam)?.status ?? null;
  } catch {
    return null;
  }
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

function canonicalizeScopeToken(value) {
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function parseScopeToken(value) {
  if (typeof value !== "string") {
    return { ok: false, reason: "non-string", value };
  }
  const canonical = canonicalizeScopeToken(value);
  if (!canonical) {
    return { ok: false, reason: "empty", value };
  }
  if (!SCOPE_TOKEN_RE.test(canonical)) {
    return { ok: false, reason: "malformed", value, canonical };
  }
  return { ok: true, canonical };
}

function parseScopeList(values, { allowEmpty = true } = {}) {
  if (!Array.isArray(values)) {
    return { ok: false, reason: "not-array", values };
  }
  if (values.length === 0) {
    return allowEmpty
      ? { ok: true, canonical: [] }
      : { ok: false, reason: "missing-or-empty-scopes", canonical: [] };
  }
  const canonical = [];
  for (const value of values) {
    const parsed = parseScopeToken(value);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, value, values };
    }
    canonical.push(parsed.canonical);
  }
  return { ok: true, canonical };
}

function derivePhaseScopeFromRoadmapRef(roadmapRef) {
  if (typeof roadmapRef !== "string") return null;
  const m = roadmapRef.match(SPRINT_HEADING_RE);
  if (!m) return null;
  return canonicalizeScopeToken(`sprint:${m[1]}`);
}

function extractTaskIdFromText(...parts) {
  for (const part of parts) {
    const m = String(part || "").match(TASK_ID_RE);
    if (m) return `TASK-${m[1].padStart(3, "0")}`;
  }
  return null;
}

function extractAllTaskIdsFromText(...parts) {
  const ids = [];
  const seen = new Set();
  for (const part of parts) {
    const re = /TASK-(\d+)/gi;
    let m;
    while ((m = re.exec(String(part || ""))) !== null) {
      const id = `TASK-${m[1].padStart(3, "0")}`;
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Body of a `## Heading` section, up to the next `## ` heading.
 * headingRe matches the heading line (e.g. /^##\s+Branch\b/i).
 */
function extractMarkdownSection(markdown, headingRe) {
  const lines = String(markdown || "").split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

function firstNonEmptyLine(text) {
  for (const line of String(text || "").split(/\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Parse ## Branch. Ambiguous / missing / a request for main → not ok.
 * Does not guess a default.
 */
function parseTaskBranch(sectionText) {
  if (sectionText == null || !String(sectionText).trim()) {
    return { ok: false, field: "Branch", reason: "missing-or-empty" };
  }
  const first = firstNonEmptyLine(sectionText).replace(/[`*_]/g, "").trim();
  const firstToken = first.split(/\s+/)[0] || "";
  if (/^(main|master)$/i.test(firstToken)) {
    return { ok: false, field: "Branch", reason: "refused-main", value: firstToken };
  }
  const match = String(sectionText).match(TASK_BRANCH_NAME_RE);
  if (!match) {
    return { ok: false, field: "Branch", reason: "unparseable" };
  }
  const branch = match[1];
  if (/^(main|master)$/i.test(branch)) {
    return { ok: false, field: "Branch", reason: "refused-main", value: branch };
  }
  return { ok: true, field: "Branch", branch };
}

/**
 * Parse ## Tool/model (also `## Tool/model if applicable`).
 * Uses the first non-empty line only, so later prose mentioning the other
 * tier cannot flip the routing. Known values: Cursor | Claude Code.
 */
function parseTaskToolModel(sectionText) {
  if (sectionText == null || !String(sectionText).trim()) {
    return { ok: false, field: "Tool/model", reason: "missing-or-empty" };
  }
  const first = firstNonEmptyLine(sectionText).replace(/[`*_]/g, " ").replace(/\s+/g, " ").trim();
  if (/\bClaude Code\b/i.test(first)) {
    return { ok: true, field: "Tool/model", tool: "Claude Code" };
  }
  if (/\bCursor\b/i.test(first)) {
    return { ok: true, field: "Tool/model", tool: "Cursor" };
  }
  return { ok: false, field: "Tool/model", reason: "unparseable", value: first.slice(0, 80) };
}

/** First paragraph of a section — up to the first blank line. */
function firstParagraph(text) {
  const out = [];
  for (const line of String(text || "").split(/\n/)) {
    if (!line.trim()) {
      if (out.length) break;
      continue;
    }
    out.push(line.trim());
  }
  return out.join(" ").replace(/[`*_]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Parse ## Status. Only a section whose first line starts with "Ready" and
 * carries no not-ready qualifier may dispatch. Everything else — Blocked,
 * On hold, Done, Superseded, missing, or prose we cannot read — is a refusal.
 * The task file's Status wins over the roadmap checkbox.
 */
function parseTaskStatus(sectionText) {
  if (sectionText == null || !String(sectionText).trim()) {
    return { ok: false, field: "Status", reason: "missing-or-empty" };
  }
  const first = firstNonEmptyLine(sectionText).replace(/[`*_]/g, " ").replace(/\s+/g, " ").trim();
  const notReady = first.match(TASK_STATUS_NOT_READY_RE);
  if (notReady) {
    return { ok: false, field: "Status", reason: "status-blocked", value: first.slice(0, 160) };
  }
  if (!/^ready\b/i.test(first)) {
    return { ok: false, field: "Status", reason: "status-not-ready", value: first.slice(0, 160) };
  }
  return { ok: true, field: "Status", status: first.slice(0, 160) };
}

/**
 * Parse the *base* out of a ## Branch section — the branch the run is cut
 * from, as distinct from the new branch's name. Reads the first paragraph
 * only, so a later "this task previously said to continue on X" note cannot
 * flip the base (TASK-028 has exactly that note).
 */
function parseTaskBase(sectionText) {
  if (sectionText == null || !String(sectionText).trim()) {
    return { ok: false, field: "Branch", reason: "base-missing-or-empty" };
  }
  const para = firstParagraph(sectionText);
  const acceptBase = (raw) => {
    const base = raw.replace(/[.,;:)]+$/, "");
    if (/^(main|master)$/i.test(base)) {
      return { ok: false, field: "Branch", reason: "base-refused-main", value: base };
    }
    if (!TASK_BASE_SHAPE_RE.test(base)) {
      return { ok: false, field: "Branch", reason: "base-unparseable", value: base };
    }
    return { ok: true, field: "Branch", base };
  };
  const cutFrom = para.match(TASK_BASE_CUT_FROM_RE);
  if (cutFrom) return acceptBase(cutFrom[1]);
  const off = para.match(TASK_BASE_OFF_RE);
  if (off) return acceptBase(off[1]);
  if (TASK_BASE_CONTINUE_RE.test(para)) {
    return { ok: false, field: "Branch", reason: "base-continue-existing", value: para.slice(0, 160) };
  }
  return { ok: false, field: "Branch", reason: "base-unstated", value: para.slice(0, 160) };
}

/** Read both contract fields from a task-file body. Either field failing fails the whole parse. */
function parseTaskContract(markdown) {
  const branchSection = extractMarkdownSection(markdown, /^##\s+Branch\b/i);
  const toolSection = extractMarkdownSection(markdown, /^##\s+Tool\/model\b/i);
  const branch = parseTaskBranch(branchSection);
  if (!branch.ok) return branch;
  const tool = parseTaskToolModel(toolSection);
  if (!tool.ok) return tool;
  return { ok: true, branch: branch.branch, tool: tool.tool };
}

/**
 * Throws when the tasks directory cannot be listed; returns [] only when the
 * listing SUCCEEDED and held no file for this id.
 *
 * TASK-044: this used to open with `if (!fs.existsSync(tasksDir)) return []`,
 * which collapsed "the repo path is wrong / the drive is not mounted" into the
 * same empty-array answer as "TASK-NNN simply has no file yet". The caller
 * reads that empty array as missing:true and skips every contract gate, so one
 * typo in COORDINATOR_THECOACH_REPO turned off the Status, Tool/model and
 * Branch-base checks at once. A real TheCoach checkout always has _SSoT/tasks/;
 * its absence is a broken path, not an empty task list.
 */
function listTaskFilenamesForId(tasksDir, taskId) {
  const prefix = `${taskId}-`;
  return fs.readdirSync(tasksDir).filter((name) => name.startsWith(prefix) && name.toLowerCase().endsWith(".md"));
}

/**
 * Load the task file for TASK-NNN from COORDINATOR_THECOACH_REPO and parse
 * ## Branch + ## Tool/model. missing:true means "no file to read" — caller
 * falls back to the hardcoded coordinator branch pattern. Any other failure
 * is a refusal (do not guess).
 *
 * TASK-044: "no file to read" means the tasks directory was READ SUCCESSFULLY
 * and holds no TASK-NNN file — a genuine roadmap/task-file gap. A tasks dir we
 * could not read at all (typo'd COORDINATOR_THECOACH_REPO, unmounted Windows
 * drive, renamed folder, permissions/IO error) is NOT that: it is a broken
 * repo path, and reporting it as missing:true silently skipped every contract
 * gate — Status, Tool/model and Branch base all at once — and dispatched on
 * coordinator defaults. Proven live 2026-09-04: with the repo path pointed at
 * a non-existent directory, TASK-028 (Blocked) and TASK-029 (unsupported
 * tool) both DISPATCHED instead of refusing. Fail closed instead.
 */
function loadTaskContractForId(taskId, deps = {}) {
  const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
  if (!repo) return { ok: false, missing: true, reason: "no-thecoach-repo", taskId };
  const tasksDir = path.join(repo, TASKS_RELATIVE_DIR);
  let names;
  try {
    names = listTaskFilenamesForId(tasksDir, taskId);
  } catch (err) {
    return {
      ok: false,
      missing: false,
      field: "repo-path",
      reason: THECOACH_REPO_UNREADABLE,
      taskId,
      path: tasksDir,
      error: err?.message || String(err),
    };
  }
  if (names.length === 0) {
    return { ok: false, missing: true, reason: "task-file-missing", taskId };
  }
  if (names.length > 1) {
    return {
      ok: false,
      missing: false,
      field: "task-file",
      reason: "ambiguous-task-file",
      taskId,
      files: names,
    };
  }
  const filePath = path.join(tasksDir, names[0]);
  let markdown;
  try {
    markdown = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    return { ok: false, missing: false, field: "task-file", reason: "task-file-unreadable", taskId, path: filePath, error: err?.message || String(err) };
  }
  const parsed = parseTaskContract(markdown);
  const dispatchParsed = parseDispatchFromMarkdown(markdown);
  const dispatchFields = {
    markdown,
    dispatch: dispatchParsed.dispatch,
    dispatchUnknown: dispatchParsed.unknown,
    dispatchValue: dispatchParsed.value,
    dispatchDefaulted: dispatchParsed.defaulted,
    // Parsed alongside, not folded into parseTaskContract: those two fields
    // are the pre-existing unit contract, and these gate dispatch separately.
    status: parseTaskStatus(extractMarkdownSection(markdown, /^##\s+Status\b/i)),
    base: parseTaskBase(extractMarkdownSection(markdown, /^##\s+Branch\b/i)),
  };
  if (!parsed.ok) return { ...parsed, missing: false, path: filePath, taskId, ...dispatchFields };
  return { ok: true, branch: parsed.branch, tool: parsed.tool, path: filePath, taskId, ...dispatchFields };
}

function hardcodedCoordinatorBranch(queueItemId) {
  return `feature/thecoach-dev-coordinator-${queueItemId}`;
}

/**
 * A1: ## Dispatch: manual. Quiet — no ledger, no developer_todo. Continue
 * to the next pending item as if this one were already [x].
 */
async function skipManualDispatchItem(queue, item, deps, taskId) {
  const save = deps.save || saveQueue;
  item.status = "flagged";
  item.resolvedAt = new Date().toISOString();
  item.note = `${taskId} ## Dispatch is manual; coordinator will not dispatch. Quiet skip.`;
  save(queue);
  const nextIdx = queue.findIndex((it) => it.status === "pending");
  if (nextIdx >= 0) {
    return spawnPendingQueueItem(queue, nextIdx, deps);
  }
  return {
    status: 200,
    body: withIdleTelemetry(
      {
        ok: true,
        dispatched: false,
        reason: "not-dispatchable-manual",
        task: taskId,
      },
      deps,
    ),
  };
}

/**
 * A2: declared expected files intersect the engine protected-path list.
 * One ledger failure entry + one developer_todo entry; item flagged.
 */
async function refuseProtectedPathScope(queue, item, deps, taskId, matches) {
  const save = deps.save || saveQueue;
  const named = matches.map((m) => `${m.path} -> ${m.pattern}`).join("; ");
  const note = `${taskId} expected files intersect the engine protected-path list (${named}). Re-scope the task or mark ## Dispatch: manual.`;
  item.status = "flagged";
  item.resolvedAt = new Date().toISOString();
  item.note = note;
  save(queue);
  recordLedgerAttempt(
    taskId,
    {
      lastDispatchedAt: new Date().toISOString(),
      queueItemId: item.id,
      outcome: "failed",
      reason: "protected-path-scope",
      matches,
      roadmap_ref: item.roadmap_ref ?? null,
    },
    deps,
  );
  try {
    const appendTodo = deps.appendTodo || ((repo, draft) => appendDeveloperTodoEntry(repo, draft, deps));
    const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
    if (repo || deps.appendTodo) {
      const written = appendTodo(repo, {
        summary: `Dispatch of ${taskId} refused: expected files are on the protected-path list (${named})`,
        why: `${taskId} must be either re-scoped off ${named} or marked ## Dispatch: manual. The coordinator will not start a run whose declared deliverable the engine would reject.`,
        source: taskId,
        type: "blocked",
        evidence: note,
        reply_needed: `Re-scope ${taskId} or set ## Dispatch: manual, then clear the ledger entry for ${taskId}.`,
        blocks: [`task:${taskId}`],
      });
      if (!written.appended) {
        logDispatchNext(`todo writer skipped duplicate summary for protected-path-scope ${taskId}`);
      }
    }
  } catch (err) {
    logDispatchNextError(`todo writer failed for protected-path-scope ${taskId}: ${err?.message || String(err)}`);
  }
  const nextIdx = queue.findIndex((it) => it.status === "pending");
  if (nextIdx >= 0) {
    return spawnPendingQueueItem(queue, nextIdx, deps);
  }
  return {
    status: 200,
    body: withIdleTelemetry(
      {
        ok: true,
        dispatched: false,
        reason: "protected-path-scope",
        task: taskId,
        matches,
      },
      deps,
    ),
  };
}

/**
 * Item 7: the target branch's diff vs staging is empty AND a previous attempt
 * on this task was empty too. Nothing is changing between runs, so a third
 * run reproduces the second. Same refusal shape as refuseProtectedPathScope —
 * ledger failure entry, task-scoped TODO, item flagged, queue advances — and
 * it spends no retry attempt.
 */
async function parkRepeatedEmptyDiff(queue, item, deps, taskId, branch, autoRetry) {
  const save = deps.save || saveQueue;
  const note = `${taskId} branch ${branch} has an empty diff vs ${EXPECTED_PR_BASE}, and a previous attempt did too. Parked without spending a run.`;
  item.status = "flagged";
  item.resolvedAt = new Date().toISOString();
  item.note = note;
  save(queue);
  const next = {
    ...autoRetry,
    parked: true,
    parkedReason: "structural",
    lastDiagnosis: {
      class: "structural",
      reason: "repeated empty diff — the branch changes no files and a previous attempt did not either",
      evidence: note,
      retry_guidance: "",
      at: new Date(nowMs(deps)).toISOString(),
    },
  };
  recordLedgerAttempt(
    taskId,
    {
      lastDispatchedAt: new Date().toISOString(),
      queueItemId: item.id,
      outcome: LEDGER_OUTCOME_FAILED,
      reason: "repeated-empty-diff",
      roadmap_ref: item.roadmap_ref ?? null,
      autoRetry: next,
    },
    deps,
  );
  writeParkTodo(
    {
      ledgerKey: taskId,
      item,
      autoRetry: next,
      diagnosis: next.lastDiagnosis,
      attempt: null,
      parkedReason: "structural",
    },
    deps,
  );
  const nextIdx = queue.findIndex((it) => it.status === "pending");
  if (nextIdx >= 0) {
    return spawnPendingQueueItem(queue, nextIdx, deps);
  }
  return {
    status: 200,
    body: withIdleTelemetry(
      {
        ok: true,
        dispatched: false,
        reason: "repeated-empty-diff",
        task: taskId,
        branch,
      },
      deps,
    ),
  };
}

/**
 * Host-side gates only: Dispatch -> Tool/model -> Branch (via contract parse) -> A2.
 * No agent, no startRun. Used by spawnPendingQueueItem and --eval-dispatch-gates.
 */
function evaluateHostDispatchGates(ledgerKey, contract) {
  if (!contract.missing && contract.dispatch === "manual") {
    if (contract.dispatchUnknown) {
      logDispatchNext(
        `warning: ${ledgerKey} ## Dispatch has unknown value ${JSON.stringify(contract.dispatchValue)}; treating as manual`,
      );
    }
    return {
      dispatched: false,
      reason: "not-dispatchable-manual",
      task: ledgerKey,
      dispatch_unknown: Boolean(contract.dispatchUnknown),
    };
  }
  // Status gate. The task file's ## Status wins over the roadmap checkbox, and
  // a Blocked / On hold / Done / unreadable status never dispatches. Runs
  // before Tool/model and Branch so a blocked task is refused for the reason
  // that actually applies to it.
  if (!contract.missing && contract.status && contract.status.ok !== true) {
    return {
      dispatched: false,
      reason: contract.status.reason || "status-not-ready",
      task: ledgerKey,
      contract_field: "Status",
      contract_value: contract.status.value,
    };
  }
  if (contract.ok) {
    if (contract.tool !== DISPATCHABLE_TOOL) {
      return {
        dispatched: false,
        reason: "unsupported-tool",
        task: ledgerKey,
        contract_field: "Tool/model",
        contract_value: contract.tool,
        tool: contract.tool,
        branch: contract.branch,
      };
    }
  } else if (!contract.missing) {
    return {
      dispatched: false,
      reason: contract.reason || "refused",
      task: ledgerKey,
      contract_field: contract.field || "task-file",
      contract_value: contract.value,
    };
  }

  // Base gate. `## Branch` carries two things: the new branch's name (parsed
  // above) and the base it is cut from. The workflow's setup step can only cut
  // from `staging`, so any other base — or one we cannot read — is refused
  // rather than silently cut from staging anyway.
  if (!contract.missing && contract.base) {
    if (contract.base.ok !== true) {
      return {
        dispatched: false,
        reason: contract.base.reason || "base-unparseable",
        task: ledgerKey,
        contract_field: "Branch",
        contract_value: contract.base.value,
        branch: contract.ok ? contract.branch : undefined,
      };
    }
    if (contract.base.base !== DISPATCHABLE_BASE) {
      return {
        dispatched: false,
        reason: "unsupported-base",
        task: ledgerKey,
        contract_field: "Branch",
        contract_value: contract.base.base,
        base: contract.base.base,
        branch: contract.ok ? contract.branch : undefined,
      };
    }
  }

  if (contract.missing || !contract.markdown) {
    logDispatchNext(SCOPE_GATE_SKIPPED_LOG);
    return {
      dispatched: true,
      scope_gate: "skipped",
      skip_log: SCOPE_GATE_SKIPPED_LOG,
      branch: null,
      tool: null,
    };
  }

  const scope = evaluateTaskScopeGate(contract.markdown);
  if (scope.skipped) {
    logDispatchNext(SCOPE_GATE_SKIPPED_LOG);
    return {
      dispatched: true,
      scope_gate: "skipped",
      skip_log: SCOPE_GATE_SKIPPED_LOG,
      branch: contract.branch,
      tool: contract.tool,
      base: contract.base?.ok ? contract.base.base : null,
    };
  }
  if (scope.matches.length > 0) {
    return {
      dispatched: false,
      reason: "protected-path-scope",
      task: ledgerKey,
      matches: scope.matches,
      branch: contract.branch,
      tool: contract.tool,
    };
  }
  return {
    dispatched: true,
    branch: contract.branch,
    tool: contract.tool,
    base: contract.base?.ok ? contract.base.base : null,
    matches: [],
  };
}

/**
 * Flag a pending item, surface the refusal on developer_todo (same route as
 * unledgerable / ledger-failed items), then advance to the next pending item.
 */
/**
 * TASK-044: single human-visible signal for a broken COORDINATOR_THECOACH_REPO.
 *
 * The TODO write targets the same repo we just failed to read, so it will
 * usually fail too — that is expected, and why the loud log line, not the
 * TODO, is the load-bearing signal. The write is still attempted because a
 * permissions error on `_SSoT/tasks/` alone leaves
 * `local/cursor_loop/developer_todo.json` perfectly writable, and in that case
 * the operator gets the better signal. appendDeveloperTodoEntry() dedupes on
 * an open entry with the same summary, so repeated dispatch attempts while the
 * path stays broken do not pile up entries.
 */
function refuseUnreadableTheCoachRepo(item, deps, ledgerKey, contract) {
  const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
  const detail = contract?.error ? ` — ${contract.error}` : "";
  logDispatchNextError(
    `thecoach-repo-unreadable repo=${repo} path=${contract?.path ?? "(unknown)"}${detail}` +
      ` — refusing to dispatch ${ledgerKey}; every task-file contract gate (Status, Tool/model, Branch base) is unverifiable while the checkout cannot be read`,
  );
  try {
    const appendTodo = deps.appendTodo || ((r, draft) => appendDeveloperTodoEntry(r, draft, deps));
    if (repo || deps.appendTodo) {
      appendTodo(repo, {
        summary: `Coordinator cannot read the TheCoach checkout at ${repo}`,
        why:
          "Every dispatch gate — ## Status, ## Tool/model, ## Branch base — is read from the task file."
          + " While the checkout is unreadable none of them can be evaluated, so dispatch refuses rather than"
          + " falling back to coordinator defaults.",
        source: "coordinator",
        type: "blocked",
        evidence: `${contract?.path ?? repo}: ${contract?.error || "unreadable"}`,
        reply_needed:
          `Fix COORDINATOR_THECOACH_REPO in local-tools/.coordinator-trigger.env (or remount the drive),`
          + ` then resolve this entry. Nothing dispatches until the checkout reads again.`,
        blocks: [SCOPE_GLOBAL],
      });
    }
  } catch (err) {
    logDispatchNextError(
      `todo writer failed for thecoach-repo-unreadable (expected when the whole checkout is gone): ${err?.message || String(err)}`,
    );
  }
  return {
    status: 200,
    body: withIdleTelemetry(
      {
        ok: true,
        dispatched: false,
        reason: THECOACH_REPO_UNREADABLE,
        queueItemId: item.id,
        ledger_key: ledgerKey,
        contract_field: "repo-path",
        repo,
      },
      deps,
    ),
  };
}

async function flagTaskContractRefusal(queue, item, deps, details) {
  const save = deps.save || saveQueue;
  const taskId = details.taskId;
  const field = details.field || "task-file";
  const reason = details.reason || "refused";
  const value = details.value;
  const note =
    details.note ||
    `${taskId} ## ${field} refused (${reason}${value ? `: ${value}` : ""}). Will not dispatch.`;
  item.status = "flagged";
  item.resolvedAt = new Date().toISOString();
  item.note = note;
  save(queue);
  try {
    const appendTodo = deps.appendTodo || ((repo, draft) => appendDeveloperTodoEntry(repo, draft, deps));
    const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
    if (repo || deps.appendTodo) {
      const written = appendTodo(repo, {
        summary: `Dispatch of ${taskId} refused: ## ${field} ${reason}${value ? ` (${value})` : ""}`,
        why:
          details.why ||
          `The task file's ## ${field} cannot be honoured, and substituting a coordinator default would silently ignore the contract.`,
        source: taskId,
        type: "blocked",
        evidence: note,
        reply_needed:
          details.replyNeeded ||
          `Resolve ## ${field} on ${taskId} (or run it by hand), then clear any matching developer_todo entry.`,
        blocks: [`task:${taskId}`],
      });
      if (!written.appended) {
        logDispatchNext(`todo writer skipped duplicate summary for task-contract refusal ${taskId}`);
      }
    }
  } catch (err) {
    logDispatchNextError(`todo writer failed for task-contract refusal ${taskId}: ${err?.message || String(err)}`);
  }
  const nextIdx = queue.findIndex((it) => it.status === "pending");
  if (nextIdx >= 0) {
    return spawnPendingQueueItem(queue, nextIdx, deps);
  }
  return {
    status: 200,
    body: withIdleTelemetry(
      {
        ok: true,
        dispatched: false,
        reason: "queue-item-rejected",
        queueItemId: item.id,
        ledger_key: taskId,
        contract_field: field,
        contract_reason: reason,
        contract_value: value ?? null,
      },
      deps,
    ),
  };
}

/**
 * Walk ROADMAP.md line-by-line with a wall-clock budget. Uses split("\\n")
 * rather than `/^.*$/gm` so a blank line cannot pin lastIndex and spin
 * the event loop. Index is the original-string offset of each line start
 * (counts the stripped `\\n`, and keeps `\\r` on CRLF lines).
 */
function iterateRoadmapLines(text, onLine, deps = {}) {
  const budget = Number.isFinite(deps.parseBudgetMs) ? deps.parseBudgetMs : ROADMAP_PARSE_BUDGET_MS;
  const t0 = nowMs(deps);
  const lines = String(text || "").split("\n");
  let index = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (nowMs(deps) - t0 > budget) {
      const err = new Error(`roadmap-parse-timeout after ${i} lines`);
      err.reason = "roadmap-parse-timeout";
      throw err;
    }
    onLine(lines[i], index);
    index += lines[i].length + 1;
  }
}

/**
 * Collect the `## Sprint NN — <flow>` entries, in file order.
 *
 * Only `##` Sprint headings count. The roadmap's `### Planned sprints`
 * (a numbered list), `### Task placement` and `### Backlog` (tables) name
 * sprints and task ids in prose, but carry no checkboxes and are explicitly
 * not commitments — a heading alone never makes anything dispatchable, and at
 * `###` they cannot match this anyway.
 */
function collectRoadmapPhaseHeadings(roadmapText, deps = {}) {
  const headings = [];
  iterateRoadmapLines(
    roadmapText,
    (line, index) => {
      const hm = line.match(SPRINT_HEADING_LINE_RE);
      if (hm) {
        headings.push({
          phaseId: hm[1].toLowerCase(),
          scope: canonicalizeScopeToken(`sprint:${hm[1]}`),
          index,
          heading: line,
        });
      }
    },
    deps,
  );
  return headings;
}

function phaseHeadingAt(headings, index) {
  let found = null;
  for (const heading of headings) {
    if (heading.index <= index) found = heading;
    else break;
  }
  return found;
}

function findTaskCheckboxInRoadmap(roadmapText, taskId, deps = {}) {
  const num = String(taskId || "").replace(/^TASK-/i, "");
  if (!/^\d+$/.test(num)) return null;
  const padded = num.padStart(3, "0");
  const idRe = new RegExp(`TASK-0*${Number(padded)}\\b`, "i");
  let hit = null;
  iterateRoadmapLines(
    roadmapText,
    (line, index) => {
      if (hit) return;
      const isOpen = OPEN_CHECKBOX_LINE_RE.test(line);
      const isResolved = RESOLVED_CHECKBOX_LINE_RE.test(line);
      if (!(isOpen || isResolved) || !idRe.test(line)) return;
      hit = { index, line, taskId: `TASK-${padded}`, resolved: isResolved };
    },
    deps,
  );
  return hit;
}

/**
 * Resolve a proposed dispatch against ROADMAP.md. TASK-NNN mentions in the
 * model reply are search keys only; the checkbox line and the `## Phase`
 * heading it sits under are ground truth. No checkbox → unlocatable.
 */
function locateDispatchInRoadmap(roadmapText, decision, deps = {}) {
  const headings = collectRoadmapPhaseHeadings(roadmapText, deps);
  const hints = extractAllTaskIdsFromText(decision?.title, decision?.description, decision?.roadmap_ref);
  if (hints.length === 0) {
    return { ok: false, reason: "item-unlocatable", headings };
  }
  for (const hint of hints) {
    const hit = findTaskCheckboxInRoadmap(roadmapText, hint, deps);
    if (!hit) continue;
    if (hit.resolved) {
      return {
        ok: false,
        reason: "item-resolved",
        taskId: hit.taskId,
        headings,
        matchIndex: hit.index,
        line: hit.line,
      };
    }
    const heading = phaseHeadingAt(headings, hit.index);
    if (!heading) {
      return {
        ok: false,
        reason: "underivable-phase",
        taskId: hit.taskId,
        headings,
        matchIndex: hit.index,
      };
    }
    return {
      ok: true,
      taskId: hit.taskId,
      filePhase: heading.scope,
      heading: heading.heading,
      matchIndex: hit.index,
      headings,
    };
  }
  return { ok: false, reason: "item-unlocatable", headings, hints };
}

function ledgerKeyFromDecision(decision, roadmapText, deps = {}) {
  const located = locateDispatchInRoadmap(roadmapText, decision, deps);
  return located.ok ? located.taskId : null;
}

function resolveQueueItemTaskId(item, deps = {}) {
  const fromItem = extractTaskIdFromText(item?.task, item?.roadmap_ref);
  if (fromItem) return fromItem;
  try {
    const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
    const readRoadmap = deps.readRoadmap || readRoadmapFile;
    if (!repo && !deps.readRoadmap) return null;
    const located = locateDispatchInRoadmap(
      readRoadmap(repo),
      {
        title: item?.task,
        description: "",
        roadmap_ref: item?.roadmap_ref,
      },
      deps,
    );
    if (located.ok) return located.taskId;
  } catch {
    // spawn still needs a stable key; a judgment-file miss becomes unledgerable
  }
  return null;
}

function normalizeQuestionFingerprint(draft) {
  const summary = String(draft?.summary || "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${String(draft?.source || "").trim()}\n${String(draft?.type || "").trim()}\n${summary}`;
}

function defaultEnqueueBackground(job) {
  setImmediate(() => {
    Promise.resolve()
      .then(job)
      .catch((err) => logDispatchNextError(`background scan failed: ${err?.message || String(err)}`));
  });
}

function loadJsonFileOr(defaultValue, filePath) {
  if (!fs.existsSync(filePath)) return defaultValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return defaultValue;
  }
}

function loadScanState(deps = {}) {
  if (deps.loadScanState) return deps.loadScanState();
  return loadJsonFileOr(null, SCAN_STATE_PATH);
}

function saveScanState(state, deps = {}) {
  if (deps.saveScanState) {
    deps.saveScanState(state);
    return;
  }
  writeJsonAtomic(SCAN_STATE_PATH, state);
}

function loadLedger(deps = {}) {
  if (deps.loadLedger) return deps.loadLedger();
  const parsed = loadJsonFileOr({}, LEDGER_PATH);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function saveLedger(ledger, deps = {}) {
  if (deps.saveLedger) {
    deps.saveLedger(ledger);
    return;
  }
  writeJsonAtomic(LEDGER_PATH, ledger);
}

function nowMs(deps = {}) {
  if (typeof deps.now === "function") return deps.now();
  if (typeof deps.now === "number") return deps.now;
  return Date.now();
}

function isScanLockActive(state, now) {
  if (!state || state.status !== "running") return false;
  const started = Date.parse(state.startedAt);
  if (!Number.isFinite(started)) return false;
  return now - started < SCAN_LOCK_TTL_MS;
}

function newScanId() {
  return `scan-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function ledgerBlocksKey(ledger, key) {
  if (!key) return false;
  const entry = ledger[key];
  if (!entry || entry.cleared === true) return false;
  return entry.outcome === "failed";
}

function recordLedgerAttempt(key, fields, deps = {}) {
  if (!key) return;
  const ledger = loadLedger(deps);
  ledger[key] = { ...(ledger[key] || {}), ...fields, key, cleared: fields.cleared === true };
  saveLedger(ledger, deps);
}

// ───────────────────────────────────────────────────────────────────────────
// Item 8 — auto-diagnose-and-retry. A failed RUN no longer parks straight to
// outcome:"failed" (which required a human to hand-edit the ledger before any
// retry). It is classified first — deterministically where possible, by an
// automated agent turn where not — and then either retried with feedback
// (capped) or parked through the same scoped-blocker route as before.
//
// Invariant every path must preserve: whatever breaks, the key ends terminal
// (`failed` + a task-scoped TODO) and the queue advances. Degrading to the
// pre-2026-08-29 behaviour is always the safe fallback.
// ───────────────────────────────────────────────────────────────────────────

/** sha256 of an empty diff — the digest a no-op branch produces. */
const EMPTY_DIFF_DIGEST = crypto.createHash("sha256").update("").digest("hex");

/**
 * Genuine hits: the diff ran and touched a host-enforced path.
 *
 * Must match the engine's hit message FORM, not just the gate's name. Until
 * 2026-09-01 this was the bare prefix "protected-path gate:", which matches any
 * step that merely talks about the gate — including a step that PASSED it. That
 * false-positived on TASK-023 run 295daa2f: verify passed and said so
 * ("Protected-path gate: git diff --stat ... is empty"), the bare prefix matched
 * its own explanatory prose, and the run parked "structural" with zero retries
 * spent — while the real failure was the test step's OQ-09 /404-prerender
 * non-determinism, nothing to do with the gate. The verifier's own AGENTS.md
 * contains that phrase too, so an agent echoing its instructions was enough.
 *
 * `formatProtectedPathHitsMessage` (src/installer/step-ops.ts) is the only
 * producer of a real hit and emits exactly "Protected-path gate: diff touches
 * <files>". The gate-run failures use "Protected-path gate cannot run:" and match
 * neither form. Narrowing to the hit form fails OPEN: an unmatched failure falls
 * through to the agent diagnosis turn rather than parking on a guess.
 */
const PROTECTED_PATH_HIT_SIGNATURES = [
  "protected-path gate: diff touches",
];

/**
 * The gate could not run because required run context was absent (repo, or a
 * COMMIT_SHA that is not a usable git ref).
 *
 * STRUCTURAL, not transient. Until 2026-08-31 this shared one bucket with
 * git_failed below and was classified transient — which is why TASK-027 run #37
 * and its auto-retry #38 both died on `missing_context: commit_sha` with the
 * identical signature, spending an attempt for nothing. A story that produces
 * no commit produces no commit on the retry either; nothing about re-running it
 * supplies the missing field. Engine-side, D1 now falls back to the
 * branch-level diff so this should be rare, but when it does fire it must park,
 * not retry.
 */
const PROTECTED_PATH_GATE_MISSING_CONTEXT_SIGNATURES = [
  "protected_path_gate_missing_context",
];

/**
 * The gate ran but git threw (unresolvable ref, missing base branch, shallow
 * clone). Genuinely worth one retry — the condition can clear on its own
 * (TASK-025 #34). Must not use the "deliverable is on the host-enforced list"
 * template, and must NOT be swept in with missing_context above.
 */
const PROTECTED_PATH_GATE_GIT_FAILED_SIGNATURES = [
  "protected_path_gate_git_failed",
];

/** Host dispatch-gate refusals: these never reach a run, so no run can fix them. */
const HOST_GATE_REFUSAL_REASONS = new Set([
  "unsupported-tool",
  "ambiguous-task-file",
  "protected-path-scope",
  "not-dispatchable-manual",
  "task-file-unreadable",
  "refused",
]);

/** Engine/infra signatures — safe to retry unchanged, no feedback needed. */
const TRANSIENT_SIGNATURES = [
  "spawn-timeout-504",
  "antfarm run id not observed",
  "out of memory",
  "oom-kill",
  "oom killed",
  "killed by signal",
  "econnreset",
  "etimedout",
  "socket hang up",
  "error 530",
  "error 502",
  "error 503",
  "openclaw agent failed",
  "antfarm.db not found",
  "no space left on device",
];

function defaultAutoRetry() {
  return {
    attempts: 0,
    cap: AUTO_RETRY_CAP,
    parked: false,
    parkedReason: null,
    lastDiagnosis: null,
    history: [],
  };
}

/** Tolerant read of a ledger entry's autoRetry block; never throws. */
function normaliseAutoRetry(entry) {
  const raw = entry && typeof entry.autoRetry === "object" && entry.autoRetry ? entry.autoRetry : null;
  if (!raw) return defaultAutoRetry();
  return {
    attempts: Number.isFinite(raw.attempts) ? Math.max(0, Math.trunc(raw.attempts)) : 0,
    cap: Number.isFinite(raw.cap) ? Math.max(0, Math.trunc(raw.cap)) : AUTO_RETRY_CAP,
    parked: raw.parked === true,
    parkedReason: raw.parkedReason ?? null,
    lastDiagnosis: raw.lastDiagnosis ?? null,
    history: Array.isArray(raw.history) ? raw.history.slice(-AUTO_RETRY_HISTORY_LIMIT) : [],
  };
}

/** Comparable form of a failure reason — shas and whitespace normalised out. */
function normaliseFailureReason(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/**
 * Content digest of `git diff staging...<branch>`. `ran:false` is NOT "empty" —
 * a branch that does not exist yet, or a git failure, must never be mistaken
 * for a no-op branch (Item 7 would otherwise park a first dispatch).
 */
function branchDiffDigest(repoPath, branch, deps = {}) {
  if (deps.branchDiff) return deps.branchDiff(repoPath, branch);
  if (!repoPath || !branch) {
    return { ran: false, digest: null, files: [], error: "missing repoPath or branch" };
  }
  try {
    const opts = { cwd: repoPath, encoding: "utf-8", timeout: 15_000, maxBuffer: 32 * 1024 * 1024 };
    const names = execFileSync("git", ["diff", "--name-only", `${EXPECTED_PR_BASE}...${branch}`], opts);
    const content = execFileSync("git", ["diff", `${EXPECTED_PR_BASE}...${branch}`], opts);
    return {
      ran: true,
      digest: crypto.createHash("sha256").update(content).digest("hex"),
      files: names.trim() ? names.trim().split("\n") : [],
    };
  } catch (err) {
    return { ran: false, digest: null, files: [], error: err?.message || String(err) };
  }
}

/** One-line reason + evidence for this attempt, from the run's own steps. */
function summariseRunFailure({ stepsResult, runStatus, queueStatus, note }) {
  const steps = Array.isArray(stepsResult?.steps) ? stepsResult.steps : [];
  const failed = steps.filter((st) => st.status === "failed");
  const target = failed[0] || null;
  const output = String(target?.output || "");
  const firstLine = output.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  const reason = target
    ? `step ${target.stepId} failed: ${firstLine || "(no output)"}`
    : `run ended runStatus=${runStatus} queueStatus=${queueStatus}${note ? ` — ${note}` : ""}`;
  return {
    reason: reason.slice(0, 500),
    evidence: target ? `${target.stepId}: ${output.slice(0, 600)}` : String(note || "").slice(0, 600),
    failedStepIds: failed.map((st) => st.stepId),
    outputs: steps.map((st) => ({
      stepId: st.stepId,
      status: st.status,
      retryCount: st.retryCount,
      maxRetries: st.maxRetries,
      output: String(st.output || "").slice(-2000),
    })),
  };
}

function unknownDiagnosis(detail) {
  return {
    class: "unknown",
    reason: `diagnosis step unavailable: ${String(detail || "").slice(0, 300)}`,
    evidence: "",
    retry_guidance: "",
  };
}

/**
 * Deterministic pre-classification. Runs BEFORE any agent turn is spent, and
 * owns every case where model judgment would be a liability:
 *   1. a host dispatch-gate refusal — no run can fix it
 *   2. a protected-path HIT (diff touched a host-enforced path) — retrying
 *      repeats it identically. Gate-run failures (git_failed / missing_context)
 *      are retryable-or-engine, not this.
 *   3. a reason or diff digest already in history — same wall, second time
 *   4. an empty diff when a prior attempt was also empty (Item 7)
 *   5. a known engine/infra signature → transient, retry as-is
 * Returns null when the failure is genuinely ambiguous — only then is an
 * agent turn spent.
 */
function preClassifyRunFailure({ entry, autoRetry, attempt, diff }) {
  const ledgerReason = String(entry?.reason || "");
  if (ledgerReason && HOST_GATE_REFUSAL_REASONS.has(ledgerReason)) {
    return {
      class: "structural",
      reason: `host dispatch gate refused this task (${ledgerReason}); no run can change that`,
      evidence: `ledger reason=${ledgerReason}`,
      retry_guidance: "",
    };
  }

  const haystack = [attempt.reason, ...attempt.outputs.map((o) => o.output)].join("\n").toLowerCase();
  // Hits first: gate-run-failure signatures can coexist with a real hit in the
  // joined haystack (another step, or ORIGINAL_OUTPUT:). Hit messages use
  // "protected-path gate: diff touches"; run-failure messages use
  // "Protected-path gate cannot run:" and never match the hit signature.
  const gateHit = PROTECTED_PATH_HIT_SIGNATURES.find((sig) => haystack.includes(sig));
  if (gateHit) {
    return {
      class: "structural",
      reason: "the protected-path gate blocked this run; the task's own deliverable is on the host-enforced list",
      evidence: `protected-path gate signature "${gateHit}" in step output`,
      retry_guidance: "",
    };
  }
  // Missing context is checked BEFORE git_failed: when both appear in one
  // haystack the run still cannot supply the absent field, so the structural
  // verdict is the correct (and cheaper) one.
  const gateMissingContext = PROTECTED_PATH_GATE_MISSING_CONTEXT_SIGNATURES.find((sig) =>
    haystack.includes(sig),
  );
  if (gateMissingContext) {
    return {
      class: "structural",
      reason: "the protected-path gate could not run because required run context was missing (repo, or a COMMIT_SHA that is not a usable git ref) — a retry re-runs the same story and produces the same absent field",
      evidence: `protected-path gate missing-context signature "${gateMissingContext}" in step output`,
      retry_guidance: "",
    };
  }
  const gateRunFailed = PROTECTED_PATH_GATE_GIT_FAILED_SIGNATURES.find((sig) => haystack.includes(sig));
  if (gateRunFailed) {
    return {
      class: "transient",
      reason: "the protected-path gate itself failed to run (git ref missing/unresolvable, or git diff threw) — not a protected-path hit",
      evidence: `protected-path gate-run-failure signature "${gateRunFailed}" in step output`,
      retry_guidance: "",
    };
  }

  const thisReason = normaliseFailureReason(attempt.reason);
  const repeatedReason = autoRetry.history.find((h) => h.reason && h.reason === thisReason);
  if (repeatedReason) {
    return {
      class: "structural",
      reason: `identical failure to a previous attempt (${thisReason.slice(0, 160)}); retrying reproduces it`,
      evidence: `prior attempt at ${repeatedReason.at} had the same normalised reason`,
      retry_guidance: "",
    };
  }

  if (diff.ran && diff.digest) {
    const repeatedDiff = autoRetry.history.find((h) => h.diffHash && h.diffHash === diff.digest);
    if (repeatedDiff) {
      const empty = diff.digest === EMPTY_DIFF_DIGEST;
      return {
        class: "structural",
        reason: empty
          ? "this attempt produced an empty diff and a previous attempt did too — nothing is changing between runs"
          : "this attempt produced a byte-identical diff to a previous attempt — nothing is changing between runs",
        evidence: `diff digest ${diff.digest.slice(0, 12)} also recorded at ${repeatedDiff.at}`,
        retry_guidance: "",
      };
    }
  }

  if (TRANSIENT_SIGNATURES.some((sig) => haystack.includes(sig))) {
    return {
      class: "transient",
      reason: `environmental failure (${attempt.reason.slice(0, 200)})`,
      evidence: attempt.evidence,
      retry_guidance: "",
    };
  }

  return null;
}

/** Strict parse of the diagnosis reply — same all-keys-must-match strictness as parseAgentDecision. */
function parseDiagnosisReply(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text).trim());
  } catch (err) {
    return { ok: false, error: `diagnosis reply is not JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "diagnosis reply is not a JSON object" };
  }
  const keyStr = Object.keys(parsed).sort().join(",");
  if (keyStr !== DIAGNOSIS_REPLY_KEYS) {
    return { ok: false, error: `diagnosis object has unexpected keys: ${keyStr}` };
  }
  if (!FAILURE_CLASSES.has(parsed.class)) {
    return { ok: false, error: `diagnosis class is not allowed: ${JSON.stringify(parsed.class)}` };
  }
  if (!isNonEmptyString(parsed.reason) || !isNonEmptyString(parsed.evidence)) {
    return { ok: false, error: "diagnosis is missing a required non-empty string field" };
  }
  if (typeof parsed.retry_guidance !== "string") {
    return { ok: false, error: "diagnosis retry_guidance must be a string" };
  }
  if (parsed.class !== "structural" && !parsed.retry_guidance.trim()) {
    return { ok: false, error: "diagnosis retry_guidance is required unless class is structural" };
  }
  return { ok: true, diagnosis: parsed };
}

function buildFailureDiagnosisPrompt({ ledgerKey, item, attempt, diff, branch, autoRetry, taskMarkdown }) {
  const steps = attempt.outputs
    .map((o) => `--- step ${o.stepId} (status=${o.status}, retries=${o.retryCount}/${o.maxRetries}) ---\n${o.output || "(no output)"}`)
    .join("\n\n");
  const history = autoRetry.history.length
    ? autoRetry.history
        .map((h, i) => `${i + 1}. ${h.at} class=${h.class} diffHash=${h.diffHash ? h.diffHash.slice(0, 12) : "(not computed)"} reason=${h.reason}`)
        .join("\n")
    : "(none — this is the first failure for this task)";
  return `You are diagnosing why one automated workflow run failed, so the coordinator can decide whether retrying it is worth a run.

Reply with ONLY one JSON object, nothing else — no prose before or after, no markdown fences.

{"class":"transient|fixable|structural","reason":"<one line: what actually failed>","evidence":"<step id + the verbatim line that proves it>","retry_guidance":"<what the next run must do differently; empty string ONLY when class is structural>"}

Class definitions — pick exactly one:
- "transient": an environmental/infrastructure failure (VM freeze, OOM, tunnel drop, timeout, engine error). Retrying the same work unchanged is likely to succeed. retry_guidance must still be a short non-empty note.
- "fixable": a real implementation problem with an actionable cause (wrong approach, missing test, bad branch state, a step's own reported reason). Retrying WITH specific guidance is likely to succeed. retry_guidance must say concretely what to do differently.
- "structural": no retry can fix this — a policy wall, a contradiction in the task itself, or work that is already done. retry_guidance must be the empty string.

Choose "structural" rather than burning a retry whenever the same attempt would hit the same wall: the deliverable is on a protected path, the task contradicts a host gate, prior attempts already failed identically, or the branch diff shows nothing is changing between runs.

TASK: ${ledgerKey}
BRANCH: ${branch || "(unknown)"}
QUEUE ITEM NOTE: ${item?.note || "(none)"}
BRANCH DIFF vs ${EXPECTED_PR_BASE}: ${diff.ran ? (diff.files.length ? diff.files.join(", ") : "EMPTY — the branch changes no files") : `could not be computed (${diff.error || "unknown"})`}

PRIOR AUTOMATIC ATTEMPTS FOR THIS TASK:
${history}

TASK FILE:
${(taskMarkdown || "(task file unavailable)").slice(0, 8000)}

RUN STEPS (full step outputs, most recent run):
${steps.slice(0, 40000)}
`;
}

/**
 * Terminal handling for one classified failure. Either resumes the existing
 * failed run (retryable classes), enqueues a capped fresh auto-retry, or
 * parks the task for the developer through the existing scoped-blocker
 * route. `ctx.queue`, when an array, is the live queue the caller will
 * save; otherwise the queue is loaded and saved here.
 */
function finishFailureHandling(ctx, deps = {}) {
  const { ledgerKey, item, queue, base, autoRetry, attempt, diff, branch, diagnosis, runStatus } = ctx;
  const at = new Date(nowMs(deps)).toISOString();
  const next = {
    ...autoRetry,
    lastDiagnosis: { ...diagnosis, at },
    history: [
      ...autoRetry.history,
      {
        at,
        runId: item?.runId ?? null,
        branch: branch ?? null,
        class: diagnosis.class,
        reason: normaliseFailureReason(diagnosis.reason || attempt?.reason),
        diffHash: diff && diff.ran ? diff.digest : null,
      },
    ].slice(-AUTO_RETRY_HISTORY_LIMIT),
  };

  const structural = diagnosis.class === "structural";
  const unknown = diagnosis.class === "unknown";
  const capReached = next.attempts >= next.cap;

  if (structural || unknown || capReached) {
    const parkedReason = structural ? "structural" : unknown ? "diagnosis-unavailable" : "cap-reached";
    next.parked = true;
    next.parkedReason = parkedReason;
    recordLedgerAttempt(
      ledgerKey,
      { ...base, outcome: LEDGER_OUTCOME_FAILED, autoRetry: next, diagnosisStartedAt: null },
      deps,
    );
    writeParkTodo({ ledgerKey, item, autoRetry: next, diagnosis, attempt, parkedReason }, deps);
    logDispatchNext(
      `auto-retry parked key=${ledgerKey} class=${diagnosis.class} parked=${parkedReason} attempts=${next.attempts}/${next.cap}`,
    );
    return { outcome: LEDGER_OUTCOME_FAILED, parkedReason, autoRetry: next, resumed: false };
  }

  // Attempts increment when the retry is ENQUEUED, not when it finishes — a
  // crash between here and dispatch cannot produce an extra attempt.
  next.attempts += 1;
  next.parked = false;
  next.parkedReason = null;

  // Resume the existing run at its failed step when classification is
  // retryable and antfarm still has the run as failed. Structural never
  // reaches here. A resume error falls back to today's fresh redispatch
  // so a stuck run cannot spend the attempt with no work happening.
  let resumed = false;
  let resumeError = null;
  const liveStatus = item?.runId ? tryGetLiveRunStatus(item.runId, deps) : null;
  const statusForResume = liveStatus || runStatus;
  const canResume =
    AUTO_RETRY_RESUME_CLASSES.has(diagnosis.class) &&
    statusForResume === FAILED_RUN_STATUS &&
    Boolean(item?.runId);
  if (canResume) {
    try {
      const resumeResult = resumeWorkflowRun(item.runId, deps);
      if (resumeResult && resumeResult.ok) {
        resumed = true;
      } else {
        resumeError = resumeResult?.error || "resume returned not-ok";
      }
    } catch (err) {
      resumeError = err?.message || String(err);
    }
    if (!resumed) {
      logDispatchNextError(
        `auto-retry resume failed key=${ledgerKey} run=${item.runId}: ${resumeError}; falling back to fresh redispatch`,
      );
    }
  }

  recordLedgerAttempt(
    ledgerKey,
    { ...base, outcome: LEDGER_OUTCOME_RETRY_PENDING, autoRetry: next, diagnosisStartedAt: null },
    deps,
  );

  if (resumed) {
    const retryItem = buildAutoRetryResumeQueueItem({
      item,
      diagnosis,
      attemptNumber: next.attempts,
      cap: next.cap,
    });
    pushQueueItem(retryItem, queue, deps);
    logDispatchNext(
      `auto-retry resumed key=${ledgerKey} class=${diagnosis.class} attempt=${next.attempts}/${next.cap} run=${item.runId} item=${retryItem.id}`,
    );
    return {
      outcome: LEDGER_OUTCOME_RETRY_PENDING,
      queueItemId: retryItem.id,
      autoRetry: next,
      retryItem,
      resumed: true,
      runId: item.runId,
    };
  }

  const retryItem = buildAutoRetryQueueItem({
    item,
    diagnosis,
    attemptNumber: next.attempts,
    cap: next.cap,
  });
  pushQueueItem(retryItem, queue, deps);
  logDispatchNext(
    `auto-retry queued key=${ledgerKey} class=${diagnosis.class} attempt=${next.attempts}/${next.cap} item=${retryItem.id}${resumeError ? ` resume-fallback=${resumeError}` : ""}`,
  );
  return {
    outcome: LEDGER_OUTCOME_RETRY_PENDING,
    queueItemId: retryItem.id,
    autoRetry: next,
    retryItem,
    resumed: false,
    resumeError,
  };
}

function pushQueueItem(newItem, queue, deps = {}) {
  if (Array.isArray(queue)) {
    queue.push(newItem);
    return;
  }
  const load = deps.load || loadQueue;
  const save = deps.save || saveQueue;
  const current = load();
  current.push(newItem);
  save(current);
}

/** Drop any feedback block a previous auto-retry appended, so they don't stack. */
function stripPriorFeedback(taskText) {
  const idx = String(taskText || "").indexOf(AUTO_RETRY_FEEDBACK_HEADER);
  if (idx < 0) return String(taskText || "");
  return String(taskText).slice(0, idx).replace(/\s+$/, "");
}

/**
 * The run-granularity analogue of {{verify_feedback}}: the diagnosis rides in
 * the queue item's own task text, which `plan` reads in full. No workflow
 * change and no conditional step branching — advancePipeline() is strictly
 * linear by step_index and cannot express one.
 */
function buildAutoRetryQueueItem({ item, diagnosis, attemptNumber, cap }) {
  const baseTask = stripPriorFeedback(item?.task);
  const feedback =
    diagnosis.class === "transient"
      ? ""
      : [
          "",
          "",
          `${AUTO_RETRY_FEEDBACK_HEADER}${attemptNumber + 1} of ${cap + 1} — automatic diagnosis, not a human):`,
          `CLASS: ${diagnosis.class}`,
          `WHAT FAILED: ${diagnosis.reason}`,
          `EVIDENCE: ${diagnosis.evidence}`,
          `DO DIFFERENTLY: ${diagnosis.retry_guidance}`,
        ].join("\n");
  return buildQueueItem({
    task: `${baseTask}${feedback}`,
    repoPath: item?.repoPath,
    source: AUTO_RETRY_SOURCE,
    roadmap_ref: item?.roadmap_ref ?? null,
  });
}

/**
 * TASK-048: what `plan` is told about a branch that already carries work.
 *
 * Why this exists. Roadmap-auto's only guard against re-dispatching an
 * already-attempted task is ledgerBlocksKey() — a STOP, not a resume. Once a
 * human clears the ledger entry (which is the normal, intended way to let a
 * task run again), the next dispatch builds its task text from the ROADMAP
 * item's title + description alone and the plan step sees nothing of the 19
 * commits already sitting on the branch. That is how TASK-025 was planned
 * from scratch three times onto feature/promote-design-preview and how run
 * #43's story S7 came to target apps/web/app/design-preview/{a,c}/workouts/
 * page.tsx — files an earlier attempt's own S13 had already deleted.
 *
 * This is deliberately NOT `workflow resume`. Resume restarts a failed run at
 * its failed step, which for run #43 is story S7 itself — the story whose
 * acceptance criteria cannot be satisfied. It is also gated to
 * AUTO_RETRY_RESUME_CLASSES (transient|fixable), and both of TASK-025's last
 * two failures classified `structural`. Resume would have re-hit the same
 * wall. The defect is in what the PLANNER was told, so the fix is what the
 * planner is told — carried the same way buildAutoRetryQueueItem carries a
 * diagnosis: in the task text, which `plan` reads in full.
 *
 * Returns "" (no preamble, behaviour identical to before) unless the diff
 * actually ran AND reported at least one changed file. `ran:false` is never
 * treated as progress — a branch that does not exist yet is a first attempt.
 */
function buildPriorProgressPreamble({ branch, diff, entry }) {
  if (!diff || diff.ran !== true) return "";
  const files = Array.isArray(diff.files) ? diff.files : [];
  if (files.length === 0) return "";
  const shown = files.slice(0, PRIOR_PROGRESS_FILE_SAMPLE);
  const lines = [
    "",
    "",
    `${PRIOR_PROGRESS_HEADER} (${branch}):`,
    `${branch} already differs from ${EXPECTED_PR_BASE} in ${files.length} file(s).`,
    "This task has been dispatched before; that work is committed and is not yours to redo.",
  ];
  if (entry && entry.runId) {
    lines.push(`Last recorded antfarm run for this task: ${entry.runId}.`);
  }
  lines.push(
    "Plan against the branch's ACTUAL current state, not the task text alone:",
    `  - read the branch first: git log ${EXPECTED_PR_BASE}..${branch} and git diff --stat ${EXPECTED_PR_BASE}...${branch};`,
    "  - do not re-plan work that is already committed there;",
    "  - do not write acceptance criteria against paths an earlier attempt already moved or deleted;",
    "  - if the branch already satisfies this task, say so and plan only what genuinely remains.",
    "Files already changed on the branch:",
    ...shown.map((f) => `  ${f}`),
  );
  if (files.length > shown.length) {
    lines.push(`  ...and ${files.length - shown.length} more`);
  }
  return lines.join("\n");
}

/**
 * Tracker for a resumed run: already dispatched, same run-id, so /queue/check
 * keeps watching it and spawnPendingQueueItem never startRun's a fresh one.
 */
function buildAutoRetryResumeQueueItem({ item, diagnosis, attemptNumber, cap }) {
  const retryItem = buildAutoRetryQueueItem({ item, diagnosis, attemptNumber, cap });
  retryItem.status = "dispatched";
  retryItem.runId = item.runId;
  retryItem.dispatchedAt = new Date().toISOString();
  retryItem.resolvedAt = null;
  retryItem.note = `${AUTO_RETRY_RESUME_NOTE_PREFIX}${item.runId}`;
  if (item.branch) retryItem.branch = item.branch;
  return retryItem;
}

/**
 * Ledger-failure fallback question. Uses the same injectable deps seam as
 * writeParkTodo/handleFailedRunOutcome: reader, writer and repo all resolve
 * through `deps`, so a caller or a test can redirect them. Hardcoding
 * THECOACH_REPO at the call site made this the one append path that could not
 * be stubbed.
 */
function writeLedgerFailureTodo({ ledgerKey, item, run, outcome }, deps = {}) {
  const appendTodo = deps.appendTodo || ((repo, draft) => appendDeveloperTodoEntry(repo, draft, deps));
  const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
  if (!repo && !deps.appendTodo) return { appended: false, reason: "no-thecoach-repo" };
  return appendTodo(repo, {
    summary: `Dispatch of ${ledgerKey} failed (run ${item.runId}); auto-retry handling errored, do not retry until the ledger entry is cleared`,
    why: `The last antfarm run ended runStatus=${run.status} queueStatus=${outcome.status}, and the automatic diagnose-and-retry path itself threw. Re-dispatching unattended would repeat the failure.`,
    source: ledgerKey,
    type: "blocked",
    evidence: item.note || `run ${item.runId}`,
    reply_needed: `Diagnose ${ledgerKey}, then clear coordinator-dispatch-ledger.json[${ledgerKey}] to allow a retry.`,
    blocks: [`task:${ledgerKey}`],
  });
}

/**
 * Park for the developer — same scoped-blocker route refuseProtectedPathScope
 * already uses, so the rest of the queue is provably unaffected. The summary
 * carries the attempt count and class so a second park for the same task is
 * not swallowed by appendDeveloperTodoEntry's open-summary dedup.
 */
function writeParkTodo({ ledgerKey, item, autoRetry, diagnosis, attempt, parkedReason }, deps = {}) {
  try {
    const appendTodo = deps.appendTodo || ((repo, draft) => appendDeveloperTodoEntry(repo, draft, deps));
    const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
    if (!repo && !deps.appendTodo) return { appended: false, reason: "no-thecoach-repo" };
    const runs = autoRetry.attempts + 1;
    const priors = autoRetry.history
      .map((h) => `${h.class}: ${String(h.reason || "").slice(0, 120)}`)
      .join(" | ");
    const why =
      parkedReason === "structural"
        ? `Auto-diagnosis classified this as structural: ${diagnosis.reason} No retry can change that, so no retry attempts were spent.`
        : parkedReason === "cap-reached"
          ? `Auto-diagnosis classified the last attempt as ${diagnosis.class}: ${diagnosis.reason} ${autoRetry.attempts} automatic retries did not change the outcome.`
          : `The automatic diagnosis step could not produce a usable classification (${diagnosis.reason}). The coordinator parked rather than retrying blind.`;
    const written = appendTodo(repo, {
      summary: `Dispatch of ${ledgerKey} failed ${runs}x (1 original + ${autoRetry.attempts} auto-${autoRetry.attempts === 1 ? "retry" : "retries"}); parked — class: ${diagnosis.class} (${parkedReason})`,
      why,
      source: ledgerKey,
      type: "blocked",
      evidence: `run ${item?.runId || "(none)"}; ${diagnosis.evidence || attempt?.evidence || item?.note || "(no evidence captured)"}${priors ? `; prior attempts: ${priors}` : ""}`.slice(0, 1200),
      reply_needed: `Re-scope ${ledgerKey}, or clear coordinator-dispatch-ledger.json[${ledgerKey}] (including autoRetry.attempts) to allow a fresh automatic cycle.`,
      blocks: [`task:${ledgerKey}`],
    });
    if (!written.appended) {
      logDispatchNext(`todo writer skipped duplicate summary for parked ${ledgerKey}`);
    }
    return written;
  } catch (err) {
    logDispatchNextError(`todo writer failed for parked ${ledgerKey}: ${err?.message || String(err)}`);
    return { appended: false, reason: "error" };
  }
}

/**
 * Any `diagnosis-pending` key older than DIAGNOSIS_TTL_MS is treated as a
 * failed diagnosis and parked. This is what stops a killed coordinator from
 * leaving a key wedged in a non-blocking state.
 */
function sweepStaleDiagnoses(deps = {}) {
  const ledger = loadLedger(deps);
  const now = nowMs(deps);
  const swept = [];
  for (const [key, entry] of Object.entries(ledger)) {
    if (!entry || entry.outcome !== LEDGER_OUTCOME_DIAGNOSIS_PENDING) continue;
    const started = Date.parse(entry.diagnosisStartedAt || "");
    if (Number.isFinite(started) && now - started < DIAGNOSIS_TTL_MS) continue;
    const autoRetry = normaliseAutoRetry(entry);
    autoRetry.parked = true;
    autoRetry.parkedReason = "diagnosis-unavailable";
    const diagnosis = unknownDiagnosis(
      `diagnosis did not finish within ${Math.round(DIAGNOSIS_TTL_MS / 60000)} minutes`,
    );
    recordLedgerAttempt(
      key,
      {
        outcome: LEDGER_OUTCOME_FAILED,
        autoRetry,
        diagnosisStartedAt: null,
        cleared: entry.cleared === true,
      },
      deps,
    );
    writeParkTodo(
      {
        ledgerKey: key,
        item: { runId: entry.runId ?? null, note: null },
        autoRetry,
        diagnosis,
        attempt: null,
        parkedReason: "diagnosis-unavailable",
      },
      deps,
    );
    swept.push(key);
    logDispatchNext(`diagnosis-stale-swept key=${key} startedAt=${entry.diagnosisStartedAt ?? "(missing)"}`);
  }
  return swept;
}

/** Background diagnosis. Every failure path here degrades to the park route. */
async function runFailureDiagnosis(ctx, deps = {}) {
  const { ledgerKey } = ctx;
  let diagnosis;
  try {
    const runAgent = deps.runDiagnosisAgent || runDiagnosisAgentTurn;
    const stdout = await runAgent(buildFailureDiagnosisPrompt(ctx));
    const parsed = parseDiagnosisReply(extractAgentReplyText(stdout));
    if (parsed.ok) {
      diagnosis = parsed.diagnosis;
    } else {
      logDispatchNextError(`diagnosis-failed key=${ledgerKey} reason=${parsed.error}`);
      diagnosis = unknownDiagnosis(parsed.error);
    }
  } catch (err) {
    logDispatchNextError(`diagnosis-failed key=${ledgerKey} reason=${err?.message || String(err)}`);
    diagnosis = unknownDiagnosis(err?.message || String(err));
  }
  try {
    return finishFailureHandling({ ...ctx, queue: null, diagnosis }, deps);
  } catch (err) {
    logDispatchNextError(`diagnosis finish failed key=${ledgerKey}: ${err?.message || String(err)}`);
    try {
      const autoRetry = normaliseAutoRetry(loadLedger(deps)[ledgerKey]);
      autoRetry.parked = true;
      autoRetry.parkedReason = "diagnosis-unavailable";
      recordLedgerAttempt(
        ledgerKey,
        { ...(ctx.base || {}), outcome: LEDGER_OUTCOME_FAILED, autoRetry, diagnosisStartedAt: null },
        deps,
      );
    } catch {
      // ledger unavailable — the TTL sweep is the remaining backstop
    }
    return { outcome: LEDGER_OUTCOME_FAILED, parkedReason: "diagnosis-unavailable" };
  }
}

/**
 * Entry point from /queue/check when a run ends failed. Deterministic classes
 * resolve inline; anything ambiguous records a non-blocking
 * `diagnosis-pending` and hands off to a background agent turn — /queue/check
 * loops over every dispatched item and a 105s agent call per failure would
 * blow the ~125s Cloudflare cutoff.
 */
function handleFailedRunOutcome(ctx, deps = {}) {
  const { ledgerKey, item, queue, runStatus, queueStatus, stepsResult } = ctx;
  const ledger = loadLedger(deps);
  const entry = ledger[ledgerKey] || {};
  const autoRetry = normaliseAutoRetry(entry);
  const branch = item?.branch || null;
  const diff = branchDiffDigest(item?.repoPath, branch, deps);
  const attempt = summariseRunFailure({ stepsResult, runStatus, queueStatus, note: item?.note });
  const base = {
    runStatus,
    queueStatus,
    runId: item?.runId ?? null,
    queueItemId: item?.id ?? null,
    outcomeAt: item?.resolvedAt || new Date(nowMs(deps)).toISOString(),
    roadmap_ref: item?.roadmap_ref ?? null,
  };

  const pre = preClassifyRunFailure({ entry, autoRetry, attempt, diff });
  if (pre) {
    logDispatchNext(`auto-retry pre-classified key=${ledgerKey} class=${pre.class} (no agent turn)`);
    return finishFailureHandling(
      { ledgerKey, item, queue, base, autoRetry, attempt, diff, branch, diagnosis: pre, runStatus },
      deps,
    );
  }

  recordLedgerAttempt(
    ledgerKey,
    {
      ...base,
      outcome: LEDGER_OUTCOME_DIAGNOSIS_PENDING,
      diagnosisStartedAt: new Date(nowMs(deps)).toISOString(),
      autoRetry,
    },
    deps,
  );
  const loadContract = deps.loadTaskContract || ((id) => loadTaskContractForId(id, deps));
  let taskMarkdown = null;
  try {
    taskMarkdown = loadContract(ledgerKey)?.markdown ?? null;
  } catch {
    taskMarkdown = null;
  }
  const enqueueBackground = deps.enqueueBackground || defaultEnqueueBackground;
  enqueueBackground(() =>
    runFailureDiagnosis({ ledgerKey, item, base, autoRetry, attempt, diff, branch, taskMarkdown, runStatus }, deps),
  );
  logDispatchNext(`diagnosis-started key=${ledgerKey} run=${item?.runId ?? "(none)"}`);
  return { outcome: LEDGER_OUTCOME_DIAGNOSIS_PENDING };
}

function normaliseBlocks(entry) {
  if (!Array.isArray(entry?.blocks)) {
    logDispatchNext(`schema-violation todo_id=${entry?.id} reason="missing blocks"`);
    return [SCOPE_GLOBAL];
  }
  const canonical = [];
  for (const raw of entry.blocks) {
    const parsed = parseScopeToken(raw);
    if (!parsed.ok) {
      logDispatchNext(
        `schema-violation todo_id=${entry?.id} reason="malformed block" value=${JSON.stringify(raw)}`,
      );
      continue;
    }
    canonical.push(parsed.canonical);
  }
  return canonical;
}

function summarizeOpenTodos(entries) {
  const open = entries.filter((e) => isOpenTodoStatus(e.status));
  // normaliseBlocks logs on schema violations — resolve each entry once.
  const scoped = open.map((e) => ({ entry: e, blocks: normaliseBlocks(e) }));
  const blockedScopes = new Set(scoped.flatMap((x) => x.blocks));
  return {
    open,
    open_count: open.length,
    // Only `*`-blocking TODOs count toward OPEN_QUESTION_CEILING (2026-08-29).
    // Task-scoped ones are already provably non-blocking via the scope
    // machinery, and letting them accumulate toward a global stop meant five
    // auto-written per-task failure notes could halt the whole coordinator.
    // A malformed `blocks` normalises to ["*"] and still counts — fail safe.
    global_open_count: scoped.filter((x) => x.blocks.includes(SCOPE_GLOBAL)).length,
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
  const fingerprint = normalizeQuestionFingerprint(draft);
  if (open.some((e) => normalizeQuestionFingerprint(e) === fingerprint)) {
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
    if (
      reason === "active-run" ||
      reason === "developer-attention-required" ||
      reason === "scan-started" ||
      reason === "scan-in-progress"
    ) {
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
    if (
      reason === "nothing-dispatchable" ||
      reason === "scan-errored" ||
      reason === "queue-item-rejected" ||
      // 8-P1: a ledger-blocked stall used to be invisible to the idle
      // escalator, so the one stall mode that most needed surfacing never
      // incremented consecutive_idle and never hit IDLE_ESCALATION_EVERY.
      reason === "ledger-blocked"
    ) {
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

function evaluateDispatchBackstop(scopes, blockedScopes, roadmapRef, roadmapText, decision, deps = {}) {
  const blockedRaw = blockedScopes instanceof Set ? [...blockedScopes] : [...(blockedScopes || [])];
  const blocked = new Set();
  for (const raw of blockedRaw) {
    const parsed = parseScopeToken(typeof raw === "string" ? raw : String(raw ?? ""));
    if (parsed.ok) blocked.add(parsed.canonical);
  }

  const listed = parseScopeList(scopes, { allowEmpty: false });
  if (!listed.ok) {
    const reason =
      listed.reason === "not-array" || listed.reason === "missing-or-empty-scopes"
        ? "missing-or-empty-scopes"
        : "malformed-scope";
    return { ok: false, reason, scopes: scopes ?? null, blocked: [...blocked], detail: listed };
  }

  const headings = collectRoadmapPhaseHeadings(roadmapText, deps);
  // Only the sprint scope the planner asserts is checked against the roadmap's
  // own headings; task:/oq:/* scopes have nothing to agree with. A `phase:`
  // scope is never derived any more and no live heading can match one, so an
  // asserted `phase:` is caught below as unknown rather than silently ignored.
  const assertedPhases = listed.canonical.filter(
    (s) => s.startsWith("sprint:") || s.startsWith("phase:"),
  );
  for (const phaseScope of assertedPhases) {
    if (!headings.some((h) => h.scope === phaseScope)) {
      return {
        ok: false,
        reason: "unknown-phase",
        scopes: listed.canonical,
        asserted: assertedPhases,
        unknown: phaseScope,
        blocked: [...blocked],
      };
    }
  }

  const refPhase =
    typeof roadmapRef === "string" && roadmapRef.trim() ? derivePhaseScopeFromRoadmapRef(roadmapRef) : null;
  if (typeof roadmapRef === "string" && roadmapRef.trim()) {
    if (!refPhase) {
      return {
        ok: false,
        reason: "underivable-phase",
        scopes: listed.canonical,
        derived: null,
        assertedPhases,
        blocked: [...blocked],
      };
    }
    if (!headings.some((h) => h.scope === refPhase)) {
      return {
        ok: false,
        reason: "unknown-phase",
        scopes: listed.canonical,
        derived: refPhase,
        asserted: assertedPhases,
        unknown: refPhase,
        blocked: [...blocked],
      };
    }
  }

  const located = locateDispatchInRoadmap(
    roadmapText,
    decision || { title: "", description: "", roadmap_ref: roadmapRef },
    deps,
  );
  if (!located.ok) {
    return {
      ok: false,
      reason: located.reason,
      scopes: listed.canonical,
      derived: located.filePhase ?? null,
      asserted: assertedPhases,
      blocked: [...blocked],
      taskId: located.taskId ?? null,
    };
  }

  const filePhase = located.filePhase;
  if (assertedPhases.length > 0 && !assertedPhases.includes(filePhase)) {
    logDispatchNext(
      `backstop-phase-disagreement derived=${JSON.stringify(filePhase)} asserted=${JSON.stringify(assertedPhases)}`,
    );
    return {
      ok: false,
      reason: "phase-disagreement",
      derived: filePhase,
      asserted: assertedPhases,
      scopes: listed.canonical,
      blocked: [...blocked],
      taskId: located.taskId,
    };
  }
  if (refPhase && refPhase !== filePhase) {
    logDispatchNext(
      `backstop-phase-disagreement derived=${JSON.stringify(filePhase)} asserted=${JSON.stringify([refPhase])}`,
    );
    return {
      ok: false,
      reason: "phase-disagreement",
      derived: filePhase,
      asserted: [refPhase, ...assertedPhases],
      scopes: listed.canonical,
      blocked: [...blocked],
      taskId: located.taskId,
    };
  }

  let scopesForCompare = listed.canonical;
  if (assertedPhases.length === 0) {
    scopesForCompare = [...listed.canonical, filePhase];
  }

  const intersection = scopesForCompare.filter((s) => blocked.has(s) || blocked.has(SCOPE_GLOBAL));
  if (intersection.length > 0) {
    return {
      ok: false,
      reason: "intersects-blocked",
      scopes: scopesForCompare,
      blocked: [...blocked],
      intersection,
      taskId: located.taskId,
    };
  }
  return {
    ok: true,
    scopes: scopesForCompare,
    blocked: [...blocked],
    taskId: located.taskId,
    derived: filePhase,
  };
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
async function waitForAntfarmRunId(taskText, { timeoutMs = WAIT_FOR_RUN_TIMEOUT_MS, intervalMs = 250, since = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(ANTFARM_DB)) {
      const db = new DatabaseSync(ANTFARM_DB, { readOnly: true });
      try {
        // `since` anchors resolution to the caller's own dispatch. Task text is
        // not unique — an auto-retry re-dispatches byte-identical text — so
        // without the lower bound a prior run satisfies this query on the first
        // poll and the caller records the OLD run's id. That is how run #38 was
        // orphaned on 2026-08-30: queue item b4d46cf269ff recorded run #37's id
        // and was then marked failed from #37's terminal state while #38 ran on.
        const row = since
          ? db
              .prepare(
                `SELECT id, status, run_number FROM runs
                 WHERE workflow_id = ? AND task = ? AND created_at >= ?
                 ORDER BY created_at DESC LIMIT 1`,
              )
              .get(DEFAULT_WORKFLOW, taskText, since)
          : db
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
  for (const fn of stagingFetchObservers) fn(repoPath);
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repoPath, "fetch", "origin"], { timeout: GIT_FETCH_TIMEOUT_MS }, (fetchErr, _o, fetchStderr) => {
      if (fetchErr) {
        return reject(new Error(`git fetch origin failed: ${fetchErr.message}${fetchStderr ? ` — ${fetchStderr}` : ""}`));
      }
      execFile("git", ["-C", repoPath, "rev-parse", "origin/staging"], { timeout: GIT_REVPARSE_TIMEOUT_MS }, (rpErr, stdout, rpStderr) => {
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

Dispatchable work lives ONLY under a \`## Sprint NN - <flow>\` heading, in its
unchecked \`- [ ] ... (TASK-nnn)\` lines. Those lines are the binding task list,
written at Sprint Start.

Everything else in ROADMAP.md is planning, not a commitment, and nothing under
it is dispatchable no matter how ready it reads:
- \`### Planned sprints\` - a numbered list of intended sprints.
- \`### On the map, order not set\`, \`### Task placement\`, \`### Backlog\` - prose
  and tables. No checkboxes, and a task id appearing there does not place it in
  a sprint.
- \`### Sprint entry template\` - a blank template. Its \`## Sprint NN\` line and
  its \`- [ ] <short description> (TASK-nnn)\` line are placeholders, never work.
- Any \`## Before <date>\` section - history.

Scope grammar (for both dispatch "scopes" and record-question "blocks"):
- sprint:<id>  e.g. sprint:1a, sprint:01 - must name a real \`## Sprint NN\` heading
- oq:<id>      e.g. oq:OQ-12
- task:TASK-<n> e.g. task:TASK-033
- *            blocks everything (use only when the question truly gates all work)
- []           (record-question only) the question needs an answer but gates no dispatchable work

Reply with ONLY one JSON object, nothing else — no prose before or after, no markdown fences, no trailing commentary. Exactly one of these three shapes:

{"decision":"dispatch","title":"<short task title>","description":"<what to build, specific enough for a dev agent to act on without more context>","roadmap_ref":"<which sprint/line this came from, quoted or closely paraphrased>","scopes":["sprint:<id>"]}

{"decision":"record-question","summary":"<one line>","why":"<why this needs a human>","source":"<TASK-NNN or roadmap:SprintNN>","type":"roadmap-decision","evidence":"<short evidence>","reply_needed":"<what answer resolves this>","blocks":["sprint:<id>"]}

{"decision":"nothing-to-do"}

Rules:
- "dispatch" is only correct for work that is well-defined AND already decided — no open product/design choice, no explicit "deferred"/"blocked on"/"needs sign-off" language in the roadmap text itself.
- Every dispatch MUST include a non-empty "scopes" array naming what the work belongs to (sprint, oq, and/or task). The sprint you name must be a \`## Sprint NN\` heading that actually exists in the file below. Never dispatch work whose scopes intersect the exclusion list.
- You MAY skip a blocked/deferred roadmap checkbox and continue looking for the next actionable item under a \`## Sprint NN\` heading whose scopes are outside the exclusion list. If the next well-defined item is blocked by the exclusion list, skip it and keep looking.
- Do not return needs-developer-decision — that decision is retired. If you find a question that needs a developer answer, return record-question with an explicitly-reasoned "blocks" array: what specifically does this gate — which sprint, which open question, which task? If it gates no dispatchable work, answer with an empty list.
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
    if (Object.prototype.hasOwnProperty.call(parsed, "scopes")) {
      const scopesCheck = parseScopeList(parsed.scopes, { allowEmpty: false });
      if (!scopesCheck.ok) {
        return { ok: false, error: `dispatch scopes invalid: ${scopesCheck.reason}` };
      }
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
    const blocksCheck = parseScopeList(parsed.blocks, { allowEmpty: true });
    if (!blocksCheck.ok) {
      return { ok: false, error: `record-question blocks invalid: ${blocksCheck.reason}` };
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
  return runOpenClawAgentTurn({
    prompt,
    agentId: PLANNER_AGENT_ID,
    model: PLANNER_MODEL,
    filePrefix: "coordinator-roadmap-scan",
    sessionPrefix: "roadmap-scan",
  });
}

/**
 * Item 8's diagnosis turn — the same fully-automated primitive the roadmap
 * scan uses (`openclaw agent --json`), no human in the loop.
 */
function runDiagnosisAgentTurn(prompt) {
  return runOpenClawAgentTurn({
    prompt,
    agentId: DIAGNOSIS_AGENT_ID,
    model: DIAGNOSIS_MODEL,
    filePrefix: "coordinator-failure-diagnosis",
    sessionPrefix: "failure-diagnosis",
  });
}

function runOpenClawAgentTurn({ prompt, agentId, model, filePrefix, sessionPrefix }) {
  const tmpFile = path.join(
    os.tmpdir(),
    `${filePrefix}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.txt`,
  );
  const sessionKey = `${sessionPrefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmpFile, prompt, "utf-8");
  return new Promise((resolve, reject) => {
    execFile(
      "openclaw",
      [
        "agent",
        "--agent",
        agentId,
        "--session-key",
        sessionKey,
        "--model",
        model,
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

  if ((snapshot.global_open_count ?? snapshot.open_count) >= OPEN_QUESTION_CEILING) {
    return { outcome: "developer-attention-required", ...snapshotFields };
  }

  if (snapshot.blockedScopes.has(SCOPE_GLOBAL)) {
    const offending = snapshot.open.filter((e) => normaliseBlocks(e).includes(SCOPE_GLOBAL)).map((e) => e.id);
    return { outcome: "nothing-dispatchable", ...snapshotFields, offending_ids: offending };
  }

  const roadmap = readRoadmap(thecoachRepo);
  try {
    collectRoadmapPhaseHeadings(roadmap, deps);
  } catch (err) {
    if (err?.reason === "roadmap-parse-timeout") {
      return {
        outcome: "developer-attention-required",
        ...snapshotFields,
        failReason: err.message,
        backstop_reason: "roadmap-parse-timeout",
      };
    }
    throw err;
  }

  const loadContract = deps.loadTaskContract || ((id) => loadTaskContractForId(id, { ...deps, thecoachRepo }));
  const maskedRoadmap = maskManualDispatchRoadmap(roadmap, (taskId) => {
    const loaded = loadContract(taskId);
    if (loaded?.missing) return "auto";
    if (loaded?.dispatchUnknown) {
      logDispatchNext(
        `warning: ${taskId} ## Dispatch has unknown value ${JSON.stringify(loaded.dispatchValue)}; treating as manual`,
      );
    }
    return loaded?.dispatch === "manual" ? "manual" : "auto";
  });

  let parsed;
  try {
    const prompt = buildRoadmapScanPrompt(maskedRoadmap, todoRaw, snapshot.blockedScopes);
    const cliStdout = await runAgent(prompt);
    const replyText = extractAgentReplyText(cliStdout);
    parsed = parseAgentDecision(replyText);
    if (!parsed.ok) {
      return {
        outcome: "developer-attention-required",
        ...snapshotFields,
        failReason: parsed.error,
        backstop_reason: "agent-unparseable",
      };
    }
  } catch (err) {
    const reason = err?.reason === "roadmap-parse-timeout" ? "roadmap-parse-timeout" : "agent-unparseable";
    return {
      outcome: "developer-attention-required",
      ...snapshotFields,
      failReason: err?.message || String(err),
      backstop_reason: reason,
    };
  }

  if (parsed.decision.decision === "dispatch") {
    let backstop;
    try {
      backstop = evaluateDispatchBackstop(
        parsed.decision.scopes,
        snapshot.blockedScopes,
        parsed.decision.roadmap_ref,
        roadmap,
        parsed.decision,
        deps,
      );
    } catch (err) {
      if (err?.reason === "roadmap-parse-timeout") {
        return {
          outcome: "developer-attention-required",
          ...snapshotFields,
          failReason: err.message,
          backstop_reason: "roadmap-parse-timeout",
        };
      }
      throw err;
    }
    if (!backstop.ok) {
      logDispatchNext(
        `backstop-rejected-dispatch reason=${backstop.reason} scopes=${JSON.stringify(parsed.decision.scopes)} derived=${JSON.stringify(backstop.derived ?? null)} asserted=${JSON.stringify(backstop.asserted ?? backstop.assertedPhases ?? null)} blocked=${JSON.stringify([...snapshot.blockedScopes])}`,
      );
      return { outcome: "nothing-dispatchable", ...snapshotFields, backstop_rejected: true, backstop_reason: backstop.reason };
    }
    const ledgerKey = backstop.taskId;
    if (!ledgerKey) {
      logDispatchNext("backstop-rejected-dispatch reason=item-unlocatable (no TASK-NNN in roadmap)");
      return {
        outcome: "nothing-dispatchable",
        ...snapshotFields,
        backstop_rejected: true,
        backstop_reason: "item-unlocatable",
      };
    }
    const ledger = loadLedger(deps);
    if (ledgerBlocksKey(ledger, ledgerKey)) {
      logDispatchNext(`ledger-blocked-redispatch key=${ledgerKey}`);
      try {
        const written = appendTodo(thecoachRepo, {
          summary: `Dispatch of ${ledgerKey} already failed; do not retry until the ledger entry is cleared`,
          why: `Last attempt recorded outcome=failed in the dispatch ledger. Re-dispatching would repeat the same failure.`,
          source: ledgerKey,
          type: "blocked",
          evidence: `coordinator-dispatch-ledger.json key=${ledgerKey}`,
          reply_needed: `Clear the ledger entry for ${ledgerKey} after diagnosing the failure, or leave it blocked.`,
          blocks: [`task:${ledgerKey}`],
        });
        if (!written.appended) {
          logDispatchNext(`todo writer skipped duplicate summary for ledger-blocked ${ledgerKey}`);
        }
      } catch (err) {
        logDispatchNextError(`todo writer failed for ledger-blocked ${ledgerKey}: ${err?.message || String(err)}`);
      }
      return { outcome: "nothing-dispatchable", ...snapshotFields, ledger_blocked: ledgerKey };
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
  try {
    return readRequiredTodoSnapshot(deps);
  } catch (err) {
    logDispatchNextError(`todo snapshot failed (swallowed): ${err?.message || String(err)}`);
    return { open_count: 0, global_open_count: 0, todo_ids: [], blockedScopes: new Set() };
  }
}

function readRequiredTodoSnapshot(deps = {}) {
  const readTodo = deps.readTodo || readDeveloperTodoFile;
  const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
  if (!deps.readTodo && !repo) {
    throw new Error("COORDINATOR_THECOACH_REPO is unset");
  }
  return summarizeOpenTodos(parseDeveloperTodoEntries(readTodo(repo)));
}

function buildQueuedTaskText({ repoPath, branch, task }) {
  return `REPO: ${repoPath}\nBRANCH: ${branch}\n\n${task}`;
}

function finishScanErrored(scanId, error, snapshot, deps) {
  const body = withIdleTelemetry(
    {
      ok: false,
      dispatched: false,
      reason: "scan-errored",
      error: typeof error === "string" ? error : error?.message || String(error),
      ...(snapshot || {}),
    },
    deps,
  );
  finishScanState(
    scanId,
    {
      dispatched: false,
      reason: "scan-errored",
      error: body.error,
      escalated: body.escalated === true,
      ...(snapshot || {}),
    },
    deps,
  );
  return body;
}

function publicScanState(deps = {}) {
  const state = loadScanState(deps);
  if (!state) {
    return { ok: true, scan: null, backstop_reason: null };
  }
  return {
    ok: true,
    scan: state,
    backstop_reason: state.outcome?.backstop_reason ?? state.previousOutcome?.backstop_reason ?? null,
    scan_status: state.status ?? null,
    last_scan_reason: state.outcome?.reason ?? state.previousOutcome?.reason ?? null,
  };
}

function finishScanState(scanId, outcome, deps) {
  const current = loadScanState(deps);
  if (!current || current.scanId !== scanId) return;
  saveScanState(
    {
      ...current,
      status: outcome.error ? "errored" : "completed",
      finishedAt: new Date(nowMs(deps)).toISOString(),
      outcome,
    },
    deps,
  );
}

/**
 * Git-fetch + spawn for a pending queue item. Used by the occupied-queue
 * path (inline) and by the background scan after it enqueues. Consults the
 * dispatch ledger before spawning so a failed last attempt blocks the
 * human-queued path the same way it blocks roadmap-scan.
 */
async function spawnPendingQueueItem(queue, idx, deps = {}) {
  const save = deps.save || saveQueue;
  const repoExists = deps.repoExists || ((p) => fs.existsSync(p));
  const fetchStaging = deps.fetchStaging || fetchOriginStagingTip;
  const startRun = deps.startRun || startWorkflowRun;
  const waitRun = deps.waitRun || waitForAntfarmRunId;
  const item = queue[idx];

  const ledgerKey = resolveQueueItemTaskId(item, deps);
  if (!ledgerKey) {
    item.status = "flagged";
    item.resolvedAt = new Date().toISOString();
    item.note = "unledgerable dispatch: no TASK-NNN; parked so the queue can advance";
    save(queue);
    try {
      const appendTodo = deps.appendTodo || ((repo, draft) => appendDeveloperTodoEntry(repo, draft, deps));
      const repo = deps.thecoachRepo !== undefined ? deps.thecoachRepo : THECOACH_REPO;
      if (repo || deps.appendTodo) {
        const written = appendTodo(repo, {
          summary: `Queue item ${item.id} has no TASK-NNN and cannot be dispatched`,
          why: "An item with no stable identity cannot be ledgered; leaving it pending blocked all later work.",
          source: `queue:${item.id}`,
          type: "blocked",
          evidence: String(item.task || "(empty task)"),
          reply_needed: `Remove or rewrite queue item ${item.id} with a TASK-NNN, or delete it from the queue.`,
          blocks: [],
        });
        if (!written.appended) {
          logDispatchNext(`todo writer skipped duplicate summary for unledgerable queue item ${item.id}`);
        }
      }
    } catch (err) {
      logDispatchNextError(`todo writer failed for unledgerable queue item ${item.id}: ${err?.message || String(err)}`);
    }
    const nextIdx = queue.findIndex((it) => it.status === "pending");
    if (nextIdx >= 0) {
      return spawnPendingQueueItem(queue, nextIdx, deps);
    }
    return {
      status: 200,
      body: withIdleTelemetry(
        {
          ok: true,
          dispatched: false,
          reason: "queue-item-rejected",
          queueItemId: item.id,
        },
        deps,
      ),
    };
  }
  if (ledgerBlocksKey(loadLedger(deps), ledgerKey)) {
    logDispatchNext(`ledger-blocked-redispatch key=${ledgerKey} path=queue`);
    // 8-P1 (2026-08-29): this used to return with the item still `pending`,
    // unlike every sibling refusal path in this function. handleDispatchNext
    // only reaches the roadmap scan when NO pending item exists, so one
    // ledger-blocked item halted the entire coordinator — every other queue
    // item and the scan with it — and applyIdleTelemetry did not count the
    // reason, so the stall was silent. Park it and advance, like the
    // unledgerable branch above. No TODO: the failure that set
    // outcome:"failed" already wrote one for this key by construction.
    item.status = "flagged";
    item.resolvedAt = new Date().toISOString();
    item.note = "ledger-blocked; parked so the queue can advance";
    save(queue);
    const blockedNextIdx = queue.findIndex((it) => it.status === "pending");
    if (blockedNextIdx >= 0) {
      return spawnPendingQueueItem(queue, blockedNextIdx, deps);
    }
    return {
      status: 200,
      body: withIdleTelemetry(
        {
          ok: true,
          dispatched: false,
          reason: "ledger-blocked",
          ledger_blocked: ledgerKey,
          queueItemId: item.id,
        },
        deps,
      ),
    };
  }

  const loadContract = deps.loadTaskContract || ((id) => loadTaskContractForId(id, deps));
  const contract = loadContract(ledgerKey);
  const gates = evaluateHostDispatchGates(ledgerKey, contract);

  // TASK-044: the checkout itself is unreadable. Nothing about this item — or
  // any other queued item — is knowable, so refuse here and return, rather
  // than falling through to flagTaskContractRefusal(), which would park this
  // item and then recurse into every remaining pending item and repeat the
  // same failure once per item. One loud line, one TODO attempt, one refusal.
  // The item stays `pending`: the repo path is an operator misconfiguration,
  // not a defect in the task, and it must dispatch normally once fixed.
  if (gates.reason === THECOACH_REPO_UNREADABLE) {
    return refuseUnreadableTheCoachRepo(item, deps, ledgerKey, contract);
  }

  if (gates.reason === "not-dispatchable-manual") {
    logDispatchNext(`task-dispatch-manual key=${ledgerKey}`);
    return skipManualDispatchItem(queue, item, deps, ledgerKey);
  }
  if (gates.reason === "unsupported-tool") {
    logDispatchNext(`task-contract-refused key=${ledgerKey} field=Tool/model value=${gates.contract_value}`);
    return flagTaskContractRefusal(queue, item, deps, {
      taskId: ledgerKey,
      field: "Tool/model",
      reason: "unsupported-tool",
      value: gates.contract_value,
      note: `${ledgerKey} ## Tool/model is ${gates.contract_value}; coordinator dispatches Cursor only and will not substitute. Run this task by hand with ${gates.contract_value}.`,
      why: `The coordinator has no ${gates.contract_value} dispatch route. Silently substituting ${DISPATCHABLE_TOOL} would send this work to the wrong tool.`,
      replyNeeded: `Run ${ledgerKey} by hand with ${gates.contract_value}, or change ## Tool/model if that routing was wrong.`,
    });
  }
  if (gates.contract_field === "Status") {
    logDispatchNext(`task-contract-refused key=${ledgerKey} field=Status reason=${gates.reason}`);
    return flagTaskContractRefusal(queue, item, deps, {
      taskId: ledgerKey,
      field: "Status",
      reason: gates.reason,
      value: gates.contract_value,
      note: `${ledgerKey} ## Status is not Ready (${gates.reason}: ${gates.contract_value ?? "unreadable"}). Will not dispatch.`,
      why: "The task file's ## Status is the contract; the roadmap checkbox does not override it. Dispatching a blocked or finished task wastes a run and can land work out of order.",
      replyNeeded: `Set ${ledgerKey} ## Status to Ready once its blocker clears, or take the item off the roadmap.`,
    });
  }
  if (gates.reason === "unsupported-base" || String(gates.reason || "").startsWith("base-")) {
    logDispatchNext(`task-contract-refused key=${ledgerKey} field=Branch reason=${gates.reason} value=${gates.contract_value}`);
    return flagTaskContractRefusal(queue, item, deps, {
      taskId: ledgerKey,
      field: "Branch",
      reason: gates.reason,
      value: gates.contract_value,
      note: `${ledgerKey} ## Branch base is ${gates.contract_value ?? "unreadable"} (${gates.reason}); the workflow can only cut from ${DISPATCHABLE_BASE} and will not substitute it.`,
      why: `Setup cuts every run from ${DISPATCHABLE_BASE}. Dispatching a task that names a different base silently builds on the wrong code — that is what failed antfarm run #17.`,
      replyNeeded: `Rewrite ${ledgerKey} ## Branch to cut from ${DISPATCHABLE_BASE}, or run it by hand on the base it names.`,
    });
  }
  if (gates.reason === "protected-path-scope") {
    logDispatchNext(`protected-path-scope key=${ledgerKey} matches=${JSON.stringify(gates.matches)}`);
    return refuseProtectedPathScope(queue, item, deps, ledgerKey, gates.matches);
  }
  if (gates.dispatched !== true) {
    logDispatchNext(`task-contract-refused key=${ledgerKey} field=${gates.contract_field} reason=${gates.reason}`);
    return flagTaskContractRefusal(queue, item, deps, {
      taskId: ledgerKey,
      field: gates.contract_field || "task-file",
      reason: gates.reason,
      value: gates.contract_value || (Array.isArray(contract.files) ? contract.files.join(",") : undefined),
      note: `${ledgerKey} ## ${gates.contract_field || "task-file"} refused (${gates.reason}${gates.contract_value ? `: ${gates.contract_value}` : ""}). Will not dispatch.`,
    });
  }

  const branch = contract.ok ? contract.branch : hardcodedCoordinatorBranch(item.id);

  // Item 7 (2026-08-29): catch the repeated-empty-diff pattern on attempt 2
  // rather than waiting for Item 8's post-run classifier to catch attempt 3.
  // Only fires on a CONFIRMED empty diff plus a prior empty-diff attempt —
  // an empty diff on its own is a legitimate outcome for a review task, and a
  // diff that could not be computed (branch not cut yet) is never "empty".
  // One ledger read and at most one branch diff now serve both the Item 7
  // repeated-empty-diff park below and TASK-048's prior-progress preamble.
  //
  // The diff is computed only when a ledger ENTRY exists, i.e. this task has
  // been dispatched before. That gate is deliberate and is the one signal that
  // survives a ledger clear: clearing sets cleared:true and resets the
  // autoRetry sub-object (attempts/history), but the entry itself — and its
  // runId — persists, because recordLedgerAttempt merges. Keying on
  // autoRetry.history would have missed TASK-025 run #43 exactly: its history
  // had just been reset to [] by the 2026-09-01 clear. A first-ever dispatch
  // has no entry, makes no git call, and plans fresh — unchanged behaviour.
  const ledgerEntry = loadLedger(deps)[ledgerKey] || null;
  const priorAuto = normaliseAutoRetry(ledgerEntry);
  const branchState = ledgerEntry
    ? branchDiffDigest(item.repoPath, branch, deps)
    : { ran: false, digest: null, files: [], error: "no prior dispatch" };

  if (priorAuto.history.some((h) => h.diffHash === EMPTY_DIFF_DIGEST)) {
    if (branchState.ran && branchState.digest === EMPTY_DIFF_DIGEST) {
      logDispatchNext(`repeated-empty-diff key=${ledgerKey} branch=${branch}`);
      return parkRepeatedEmptyDiff(queue, item, deps, ledgerKey, branch, priorAuto);
    }
  }

  if (!repoExists(item.repoPath)) {
    return { status: 400, body: { ok: false, error: `repoPath does not exist: ${item.repoPath}` } };
  }

  let stagingTip;
  try {
    stagingTip = await fetchStaging(item.repoPath);
  } catch (err) {
    return { status: 500, body: { ok: false, error: err?.message || String(err) } };
  }

  // TASK-048. Appended to the DISPATCHED text only, never written back into
  // item.task — so it cannot stack across retries the way an auto-retry
  // feedback block can, and the queue item keeps the text a human would read.
  const priorProgress = buildPriorProgressPreamble({
    branch,
    diff: branchState,
    entry: ledgerEntry,
  });
  if (priorProgress) {
    logDispatchNext(
      `prior-progress-preamble key=${ledgerKey} branch=${branch} files=${branchState.files.length}`,
    );
  }

  const taskText = buildQueuedTaskText({
    repoPath: item.repoPath,
    branch,
    task: `${item.task}${priorProgress}`,
  });

  // Captured before the spawn so the run this dispatch creates is always at or
  // after it. 1s of slack absorbs clock jitter between this process and the
  // antfarm CLI that writes the row; a stale prior run is hours older, never
  // seconds, so the slack cannot re-admit one.
  const dispatchSince = new Date(Date.now() - 1000).toISOString();

  let spawnResult;
  try {
    spawnResult = startRun({ workflow: DEFAULT_WORKFLOW, task: taskText });
  } catch (err) {
    return { status: 500, body: { ok: false, error: err?.message || String(err) } };
  }

  const antfarmRun = await waitRun(taskText, { since: dispatchSince });
  if (!antfarmRun) {
    recordLedgerAttempt(
      ledgerKey,
      {
        lastDispatchedAt: new Date().toISOString(),
        queueItemId: item.id,
        outcome: "failed",
        reason: "spawn-timeout-504",
        roadmap_ref: item.roadmap_ref ?? null,
      },
      deps,
    );
    return {
      status: 504,
      body: {
        ok: false,
        error: "workflow spawn started but antfarm run id not observed in DB within timeout",
        spawnLogId: spawnResult.id,
        logPath: spawnResult.logPath,
        stagingTip,
        branch,
        ledger_key: ledgerKey,
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

  recordLedgerAttempt(
    ledgerKey,
    {
      lastDispatchedAt: item.dispatchedAt,
      runId: antfarmRun.id,
      queueItemId: item.id,
      outcome: "dispatched",
      roadmap_ref: item.roadmap_ref ?? null,
    },
    deps,
  );

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

async function runBackgroundScanAndDispatch(deps, scanId) {
  const findActive = deps.findActive || findActiveThecoachRun;
  const load = deps.load || loadQueue;
  const save = deps.save || saveQueue;
  const scan = deps.scan || ((scanDeps) => scanRoadmapForWork(scanDeps));

  try {
    let scanResult;
    try {
      scanResult = await scan(deps);
    } catch (err) {
      logDispatchNextError(`background roadmap scan failed: ${err?.message || String(err)}`);
      finishScanErrored(scanId, err, {}, deps);
      return;
    }

    const snapshot = {
      open_count: scanResult.open_count ?? 0,
      todo_ids: scanResult.todo_ids ?? [],
    };

    if (scanResult.outcome === "dispatch") {
      const active = findActive();
      if (active) {
        finishScanState(
          scanId,
          {
            dispatched: false,
            reason: "active-run",
            activeRunId: active.id,
            ...snapshot,
          },
          deps,
        );
        return;
      }
      const d = scanResult.decision;
      const autoItem = buildQueueItem({
        task: `${d.title}\n\n${d.description}`,
        repoPath: DEFAULT_QUEUE_REPO_PATH,
        source: ROADMAP_AUTO_SOURCE,
        roadmap_ref: d.roadmap_ref,
      });
      const queue = load();
      queue.push(autoItem);
      save(queue);
      logDispatchNext(`roadmap auto-queued ${autoItem.id} ref=${d.roadmap_ref}`);
      const spawned = await spawnPendingQueueItem(queue, queue.length - 1, deps);
      const hostRefusalReasons = new Set([
        "not-dispatchable-manual",
        "protected-path-scope",
        "queue-item-rejected",
        "ledger-blocked",
      ]);
      if (spawned.status === 200 && spawned.body?.dispatched !== true && hostRefusalReasons.has(spawned.body?.reason)) {
        finishScanState(
          scanId,
          {
            dispatched: false,
            reason: spawned.body.reason,
            task: spawned.body.task ?? null,
            matches: spawned.body.matches ?? null,
            ...snapshot,
          },
          deps,
        );
        return;
      }
      if (spawned.status !== 200 || spawned.body?.dispatched !== true) {
        finishScanErrored(
          scanId,
          spawned.body?.error || `spawn status ${spawned.status}`,
          snapshot,
          deps,
        );
        return;
      }
      finishScanState(
        scanId,
        {
          dispatched: true,
          reason: "dispatched",
          runId: spawned.body.runId,
          queueItemId: spawned.body.item?.id,
          ...snapshot,
        },
        deps,
      );
      return;
    }

    if (scanResult.outcome === "developer-attention-required") {
      finishScanState(
        scanId,
        {
          dispatched: false,
          reason: "developer-attention-required",
          backstop_reason: scanResult.backstop_reason ?? null,
          failReason: scanResult.failReason ?? null,
          ...snapshot,
        },
        deps,
      );
      return;
    }

    if (scanResult.failReason) {
      logDispatchNextError(`roadmap scan agent/parse failed; nothing-dispatchable: ${scanResult.failReason}`);
    }
    const idleBody = withIdleTelemetry(
      attachOpenSnapshot(
        {
          ok: true,
          dispatched: false,
          reason: "nothing-dispatchable",
          backstop_reason: scanResult.backstop_reason ?? null,
          ...(scanResult.backstop_rejected ? { backstop_rejected: true } : {}),
          ...(scanResult.ledger_blocked ? { ledger_blocked: scanResult.ledger_blocked } : {}),
        },
        snapshot,
      ),
      deps,
    );
    finishScanState(
      scanId,
      {
        dispatched: false,
        reason: "nothing-dispatchable",
        backstop_rejected: Boolean(scanResult.backstop_rejected),
        backstop_reason: scanResult.backstop_reason ?? null,
        ledger_blocked: scanResult.ledger_blocked ?? null,
        failReason: scanResult.failReason ?? null,
        escalated: idleBody.escalated === true,
        ...snapshot,
      },
      deps,
    );
  } catch (err) {
    logDispatchNextError(`background scan unhandled: ${err?.message || String(err)}`);
    finishScanErrored(scanId, err, {}, deps);
  }
}

/**
 * Core of POST /queue/dispatch-next. Injectors exist so --self-test-roadmap-scan
 * can cover empty-queue scan outcomes without spawning a real workflow.
 *
 * Cheap deterministic checks (active-run, occupied queue, ceiling, *) stay
 * inline. The agent-backed roadmap scan is started in the background and this
 * request returns reason=scan-started (or scan-in-progress).
 */
async function handleDispatchNext(deps = {}) {
  const findActive = deps.findActive || findActiveThecoachRun;
  const load = deps.load || loadQueue;
  const enqueueBackground = deps.enqueueBackground || defaultEnqueueBackground;

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

  const queue = load();
  const idx = queue.findIndex((it) => it.status === "pending");
  if (idx >= 0) {
    return spawnPendingQueueItem(queue, idx, deps);
  }

  const now = nowMs(deps);
  const existing = loadScanState(deps);
  if (isScanLockActive(existing, now)) {
    return {
      status: 200,
      body: attachOpenSnapshot(
        {
          ok: true,
          dispatched: false,
          reason: "scan-in-progress",
          scanId: existing.scanId,
          backstop_reason: existing.outcome?.backstop_reason ?? existing.previousOutcome?.backstop_reason ?? null,
          last_scan_reason: existing.outcome?.reason ?? existing.previousOutcome?.reason ?? null,
        },
        {
          open_count: existing.open_count ?? 0,
          todo_ids: existing.todo_ids ?? [],
        },
      ),
    };
  }

  let snapshot;
  try {
    snapshot = readRequiredTodoSnapshot(deps);
  } catch (err) {
    logDispatchNextError(`roadmap scan failed: ${err?.message || String(err)}`);
    return { status: 500, body: { ok: false, error: err?.message || String(err) } };
  }

  // A `diagnosis-pending` key that outlived its TTL is parked here too, not
  // only in /queue/check, so a wedged key cannot survive on the dispatch path.
  try {
    sweepStaleDiagnoses(deps);
  } catch (err) {
    logDispatchNextError(`stale-diagnosis sweep failed (swallowed): ${err?.message || String(err)}`);
  }

  // Only `*`-blocking TODOs count toward the global stop (2026-08-29).
  if ((snapshot.global_open_count ?? snapshot.open_count) >= OPEN_QUESTION_CEILING) {
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
  }

  if (snapshot.blockedScopes.has(SCOPE_GLOBAL)) {
    const body = withIdleTelemetry(
      attachOpenSnapshot(
        {
          ok: true,
          dispatched: false,
          reason: "nothing-dispatchable",
        },
        snapshot,
      ),
      deps,
    );
    return { status: 200, body };
  }

  const previousOutcome = existing?.outcome ?? existing?.previousOutcome ?? null;
  const scanId = newScanId();
  saveScanState(
    {
      scanId,
      status: "running",
      startedAt: new Date(now).toISOString(),
      finishedAt: null,
      outcome: null,
      previousOutcome,
      open_count: snapshot.open_count,
      todo_ids: snapshot.todo_ids,
    },
    deps,
  );

  enqueueBackground(() => runBackgroundScanAndDispatch(deps, scanId));

  return {
    status: 200,
    body: attachOpenSnapshot(
      {
        ok: true,
        dispatched: false,
        reason: "scan-started",
        scanId,
        backstop_reason: previousOutcome?.backstop_reason ?? null,
        last_scan_reason: previousOutcome?.reason ?? null,
      },
      snapshot,
    ),
  };
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
 * Keys on the run's terminal status first: a failed/cancelled run is never
 * `done`, even when the `pr` step is still waiting (that waiting state cannot
 * distinguish "no PR expected" from "died before pr"). `done` only when the
 * run completed AND ownership ok AND (base verified staging OR positively
 * no PR expected on a successful run).
 *
 * `runStatus` defaults to completed so existing PR-gate fixtures stay valid.
 */
function resolveQueueVerification(ownershipMismatches, baseCheck, runStatus = SUCCESS_RUN_STATUS) {
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

  if (FAILED_RUN_STATUSES.has(runStatus)) {
    const failNote = `run status is "${runStatus}" — not a successful completion`;
    if (baseCheck.noPr && baseCheck.noPrReason) {
      noteParts.push(`${failNote}; ${baseCheck.noPrReason}`);
    } else {
      noteParts.push(failNote);
    }
    return {
      status: "failed",
      note: noteParts.join("; "),
      prBases: baseCheck.bases,
      noPr: baseCheck.noPr,
      noPrReason: baseCheck.noPrReason || null,
      mismatches: ownershipMismatches,
      prBaseMismatches: baseCheck.mismatches,
    };
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

  if (p === "/queue/scan-state" && req.method === "GET") {
    if (!requireAuth(req, res, "GET", "/queue/scan-state")) return;
    return json(res, publicScanState());
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

    try {
      sweepStaleDiagnoses();
    } catch (err) {
      logDispatchNextError(`stale-diagnosis sweep failed (swallowed): ${err?.message || String(err)}`);
    }

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

      const outcome = resolveQueueVerification(ownershipMismatches, baseCheck, run.status);
      item.status = outcome.status;
      item.note = outcome.note;
      const ledgerKey = extractTaskIdFromText(item.task, item.roadmap_ref);
      const ledgerOutcome =
        run.status === "failed" || outcome.status === "flagged" ? "failed" : "completed";
      let failureHandling = null;
      if (ledgerOutcome === "failed" && ledgerKey) {
        // Item 8 (2026-08-29): a failed run no longer parks straight to
        // outcome:"failed" with a "clear the ledger by hand" TODO. It is
        // classified, then either auto-retried (capped at AUTO_RETRY_CAP) or
        // parked through the same task-scoped blocker route as before.
        // handleFailedRunOutcome owns the recordLedgerAttempt for this branch.
        try {
          failureHandling = handleFailedRunOutcome({
            ledgerKey,
            item,
            queue,
            runStatus: run.status,
            queueStatus: outcome.status,
            stepsResult,
          });
        } catch (err) {
          logDispatchNextError(`auto-retry handling failed for ${ledgerKey}: ${err?.message || String(err)}`);
          // Degrade to the pre-2026-08-29 behaviour: park it for the developer.
          recordLedgerAttempt(ledgerKey, {
            outcome: LEDGER_OUTCOME_FAILED,
            runStatus: run.status,
            queueStatus: outcome.status,
            runId: item.runId,
            queueItemId: item.id,
            outcomeAt: item.resolvedAt,
            roadmap_ref: item.roadmap_ref ?? null,
          });
          try {
            writeLedgerFailureTodo({ ledgerKey, item, run, outcome });
          } catch (todoErr) {
            logDispatchNextError(`ledger failure-question write failed: ${todoErr?.message || String(todoErr)}`);
          }
        }
      } else {
        recordLedgerAttempt(ledgerKey, {
          outcome: ledgerOutcome,
          runStatus: run.status,
          queueStatus: outcome.status,
          runId: item.runId,
          queueItemId: item.id,
          outcomeAt: item.resolvedAt,
          roadmap_ref: item.roadmap_ref ?? null,
        });
      }
      changed.push({
        autoRetry: failureHandling
          ? { outcome: failureHandling.outcome, parkedReason: failureHandling.parkedReason ?? null }
          : null,
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
        failed: changed.filter((c) => c.change === "failed").length,
        stillRunning: changed.filter((c) => c.change === "still-running").length,
      },
      changed,
      queue,
      lastScan: loadScanState(),
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

  async function caseOutcome(label, steps, resolveBaseRef, runStatus) {
    const baseCheck = await verifyPrBaseBranch({ steps }, { resolveBaseRef });
    const outcome = resolveQueueVerification(ownershipOk, baseCheck, runStatus);
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
    caseOutcome(
      "failed-run-pr-waiting",
      [
        { stepId: "implement", status: "running", output: "STATUS: done" },
        {
          stepId: "verify",
          status: "failed",
          output: "ENGINE_ERROR: missing_required_keys: gate",
        },
        { stepId: "pr", status: "waiting", output: null },
      ],
      undefined,
      "failed",
    ),
    caseOutcome(
      "completed-run-pr-waiting-legitimate-no-pr",
      [
        { stepId: "implement", status: "done", output: "STATUS: done" },
        { stepId: "pr", status: "waiting", output: null },
      ],
      undefined,
      "completed",
    ),
    caseOutcome(
      "cancelled-run-pr-waiting",
      [
        { stepId: "implement", status: "done", output: "STATUS: done" },
        { stepId: "pr", status: "waiting", output: null },
      ],
      undefined,
      "cancelled",
    ),
  ]);

  const failedRun = gateCases.find((c) => c.case === "failed-run-pr-waiting");
  const legitNoPr = gateCases.find((c) => c.case === "completed-run-pr-waiting-legitimate-no-pr");
  const cancelledRun = gateCases.find((c) => c.case === "cancelled-run-pr-waiting");
  const errors = [];
  if (failedRun?.status === "done") {
    errors.push('failed-run-pr-waiting resolved as done — must key on run status');
  }
  if (failedRun?.status !== "failed") {
    errors.push(`failed-run-pr-waiting status=${failedRun?.status}, expected failed`);
  }
  if (legitNoPr?.status !== "done") {
    errors.push(`completed-run-pr-waiting-legitimate-no-pr status=${legitNoPr?.status}, expected done`);
  }
  if (cancelledRun?.status === "done") {
    errors.push("cancelled-run-pr-waiting resolved as done");
  }
  // ledgerOutcome sourcing is load-bearing: it reads run.status, not the
  // /queue/check verdict. Confirm the formula is unchanged for these cases.
  function ledgerOutcome(runStatus, queueStatus) {
    return runStatus === "failed" || queueStatus === "flagged" ? "failed" : "completed";
  }
  if (ledgerOutcome("failed", failedRun?.status) !== "failed") {
    errors.push("ledgerOutcome for a failed run must stay failed");
  }
  if (ledgerOutcome("completed", legitNoPr?.status) !== "completed") {
    errors.push("ledgerOutcome for a completed no-PR run must stay completed");
  }

  console.log(JSON.stringify({ evaluatePrBaseRef: evaluateCases, gateCases, errors }, null, 2));
  process.exit(errors.length === 0 ? 0 : 1);
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
    ["GET", "/queue/scan-state"],
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

  // These stub repo paths stand in for "a TheCoach checkout whose contents do
  // not matter to this case" — every case here injects readRoadmap/readTodo,
  // so nothing is read from them. They still have to EXIST: since TASK-044,
  // an unlistable _SSoT/tasks/ is a repo-path failure that refuses dispatch,
  // which is the correct production behavior but not what these cases are
  // about. Give them a real, empty tasks dir so the contract load reports the
  // genuine "no task file for this id" gap these cases were written against.
  for (const stubRepo of ["/tmp/thecoach-does-not-matter", "/tmp/idle", "/tmp/human-repo"]) {
    fs.mkdirSync(path.join(stubRepo, TASKS_RELATIVE_DIR), { recursive: true });
  }

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

  function memoryScanState(initial = null) {
    let s = initial ? JSON.parse(JSON.stringify(initial)) : null;
    return {
      loadScanState: () => (s ? JSON.parse(JSON.stringify(s)) : null),
      saveScanState: (next) => {
        s = next ? JSON.parse(JSON.stringify(next)) : null;
      },
      get: () => s,
    };
  }

  function memoryLedger(initial = {}) {
    let l = JSON.parse(JSON.stringify(initial));
    return {
      loadLedger: () => JSON.parse(JSON.stringify(l)),
      saveLedger: (next) => {
        l = JSON.parse(JSON.stringify(next));
      },
      get: () => l,
    };
  }

  function backgroundBox() {
    const jobs = [];
    return {
      enqueueBackground: (fn) => {
        jobs.push(fn);
      },
      async flush() {
        while (jobs.length) {
          const fn = jobs.shift();
          await fn();
        }
      },
      get length() {
        return jobs.length;
      },
    };
  }

  const emptyTodo = () => "[]";
  // Every stubbed readTodo in this suite is paired with a stubbed writeTodo.
  // appendDeveloperTodoEntry() resolves its reader and its writer
  // independently, so a faked read plus a real write rewrites the production
  // developer_todo.json with fixture data — that is how TODO-0016..0021 were
  // lost on 2026-08-30.
  const testTodoWrites = [];
  const sinkTodo = (_repo, entries) => {
    testTodoWrites.push(entries);
  };

  const STUB_ROADMAP = [
    "# ROADMAP",
    "",
    "## Sprint 4a — Visual Design System",
    "",
    "- [x] **Design system build-out (TASK-019)**",
    "- [x] ~~Staging integration (TASK-022)~~",
    "- [ ] **Promote design-preview (TASK-025)**",
    "",
    "## Sprint 4b — Trainer Web App Build",
    "",
    "- [ ] **Auth rework (TASK-040)**",
    "",
    "## Sprint 9 — Testing & QA Hardening",
    "",
    "- [ ] **Add reliability note (TASK-099)**",
    "- [ ] **Schema/types drift check (TASK-026)**",
  ].join("\n");

  const dispatchReply = {
    decision: "dispatch",
    title: "Add reliability note (TASK-099)",
    description: "Write the Sprint 4 reliability paragraph into README.md",
    roadmap_ref: "Sprint 9 — Testing & QA Hardening: reliability paragraph (TASK-099)",
    scopes: ["sprint:9"],
  };
  const capturedLogs = [];
  const origLog = console.log;
  console.log = (...args) => {
    capturedLogs.push(args.map(String).join(" "));
    origLog(...args);
  };
  const dispatchReplyNoScopes = {
    decision: "dispatch",
    title: "Add reliability note (TASK-099)",
    description: "Write the Sprint 4 reliability paragraph into README.md",
    roadmap_ref: "Sprint 9 — Testing & QA Hardening: reliability paragraph (TASK-099)",
  };
  const recordQuestionReply = {
    decision: "record-question",
    summary: "Need a yes/no on adding CI",
    why: "Spends Actions minutes",
    source: "roadmap:Sprint9",
    type: "roadmap-decision",
    evidence: "no .github/workflows",
    reply_needed: "yes or no",
    blocks: ["task:TASK-033"],
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
    check(
      "reject-malformed-scopes-entries",
      parseAgentDecision(JSON.stringify({ ...dispatchReply, scopes: ["banana", "", "sprint:", 42] })).ok === false,
    ),
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

  const phase4bDispatch = {
    decision: "dispatch",
    title: "OAuth client wiring (TASK-040)",
    description: "Wire Google OAuth into auth",
    roadmap_ref: "Sprint 4b — Auth rework (TASK-040)",
    scopes: ["sprint:4B"],
  };
  const parsedBlocked = parseAgentDecision(JSON.stringify(phase4bDispatch));
  const blockedBackstop = evaluateDispatchBackstop(
    parsedBlocked.decision.scopes,
    new Set(["sprint:4B", "oq:OQ-12"]),
    phase4bDispatch.roadmap_ref,
    STUB_ROADMAP,
    phase4bDispatch,
  );
  const missingScopesBackstop = evaluateDispatchBackstop(undefined, new Set());
  const emptyScopesBackstop = evaluateDispatchBackstop([], new Set());
  const emptyBlocksBackstop = evaluateDispatchBackstop(
    ["sprint:9"],
    new Set(summarizeOpenTodos([{ id: "TODO-0006", status: "open", blocks: [] }]).blockedScopes),
    dispatchReply.roadmap_ref,
    STUB_ROADMAP,
    dispatchReply,
  );
  const backstopDirectCases = [
    check("backstop-blocked-scope-direct", parsedBlocked.ok === true && blockedBackstop.ok === false, blockedBackstop),
    check("backstop-missing-scopes-direct", missingScopesBackstop.ok === false, missingScopesBackstop),
    check("backstop-empty-scopes-direct", emptyScopesBackstop.ok === false, emptyScopesBackstop),
    check("backstop-empty-blocks-does-not-block", emptyBlocksBackstop.ok === true, emptyBlocksBackstop),
  ];

  async function liveScanDispatch(agentDecision, todoEntries, extra = {}) {
    return scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      readTodo: () => JSON.stringify(todoEntries),
      readRoadmap: () => STUB_ROADMAP,
      runAgent: async () => JSON.stringify({ payloads: [{ text: JSON.stringify(agentDecision) }] }),
      loadLedger: () => ({}),
      saveLedger: () => {},
      writeTodo: () => {},
      ...extra,
    });
  }

  const liveBlockedScan = await liveScanDispatch(phase4bDispatch, [
    { id: "TODO-0004", status: "open", summary: "oauth", blocks: ["sprint:4B", "oq:OQ-12"] },
  ]);
  const liveMissingScopesScan = await liveScanDispatch(dispatchReplyNoScopes, []);
  const liveBackstopCases = [
    check("live-backstop-blocked-outcome", liveBlockedScan.outcome === "nothing-dispatchable", liveBlockedScan),
    check("live-backstop-blocked-rejected", liveBlockedScan.backstop_rejected === true, liveBlockedScan),
    check("live-backstop-blocked-reason", liveBlockedScan.backstop_reason === "intersects-blocked", liveBlockedScan),
    check("live-backstop-missing-scopes-rejected", liveMissingScopesScan.backstop_rejected === true, liveMissingScopesScan),
    check("live-backstop-missing-scopes-reason", liveMissingScopesScan.backstop_reason === "missing-or-empty-scopes", liveMissingScopesScan),
  ];

  const bypassStrings = ["sprint:4b", "Sprint:4b", "sprint:4B ", "sprint:4", "", "not-a-scope"];
  const bypassLiveCases = [];
  for (const [i, scope] of bypassStrings.entries()) {
    const decision = { ...phase4bDispatch, scopes: [scope] };
    let scanResult;
    if (scope === "" || scope === "not-a-scope" || scope === "sprint:4") {
      // parse may reject empty/not-a-scope; sprint:4 is valid grammar but disagrees with derived 4b
      const parsed = parseAgentDecision(JSON.stringify(decision));
      if (!parsed.ok) {
        scanResult = { outcome: "nothing-dispatchable", failReason: parsed.error, parseRejected: true };
      } else {
        scanResult = await liveScanDispatch(decision, [
          { id: "TODO-0004", status: "open", summary: "oauth", blocks: ["sprint:4B"] },
        ]);
      }
    } else {
      scanResult = await liveScanDispatch(decision, [
        { id: "TODO-0004", status: "open", summary: "oauth", blocks: ["sprint:4B"] },
      ]);
    }
    const rejected =
      scanResult.parseRejected === true ||
      scanResult.backstop_rejected === true ||
      scanResult.outcome === "nothing-dispatchable";
    const didNotDispatch = scanResult.outcome !== "dispatch";
    bypassLiveCases.push(
      check(`bypass-${i}-${JSON.stringify(scope)}-rejected`, rejected && didNotDispatch, scanResult),
    );
  }

  const disagreeScan = await liveScanDispatch(
    { ...dispatchReply, scopes: ["sprint:9"], roadmap_ref: "Sprint 4b — Auth rework (TASK-099)" },
    [],
  );
  const coherentWrong = {
    decision: "dispatch",
    title: "Promote design-preview (TASK-025)",
    description: "Replace the old screens with design-preview",
    roadmap_ref: "Sprint 9 — Testing & QA Hardening: Promote design-preview (TASK-025)",
    scopes: ["sprint:9"],
  };
  const coherentWrongScan = await liveScanDispatch(coherentWrong, []);
  const phase77Scan = await liveScanDispatch(
    {
      ...dispatchReply,
      scopes: ["sprint:77"],
      roadmap_ref: "Sprint 77 — Does not exist (TASK-099)",
    },
    [],
  );
  const unlocatableScan = await liveScanDispatch(
    {
      decision: "dispatch",
      title: "Invented work (TASK-888)",
      description: "This checkbox is not in the roadmap",
      roadmap_ref: "Sprint 9 — Testing & QA Hardening: Invented work (TASK-888)",
      scopes: ["sprint:9"],
    },
    [],
  );
  const omitTaskIdScan = await liveScanDispatch(
    {
      decision: "dispatch",
      title: "Add reliability note",
      description: "Write the Sprint 4 reliability paragraph into README.md",
      roadmap_ref: "Sprint 9 — Testing & QA Hardening: reliability paragraph",
      scopes: ["sprint:9"],
    },
    [],
  );
  const phaseDisagreeCases = [
    check("phase-disagree-rejected", disagreeScan.backstop_rejected === true, disagreeScan),
    check("phase-disagree-reason", disagreeScan.backstop_reason === "phase-disagreement", disagreeScan),
    check("coherent-wrong-rejected", coherentWrongScan.backstop_rejected === true, coherentWrongScan),
    check("coherent-wrong-reason", coherentWrongScan.backstop_reason === "phase-disagreement", coherentWrongScan),
    check("coherent-wrong-not-dispatch", coherentWrongScan.outcome !== "dispatch", coherentWrongScan),
    check("phase-77-rejected", phase77Scan.backstop_rejected === true, phase77Scan),
    check("phase-77-reason", phase77Scan.backstop_reason === "unknown-phase", phase77Scan),
    check("unlocatable-rejected", unlocatableScan.backstop_rejected === true, unlocatableScan),
    check("unlocatable-reason", unlocatableScan.backstop_reason === "item-unlocatable", unlocatableScan),
    check("omit-task-id-rejected", omitTaskIdScan.backstop_rejected === true, omitTaskIdScan),
    check("omit-task-id-reason", omitTaskIdScan.backstop_reason === "item-unlocatable", omitTaskIdScan),
    check("omit-task-id-not-dispatch", omitTaskIdScan.outcome !== "dispatch", omitTaskIdScan),
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
  const bgDispatch = backgroundBox();
  const scanDispatchState = memoryScanState();
  const ledgerDispatch = memoryLedger();
  let scanCalledOnDispatch = 0;
  const dispatchResult = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    ...dispatchMocks(),
    load: mqDispatch.load,
    save: mqDispatch.save,
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    ...bgDispatch,
    ...scanDispatchState,
    ...ledgerDispatch,
    scan: async () => {
      scanCalledOnDispatch += 1;
      return { outcome: "dispatch", decision: dispatchReply, blockedScopes: [], open_count: 0, todo_ids: [] };
    },
  });
  await bgDispatch.flush();
  const dispatchedItem = mqDispatch.get()[0];
  const dispatchCases = [
    check("1-status-200", dispatchResult.status === 200, dispatchResult.status),
    check("1-reason-scan-started", dispatchResult.body.reason === "scan-started", dispatchResult.body.reason),
    check("1-http-not-yet-dispatched", dispatchResult.body.dispatched === false),
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
  const bgBlocked = backgroundBox();
  let startRunOnBlocked = 0;
  let blockedAgentCalls = 0;
  const blockedHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: mqBlocked.load,
    save: mqBlocked.save,
    writeTodo: sinkTodo,
    readTodo: () => JSON.stringify([{ id: "TODO-0004", status: "open", summary: "oauth", blocks: ["sprint:4B", "oq:OQ-12"] }]),
    ...bgBlocked,
    ...memoryScanState(),
    ...memoryLedger(),
    scan: async (scanDeps) => {
      blockedAgentCalls += 1;
      return scanRoadmapForWork({
        ...scanDeps,
        thecoachRepo: "/tmp/thecoach-does-not-matter",
        writeTodo: sinkTodo,
        readTodo: () => JSON.stringify([{ id: "TODO-0004", status: "open", summary: "oauth", blocks: ["sprint:4B", "oq:OQ-12"] }]),
        readRoadmap: () => STUB_ROADMAP,
        runAgent: async () => JSON.stringify({ payloads: [{ text: JSON.stringify(phase4bDispatch) }] }),
      });
    },
    startRun: () => {
      startRunOnBlocked += 1;
      throw new Error("startRun must not run on blocked-scope");
    },
  });
  await bgBlocked.flush();
  const blockedScopeCases = [
    check("blocked-scope-status-200", blockedHttp.status === 200, blockedHttp.status),
    check("blocked-scope-reason-scan-started", blockedHttp.body.reason === "scan-started", blockedHttp.body.reason),
    check("blocked-scope-http-not-dispatched", blockedHttp.body.dispatched === false),
    check("blocked-scope-no-queue-item", mqBlocked.get().length === 0, mqBlocked.get().length),
    check("blocked-scope-startRun-not-called", startRunOnBlocked === 0, startRunOnBlocked),
    check("blocked-scope-agent-called-in-background", blockedAgentCalls === 1, blockedAgentCalls),
    check(
      "blocked-scope-logged",
      capturedLogs.some((l) => l.includes("backstop-rejected-dispatch") && l.includes("sprint:4B")),
      capturedLogs.filter((l) => l.includes("backstop")),
    ),
    check("blocked-scope-scan-outcome-nothing", bgBlocked.length === 0 && mqBlocked.get().length === 0),
  ];

  const mqMissingScopes = memoryQueue([]);
  const bgMissingScopes = backgroundBox();
  let startRunOnMissingScopes = 0;
  const missingScopesHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: mqMissingScopes.load,
    save: mqMissingScopes.save,
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    ...bgMissingScopes,
    ...memoryScanState(),
    ...memoryLedger(),
    scan: async () => liveMissingScopesScan,
    startRun: () => {
      startRunOnMissingScopes += 1;
      throw new Error("startRun must not run on missing scopes");
    },
  });
  await bgMissingScopes.flush();
  const missingScopesCases = [
    check("missing-scopes-http-scan-started", missingScopesHttp.body.reason === "scan-started", missingScopesHttp.body.reason),
    check("missing-scopes-not-dispatched", mqMissingScopes.get().length === 0),
    check("missing-scopes-startRun-not-called", startRunOnMissingScopes === 0, startRunOnMissingScopes),
  ];

  const mqEmptyBlocks = memoryQueue([]);
  const bgEmptyBlocks = backgroundBox();
  dispatchMocks.started = [];
  let emptyBlocksAgentCalls = 0;
  const emptyBlocksHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    ...dispatchMocks(),
    load: mqEmptyBlocks.load,
    save: mqEmptyBlocks.save,
    writeTodo: sinkTodo,
    readTodo: () => JSON.stringify([{ id: "TODO-0006", status: "open", summary: "billing", blocks: [] }]),
    ...bgEmptyBlocks,
    ...memoryScanState(),
    ...memoryLedger(),
    scan: async () =>
      scanRoadmapForWork({
        thecoachRepo: "/tmp/thecoach-does-not-matter",
        writeTodo: sinkTodo,
        readTodo: () => JSON.stringify([{ id: "TODO-0006", status: "open", summary: "billing", blocks: [] }]),
        readRoadmap: () => STUB_ROADMAP,
        runAgent: async () => {
          emptyBlocksAgentCalls += 1;
          return JSON.stringify({ payloads: [{ text: JSON.stringify(dispatchReply) }] });
        },
      }),
  });
  await bgEmptyBlocks.flush();
  const emptyBlocksCases = [
    check("empty-blocks-http-scan-started", emptyBlocksHttp.body.reason === "scan-started", emptyBlocksHttp.body.reason),
    check("empty-blocks-agent-called", emptyBlocksAgentCalls === 1, emptyBlocksAgentCalls),
    check("empty-blocks-dispatched", mqEmptyBlocks.get()[0]?.status === "dispatched", mqEmptyBlocks.get()[0]),
  ];

  const schemaLogsBefore = capturedLogs.length;
  const missingBlocksTodo = [{ id: "TODO-0007", status: "open", summary: "unscoped" }];
  let missingBlocksAgentCalls = 0;
  const missingBlocksScan = await scanRoadmapForWork({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    writeTodo: sinkTodo,
    readTodo: () => JSON.stringify(missingBlocksTodo),
    readRoadmap: () => "# ROADMAP",
    runAgent: async () => {
      missingBlocksAgentCalls += 1;
      throw new Error("runAgent must not run when blocks missing (treated as *)");
    },
  });
  const schemaLogs = capturedLogs.slice(schemaLogsBefore);
  let missingBlocksHttpAgent = 0;
  const missingBlocksHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: () => JSON.stringify(missingBlocksTodo),
    scan: async () => {
      missingBlocksHttpAgent += 1;
      throw new Error("scan must not run on missing-blocks star");
    },
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
    check("missing-blocks-http-no-scan", missingBlocksHttpAgent === 0, missingBlocksHttpAgent),
  ];

  // 50 open TODOs, all `*`-scoped: exactly at OPEN_QUESTION_CEILING. Must be
  // `*`-scoped — only global blockers count toward the ceiling (8-P2,
  // 2026-08-29), so a `blocks: []` fixture trips nothing at any size.
  const atCeilingOpen = Array.from({ length: 50 }, (_, i) => ({
    id: `TODO-${String(i + 1).padStart(4, "0")}`,
    status: "open",
    summary: `q${i}`,
    blocks: ["*"],
  }));
  let ceilingAgentCalls = 0;
  let ceilingScan = { outcome: "threw-before-return" };
  try {
    ceilingScan = await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      writeTodo: sinkTodo,
      readTodo: () => JSON.stringify(atCeilingOpen),
      readRoadmap: () => "# ROADMAP",
      runAgent: async () => {
        ceilingAgentCalls += 1;
        return JSON.stringify({ payloads: [{ text: JSON.stringify(dispatchReply) }] });
      },
    });
  } catch (err) {
    ceilingScan = { outcome: "threw", error: err?.message || String(err) };
  }
  let ceilingHttpScan = 0;
  const ceilingHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: () => JSON.stringify(atCeilingOpen),
    scan: async () => {
      ceilingHttpScan += 1;
      throw new Error("scan must not run on ceiling");
    },
    startRun: () => {
      throw new Error("startRun must not run on ceiling");
    },
  });
  const underCeilingGlobalOpen = Array.from({ length: 49 }, (_, i) => ({
    id: `TODO-${String(i + 1).padStart(4, "0")}`,
    status: "open",
    summary: `q${i}`,
    blocks: ["*"],
  }));
  let underCeilingScan = { outcome: "threw-before-return" };
  try {
    underCeilingScan = await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      writeTodo: sinkTodo,
      readTodo: () => JSON.stringify(underCeilingGlobalOpen),
      readRoadmap: () => "# ROADMAP",
      runAgent: async () =>
        JSON.stringify({ payloads: [{ text: JSON.stringify(dispatchReply) }] }),
    });
  } catch (err) {
    underCeilingScan = { outcome: "threw", error: err?.message || String(err) };
  }

  const ceilingCases = [
    check("ceiling-agent-not-called", ceilingAgentCalls === 0, ceilingAgentCalls),
    // Boundary: one under the ceiling must NOT trip it. These entries are
    // `*`-scoped, so the gate immediately below (blockedScopes has "*")
    // catches them instead — proving the ceiling itself did not fire.
    check(
      "ceiling-boundary-49-not-developer-attention",
      underCeilingScan.outcome !== "developer-attention-required",
      underCeilingScan.outcome,
    ),
    check(
      "ceiling-boundary-49-falls-through-to-scope-gate",
      underCeilingScan.outcome === "nothing-dispatchable",
      underCeilingScan.outcome,
    ),
    check("ceiling-outcome", ceilingScan.outcome === "developer-attention-required", ceilingScan.outcome),
    check("ceiling-reason", ceilingHttp.body.reason === "developer-attention-required", ceilingHttp.body.reason),
    check("ceiling-open-count", ceilingHttp.body.open_count === 50, ceilingHttp.body.open_count),
    check("ceiling-not-dispatched", ceilingHttp.body.dispatched === false),
    check("ceiling-http-no-scan", ceilingHttpScan === 0, ceilingHttpScan),
  ];

  // 49 open TODOs with no scope: one under the ceiling by raw count, and
  // zero by global count. Neither gate may fire — dispatch proceeds.
  const belowCeilingOpen = Array.from({ length: 49 }, (_, i) => ({
    id: `TODO-${String(i + 1).padStart(4, "0")}`,
    status: "open",
    summary: `q${i}`,
    blocks: [],
  }));
  let belowCeilingAgentCalls = 0;
  dispatchMocks.started = [];
  const mqBelowCeiling = memoryQueue([]);
  const bgBelowCeiling = backgroundBox();
  const belowCeilingHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    ...dispatchMocks(),
    load: mqBelowCeiling.load,
    save: mqBelowCeiling.save,
    writeTodo: sinkTodo,
    readTodo: () => JSON.stringify(belowCeilingOpen),
    ...bgBelowCeiling,
    ...memoryScanState(),
    ...memoryLedger(),
    scan: async () =>
      scanRoadmapForWork({
        thecoachRepo: "/tmp/thecoach-does-not-matter",
        writeTodo: sinkTodo,
        readTodo: () => JSON.stringify(belowCeilingOpen),
        readRoadmap: () => STUB_ROADMAP,
        runAgent: async () => {
          belowCeilingAgentCalls += 1;
          return JSON.stringify({ payloads: [{ text: JSON.stringify(dispatchReply) }] });
        },
      }),
  });
  await bgBelowCeiling.flush();
  const belowCeilingCases = [
    check("below-ceiling-empty-blocks-http-scan-started", belowCeilingHttp.body.reason === "scan-started", belowCeilingHttp.body.reason),
    check("below-ceiling-empty-blocks-agent-called", belowCeilingAgentCalls === 1, belowCeilingAgentCalls),
    check("below-ceiling-empty-blocks-dispatched", mqBelowCeiling.get()[0]?.status === "dispatched", mqBelowCeiling.get()[0]),
  ];

  const mqNothing = memoryQueue([]);
  const idleNothing = memoryIdle();
  const bgNothing = backgroundBox();
  const scanNothingState = memoryScanState();
  const nothingResult = await handleDispatchNext({
    findActive: () => null,
    load: mqNothing.load,
    save: mqNothing.save,
    loadIdle: idleNothing.loadIdle,
    saveIdle: idleNothing.saveIdle,
    thecoachRepo: "/tmp/idle",
    writeTodo: sinkTodo,
    readTodo: () => JSON.stringify([
      { id: "TODO-0004", status: "open", blocks: [] },
      { id: "TODO-0006", status: "open", blocks: [] },
    ]),
    ...bgNothing,
    ...scanNothingState,
    ...memoryLedger(),
    scan: async () => ({ outcome: "nothing-dispatchable", open_count: 2, todo_ids: ["TODO-0004", "TODO-0006"] }),
    startRun: () => {
      throw new Error("startRun must not run");
    },
  });
  await bgNothing.flush();
  const nothingCases = [
    check("3-status-200", nothingResult.status === 200),
    check("3-reason-scan-started", nothingResult.body.reason === "scan-started", nothingResult.body.reason),
    check("3-open-count", nothingResult.body.open_count === 2, nothingResult.body.open_count),
    check("3-todo-ids", JSON.stringify(nothingResult.body.todo_ids) === JSON.stringify(["TODO-0004", "TODO-0006"]), nothingResult.body.todo_ids),
    check("3-no-queue-item", mqNothing.get().length === 0),
    check("3-no-needs-developer-decision", nothingResult.body.reason !== "needs-developer-decision"),
    check("3-idle-incremented", idleNothing.get().consecutive_idle === 1, idleNothing.get()),
    check("3-last-scan-nothing", scanNothingState.get()?.outcome?.reason === "nothing-dispatchable", scanNothingState.get()),
  ];

  const agentFailScans = [];
  agentFailScans.push(
    await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      readRoadmap: () => "# ROADMAP",
      writeTodo: sinkTodo,
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
      writeTodo: sinkTodo,
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
      writeTodo: sinkTodo,
      readTodo: () => "[]",
      runAgent: async () => "this is not json {",
    }),
  );
  agentFailScans.push(
    await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      readRoadmap: () => "# ROADMAP",
      writeTodo: sinkTodo,
      readTodo: () => "[]",
      runAgent: async () => JSON.stringify({ payloads: [{ text: "I think we should dispatch something." }] }),
    }),
  );
  const agentFailHttp = [];
  for (const [i, scanResult] of agentFailScans.entries()) {
    const mq = memoryQueue([]);
    const bg = backgroundBox();
    const httpResult = await handleDispatchNext({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      findActive: () => null,
      load: mq.load,
      save: mq.save,
      writeTodo: sinkTodo,
      readTodo: emptyTodo,
      ...bg,
      ...memoryScanState(),
      ...memoryLedger(),
      scan: async () => scanResult,
      startRun: () => {
        throw new Error("startRun must not run on agent-fail");
      },
    });
    await bg.flush();
    agentFailHttp.push(
      check(
        `4-agent-fail-${i}-http`,
        httpResult.status === 200 &&
          httpResult.body.dispatched === false &&
          httpResult.body.reason === "scan-started" &&
          mq.get().length === 0,
        { status: httpResult.status, body: httpResult.body, queueLen: mq.get().length, failReason: scanResult.failReason },
      ),
    );
  }
  const agentFailScanOutcomes = agentFailScans.map((s, i) =>
    check(`4-scan-${i}-developer-attention`, s.outcome === "developer-attention-required" && Boolean(s.failReason), s),
  );

  let roadmapThrowAgent = 0;
  let roadmapThrew = false;
  try {
    await scanRoadmapForWork({
      thecoachRepo: "/tmp/thecoach-does-not-matter",
      writeTodo: sinkTodo,
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
    thecoachRepo: missingRepo,
    scan: async () => {
      fileFailAgent += 1;
      throw new Error("runAgent must not run");
    },
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
    task: "human submitted task TASK-099",
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
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: mqOccupied.load,
    save: mqOccupied.save,
    ...memoryLedger(),
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
    thecoachRepo: "/tmp/thecoach-does-not-matter",
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
  const fetchObserver = (p) => fetchedDuringScan.push(p);
  stagingFetchObservers.push(fetchObserver);
  let pathScan;
  try {
    pathScan = await scanRoadmapForWork({
      thecoachRepo: "/mnt/c/Users/lahad/Projects/TheCoach",
      readRoadmap: (repo) => {
        roadmapRepos.push(repo);
        return "# ROADMAP\n## Phase 4A\n";
      },
      writeTodo: sinkTodo,
      readTodo: (repo) => {
        todoRepos.push(repo);
        return '[{"id":"TODO-0001","status":"open","blocks":[]}]';
      },
      runAgent: async () => JSON.stringify({ payloads: [{ text: '{"decision":"nothing-to-do"}' }] }),
    });
  } finally {
    const idx = stagingFetchObservers.indexOf(fetchObserver);
    if (idx >= 0) stagingFetchObservers.splice(idx, 1);
  }
  const pathCases = [
    check("path-scan-nothing-dispatchable", pathScan.outcome === "nothing-dispatchable" && !pathScan.failReason, pathScan),
    check("path-scan-does-not-fetch", fetchedDuringScan.length === 0, fetchedDuringScan),
    check("path-roadmap-is-thecoach-env", roadmapRepos[0] === "/mnt/c/Users/lahad/Projects/TheCoach", roadmapRepos),
    check("path-todo-is-thecoach-env", todoRepos[0] === "/mnt/c/Users/lahad/Projects/TheCoach", todoRepos),
    check("path-roadmap-is-not-trial-clone", roadmapRepos[0] !== DEFAULT_QUEUE_REPO_PATH, roadmapRepos),
  ];

  const spawnWorstMs = GIT_FETCH_TIMEOUT_MS + GIT_REVPARSE_TIMEOUT_MS + WAIT_FOR_RUN_TIMEOUT_MS;
  const scanWorstMs =
    PLANNER_EXEC_TIMEOUT_MS + GIT_FETCH_TIMEOUT_MS + GIT_REVPARSE_TIMEOUT_MS + WAIT_FOR_RUN_TIMEOUT_MS;
  const timeoutCases = [
    check("timeout-exec-above-cli", PLANNER_EXEC_TIMEOUT_MS > PLANNER_CLI_TIMEOUT_SEC * 1000, {
      cliSec: PLANNER_CLI_TIMEOUT_SEC,
      execMs: PLANNER_EXEC_TIMEOUT_MS,
    }),
    check("timeout-cli-above-measured-band", PLANNER_CLI_TIMEOUT_SEC >= 100, PLANNER_CLI_TIMEOUT_SEC),
    check(
      "timeout-fetch-in-20-30s-band",
      GIT_FETCH_TIMEOUT_MS >= 20_000 && GIT_FETCH_TIMEOUT_MS <= 30_000,
      GIT_FETCH_TIMEOUT_MS,
    ),
    check("timeout-spawn-worst-under-110s", spawnWorstMs <= 110_000, spawnWorstMs),
    check("timeout-spawn-worst-under-edge", spawnWorstMs < 125_000, spawnWorstMs),
    check("timeout-scan-under-lock-ttl", scanWorstMs < SCAN_LOCK_TTL_MS, {
      scanWorstMs,
      ttl: SCAN_LOCK_TTL_MS,
      headroomMs: SCAN_LOCK_TTL_MS - scanWorstMs,
    }),
  ];

  const idle = memoryIdle();
  const idleResults = [];
  for (let i = 1; i <= 24; i += 1) {
    const bg = backgroundBox();
    const r = await handleDispatchNext({
      findActive: () => null,
      load: memoryQueue([]).load,
      save: () => {},
      loadIdle: idle.loadIdle,
      saveIdle: idle.saveIdle,
      thecoachRepo: "/tmp/idle",
      writeTodo: sinkTodo,
      readTodo: emptyTodo,
      ...bg,
      ...memoryScanState(),
      ...memoryLedger(),
      scan: async () => ({ outcome: "nothing-dispatchable", open_count: 0, todo_ids: [] }),
      startRun: () => {
        throw new Error("startRun must not run");
      },
    });
    await bg.flush();
    idleResults.push({ i, escalated: r.body.escalated === true, consecutive: idle.get().consecutive_idle });
  }
  // Escalation is applied on background completion, not on the scan-started response.
  idleResults.forEach((row) => {
    row.escalated = row.consecutive > 0 && row.consecutive % IDLE_ESCALATION_EVERY === 0;
  });
  dispatchMocks.started = [];
  const idleAfterDispatch = memoryIdle({ consecutive_idle: 5, last_idle_at: "t", last_escalated_at: null });
  const bgIdleDispatch = backgroundBox();
  await handleDispatchNext({
    ...dispatchMocks(),
    load: memoryQueue([]).load,
    save: () => {},
    loadIdle: idleAfterDispatch.loadIdle,
    saveIdle: idleAfterDispatch.saveIdle,
    thecoachRepo: "/tmp/idle",
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    ...bgIdleDispatch,
    ...memoryScanState(),
    ...memoryLedger(),
    scan: async () => ({ outcome: "dispatch", decision: dispatchReply, blockedScopes: [], open_count: 0, todo_ids: [] }),
  });
  await bgIdleDispatch.flush();
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
    writeTodo: sinkTodo,
    readTodo: () => JSON.stringify(atCeilingOpen),
  });
  let idleThrowLoads = 0;
  const bgIdleSwallow = backgroundBox();
  dispatchMocks.started = [];
  const idleSwallowHttp = await handleDispatchNext({
    ...dispatchMocks(),
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    ...bgIdleSwallow,
    ...memoryScanState(),
    ...memoryLedger(),
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
  await bgIdleSwallow.flush();
  const idleCases = [
    check("idle-count-after-24", idle.get().consecutive_idle === 24, idle.get()),
    check("idle-escalate-at-12", idleResults[11].escalated === true && idleResults[11].consecutive === 12, idleResults[11]),
    check("idle-escalate-at-24", idleResults[23].escalated === true && idleResults[23].consecutive === 24, idleResults[23]),
    check("idle-not-at-11", idleResults[10].escalated === false, idleResults[10]),
    check("idle-not-at-13", idleResults[12].escalated === false, idleResults[12]),
    check("idle-reset-on-dispatch", idleAfterDispatch.get().consecutive_idle === 0, idleAfterDispatch.get()),
    check("idle-untouched-on-active-run", idleBeforeActive.get().consecutive_idle === 3, idleBeforeActive.get()),
    check("idle-untouched-on-ceiling", idleBeforeCeiling.get().consecutive_idle === 3, idleBeforeCeiling.get()),
    check("idle-failure-swallowed", dispatchMocks.started.length === 1, dispatchMocks.started.length),
    check("idle-http-scan-started", idleSwallowHttp.body.reason === "scan-started", idleSwallowHttp.body.reason),
  ];

  const storedTodos = [
    {
      id: "TODO-0001",
      status: "open",
      summary: "Need a yes/no on adding CI",
      source: "roadmap:Sprint9",
      type: "roadmap-decision",
      blocks: [],
    },
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
  const rewordWrites = [];
  const rewordScan = await scanRoadmapForWork({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    readTodo: () => JSON.stringify(storedTodos),
    readRoadmap: () => "# ROADMAP",
    writeTodo: (_repo, entries) => {
      rewordWrites.push(entries);
    },
    runAgent: async () =>
      JSON.stringify({
        payloads: [
          {
            text: JSON.stringify({
              ...recordQuestionReply,
              summary: "Need a yes/no on adding CI!!!",
            }),
          },
        ],
      }),
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
    check("dup-reworded-no-write", rewordWrites.length === 0, rewordWrites.length),
    check("append-wrote-once", freshWrites.length === 1, freshWrites.length),
    check("append-status-open", freshStored[0]?.status === "open", freshStored[0]),
    check("append-blocks-empty", Array.isArray(freshStored[0]?.blocks) && freshStored[0].blocks.length === 0, freshStored[0]),
    check("append-id", freshStored[0]?.id === "TODO-0001", freshStored[0]?.id),
    check("append-outcome", appendScan.outcome === "nothing-dispatchable", appendScan.outcome),
  ];

  const overlapState = memoryScanState();
  const bgOverlap = backgroundBox();
  let overlapFirstReleased = false;
  let overlapResolve;
  const overlapGate = new Promise((resolve) => {
    overlapResolve = resolve;
  });
  const overlapFirst = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    ...bgOverlap,
    ...overlapState,
    ...memoryLedger(),
    scan: async () => {
      await overlapGate;
      overlapFirstReleased = true;
      return { outcome: "nothing-dispatchable", open_count: 0, todo_ids: [] };
    },
  });
  let overlapSecondScan = 0;
  const overlapSecond = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    ...bgOverlap,
    ...overlapState,
    ...memoryLedger(),
    scan: async () => {
      overlapSecondScan += 1;
      throw new Error("second scan must not start");
    },
  });
  overlapResolve();
  await bgOverlap.flush();
  const overlapCases = [
    check("overlap-first-scan-started", overlapFirst.body.reason === "scan-started", overlapFirst.body.reason),
    check("overlap-second-in-progress", overlapSecond.body.reason === "scan-in-progress", overlapSecond.body.reason),
    check("overlap-same-scanId", overlapSecond.body.scanId === overlapFirst.body.scanId, {
      first: overlapFirst.body.scanId,
      second: overlapSecond.body.scanId,
    }),
    check("overlap-second-scan-not-started", overlapSecondScan === 0, overlapSecondScan),
    check("overlap-first-did-run", overlapFirstReleased === true),
  ];

  const staleState = memoryScanState({
    scanId: "scan-old",
    status: "running",
    startedAt: new Date(Date.now() - SCAN_LOCK_TTL_MS - 1_000).toISOString(),
    open_count: 0,
    todo_ids: [],
  });
  const bgStale = backgroundBox();
  const staleHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    now: Date.now(),
    ...bgStale,
    ...staleState,
    ...memoryLedger(),
    scan: async () => ({ outcome: "nothing-dispatchable", open_count: 0, todo_ids: [] }),
  });
  const staleCases = [
    check("stale-lock-starts-new-scan", staleHttp.body.reason === "scan-started", staleHttp.body.reason),
    check("stale-lock-new-scanId", staleHttp.body.scanId !== "scan-old", staleHttp.body.scanId),
  ];
  await bgStale.flush();

  const failedTaskDispatch = {
    ...dispatchReply,
    title: "Schema/types drift check (TASK-026)",
    description: "Add check:types",
    roadmap_ref: "Sprint 9 — Testing & QA Hardening: Schema/types drift check (TASK-026)",
    scopes: ["sprint:9", "task:TASK-026"],
  };
  const ledgerWrites = [];
  const ledgerBlockedScan = await scanRoadmapForWork({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    readTodo: () => "[]",
    readRoadmap: () => STUB_ROADMAP,
    loadLedger: () => ({ "TASK-026": { outcome: "failed", cleared: false } }),
    saveLedger: () => {},
    writeTodo: (_repo, entries) => {
      ledgerWrites.push(entries);
    },
    runAgent: async () => JSON.stringify({ payloads: [{ text: JSON.stringify(failedTaskDispatch) }] }),
  });
  const mqLedger = memoryQueue([]);
  const bgLedger = backgroundBox();
  let ledgerStartRun = 0;
  const ledgerHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: mqLedger.load,
    save: mqLedger.save,
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    ...bgLedger,
    ...memoryScanState(),
    loadLedger: () => ({ "TASK-026": { outcome: "failed", cleared: false } }),
    saveLedger: () => {},
    scan: async () => ledgerBlockedScan,
    startRun: () => {
      ledgerStartRun += 1;
      throw new Error("startRun must not run on ledger-blocked");
    },
  });
  await bgLedger.flush();
  const ledgerCases = [
    check("ledger-scan-nothing", ledgerBlockedScan.outcome === "nothing-dispatchable", ledgerBlockedScan),
    check("ledger-scan-blocked-key", ledgerBlockedScan.ledger_blocked === "TASK-026", ledgerBlockedScan),
    check("ledger-wrote-question", ledgerWrites.length === 1 && ledgerWrites[0].some((e) => Array.isArray(e.blocks) && e.blocks.includes("task:TASK-026")), ledgerWrites[0]),
    check("ledger-http-scan-started", ledgerHttp.body.reason === "scan-started", ledgerHttp.body.reason),
    check("ledger-no-queue-item", mqLedger.get().length === 0),
    check("ledger-startRun-not-called", ledgerStartRun === 0, ledgerStartRun),
  ];

  const mqHumanLedger = memoryQueue([
    {
      id: "human-ledger-1",
      task: "retry TASK-026 from the human queue",
      repoPath: "/tmp/human-repo",
      branchHint: null,
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      resolvedAt: null,
      note: null,
    },
  ]);
  let humanLedgerStartRun = 0;
  let humanLedgerFetch = 0;
  const humanLedgerHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: mqHumanLedger.load,
    save: mqHumanLedger.save,
    scan: async () => {
      throw new Error("scan must not run on occupied human-queued path");
    },
    repoExists: () => true,
    fetchStaging: async () => {
      humanLedgerFetch += 1;
      throw new Error("fetch must not run when ledger blocks the queue item");
    },
    startRun: () => {
      humanLedgerStartRun += 1;
      throw new Error("startRun must not run when ledger blocks the queue item");
    },
    loadLedger: () => ({ "TASK-026": { outcome: "failed", cleared: false } }),
    saveLedger: () => {},
  });
  const mqHumanCleared = memoryQueue([
    {
      id: "human-cleared-1",
      task: "retry TASK-026 after clear",
      repoPath: "/tmp/human-repo",
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
    },
  ]);
  const humanClearedStarted = [];
  const humanClearedHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: mqHumanCleared.load,
    save: mqHumanCleared.save,
    repoExists: () => true,
    fetchStaging: async () => "cleared-tip",
    startRun: ({ task }) => {
      humanClearedStarted.push(task);
      return { id: "spawn-cleared", pid: 3, logPath: "/tmp/spawn-cleared.log" };
    },
    waitRun: async () => ({ id: "run-cleared", status: "running", run_number: 4 }),
    loadLedger: () => ({ "TASK-026": { outcome: "failed", cleared: true } }),
    saveLedger: () => {},
  });
  const mqUnledgerable = memoryQueue([
    {
      id: "human-no-id",
      task: "human submitted task with no stable id",
      repoPath: "/tmp/human-repo",
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
    },
  ]);
  let unledgerableStartRun = 0;
  const unledgerableHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: mqUnledgerable.load,
    save: mqUnledgerable.save,
    ...memoryLedger(),
    repoExists: () => true,
    fetchStaging: async () => "should-not-fetch",
    startRun: () => {
      unledgerableStartRun += 1;
      throw new Error("startRun must not run on unledgerable item");
    },
  });
  const mq504 = memoryQueue([
    {
      id: "human-504",
      task: "spawn me TASK-026",
      repoPath: "/tmp/human-repo",
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
    },
  ]);
  const ledger504 = memoryLedger();
  const http504 = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: mq504.load,
    save: mq504.save,
    ...ledger504,
    repoExists: () => true,
    fetchStaging: async () => "504-tip",
    startRun: () => ({ id: "spawn-504", pid: 5, logPath: "/tmp/spawn-504.log" }),
    waitRun: async () => null,
  });
  // Snapshot before the follow-up call parks it — see 504-item-* cases below.
  const status504AtReturn = mq504.get()[0]?.status;
  let startAfter504 = 0;
  const after504 = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: mq504.load,
    save: mq504.save,
    ...ledger504,
    repoExists: () => true,
    fetchStaging: async () => "should-not-fetch-after-504",
    startRun: () => {
      startAfter504 += 1;
      throw new Error("startRun must not run after 504 ledgered a failure");
    },
  });
  const clearedWrite = memoryLedger();
  recordLedgerAttempt("TASK-001", { outcome: "failed", cleared: "yes" }, clearedWrite);
  const clearedForcedFalse = clearedWrite.get()["TASK-001"]?.cleared === false;
  recordLedgerAttempt("TASK-001", { outcome: "failed", cleared: true }, clearedWrite);
  const ledgerQueueCases = [
    check("human-ledger-not-dispatched", humanLedgerHttp.body.dispatched === false, humanLedgerHttp.body),
    check("human-ledger-reason", humanLedgerHttp.body.reason === "ledger-blocked", humanLedgerHttp.body.reason),
    check("human-ledger-key", humanLedgerHttp.body.ledger_blocked === "TASK-026", humanLedgerHttp.body),
    // Was "human-ledger-still-pending" until 2026-09-04. It asserted the
    // pre-8-P1 behavior: a ledger-blocked item stayed `pending`. 8-P1
    // (2026-08-29) deliberately changed that — a pending ledger-blocked item
    // halted the whole coordinator, because handleDispatchNext only reaches
    // the roadmap scan when NO pending item exists — so it is now parked as
    // `flagged` and the queue advances. The expectation, not the behavior, was
    // stale. What still matters is that it did not dispatch and did not stay
    // stuck at the head of the queue.
    check("human-ledger-item-parked", mqHumanLedger.get()[0]?.status === "flagged", mqHumanLedger.get()[0]),
    check(
      "human-ledger-park-note-explains",
      String(mqHumanLedger.get()[0]?.note || "").includes("ledger-blocked"),
      mqHumanLedger.get()[0]?.note,
    ),
    check("human-ledger-not-pending", mqHumanLedger.get()[0]?.status !== "pending", mqHumanLedger.get()[0]),
    check("human-ledger-no-startRun", humanLedgerStartRun === 0, humanLedgerStartRun),
    check("human-ledger-no-fetch", humanLedgerFetch === 0, humanLedgerFetch),
    check("human-cleared-dispatched", humanClearedHttp.body.dispatched === true, humanClearedHttp.body),
    check("human-cleared-did-start", humanClearedStarted.length === 1, humanClearedStarted.length),
    check("unledgerable-status-200", unledgerableHttp.status === 200, unledgerableHttp.status),
    check("unledgerable-reason", unledgerableHttp.body.reason === "queue-item-rejected", unledgerableHttp.body),
    check("unledgerable-no-startRun", unledgerableStartRun === 0, unledgerableStartRun),
    check("unledgerable-flagged", mqUnledgerable.get()[0]?.status === "flagged", mqUnledgerable.get()[0]),
    check("504-status", http504.status === 504, http504.status),
    // Was "504-item-still-pending" until 2026-09-04, and stale for the same
    // 8-P1 reason as human-ledger-item-parked above, with one extra wrinkle:
    // this assertion runs after `after504`, the follow-up call. http504 does
    // leave the item pending — it is the follow-up, finding the failure the
    // 504 ledgered, that parks it. Assert both halves rather than the one
    // snapshot, so a regression in either is visible.
    check("504-item-pending-at-504", status504AtReturn === "pending", status504AtReturn),
    check("504-item-parked-after-followup", mq504.get()[0]?.status === "flagged", mq504.get()[0]),
    check("504-item-not-pending-after-followup", mq504.get()[0]?.status !== "pending", mq504.get()[0]),
    check("504-ledger-failed", ledger504.get()["TASK-026"]?.outcome === "failed", ledger504.get()["TASK-026"]),
    check("504-followup-blocked", after504.body.reason === "ledger-blocked", after504.body),
    check("504-followup-no-startRun", startAfter504 === 0, startAfter504),
    check("cleared-nonboolean-not-agent-settable", clearedForcedFalse === true, clearedWrite.get()["TASK-001"]),
    check("cleared-true-only-when-boolean-true", clearedWrite.get()["TASK-001"]?.cleared === true, clearedWrite.get()["TASK-001"]),
  ];

  const bgSlow = backgroundBox();
  const t0 = Date.now();
  const slowHttp = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    ...bgSlow,
    ...memoryScanState(),
    ...memoryLedger(),
    scan: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { outcome: "nothing-dispatchable", open_count: 0, todo_ids: [] };
    },
  });
  const scanStartedWallMs = Date.now() - t0;
  const timingCases = [
    check("async-reason-scan-started", slowHttp.body.reason === "scan-started", slowHttp.body.reason),
    check("async-http-under-1s", scanStartedWallMs < 1000, scanStartedWallMs),
    check("async-has-scanId", typeof slowHttp.body.scanId === "string" && slowHttp.body.scanId.startsWith("scan-"), slowHttp.body.scanId),
  ];
  await bgSlow.flush();

  const mqAdvance = memoryQueue([
    {
      id: "bad-head",
      task: "human submitted task with no stable id",
      repoPath: "/tmp/human-repo",
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: "good-next",
      task: "real work TASK-099",
      repoPath: "/tmp/human-repo",
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
    },
  ]);
  const advanceStarted = [];
  const todoWritesAdvance = [];
  const advanceHttp = await handleDispatchNext({
    findActive: () => null,
    load: mqAdvance.load,
    save: mqAdvance.save,
    ...memoryLedger(),
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    appendTodo: (_repo, draft) => {
      todoWritesAdvance.push(draft);
      return { appended: true, entry: draft };
    },
    repoExists: () => true,
    fetchStaging: async () => "advance-tip",
    startRun: ({ task }) => {
      advanceStarted.push(task);
      return { id: "spawn-advance", pid: 6, logPath: "/tmp/spawn-advance.log" };
    },
    waitRun: async () => ({ id: "run-advance", status: "running", run_number: 5 }),
  });
  const advanceCases = [
    check("advance-dispatched-second", advanceHttp.body.dispatched === true, advanceHttp.body),
    check("advance-head-flagged", mqAdvance.get()[0]?.status === "flagged", mqAdvance.get()[0]),
    check("advance-second-dispatched", mqAdvance.get()[1]?.status === "dispatched", mqAdvance.get()[1]),
    check("advance-started-good-item", advanceStarted.length === 1 && advanceStarted[0].includes("TASK-099"), advanceStarted),
    check("advance-todo-scoped-to-item", todoWritesAdvance[0]?.source === "queue:bad-head" && Array.isArray(todoWritesAdvance[0]?.blocks) && todoWritesAdvance[0].blocks.length === 0, todoWritesAdvance[0]),
  ];

  const stubBlankCases = [
    check("stub-has-blank-lines", STUB_ROADMAP.split("\n").some((line) => line === ""), STUB_ROADMAP),
  ];
  const resolved022 = locateDispatchInRoadmap(STUB_ROADMAP, { title: "TASK-022", description: "", roadmap_ref: "" });
  const resolved019 = locateDispatchInRoadmap(STUB_ROADMAP, { title: "TASK-019", description: "", roadmap_ref: "" });
  const resolvedCases = [
    check("resolved-022-rejected", resolved022.ok === false && resolved022.reason === "item-resolved", resolved022),
    check("resolved-019-rejected", resolved019.ok === false && resolved019.reason === "item-resolved", resolved019),
  ];

  let budgetTicks = 0;
  let budgetErr = null;
  try {
    collectRoadmapPhaseHeadings("a\n\nb\n\nc\n\n", {
      parseBudgetMs: 5,
      now: () => {
        budgetTicks += 1;
        return budgetTicks * 100;
      },
    });
  } catch (err) {
    budgetErr = err;
  }
  const budgetCases = [
    check("parse-budget-throws", budgetErr?.reason === "roadmap-parse-timeout", budgetErr),
    check("parse-budget-did-not-spin", budgetTicks >= 2 && budgetTicks < 20, budgetTicks),
  ];

  // --- Item 8: the scan reads sprints, not phases -----------------------
  //
  // This block used to assert a hardcoded expectation table (TASK-013..035 ->
  // phase:4a/4b/9/10) against the LIVE ROADMAP.md. That table was a snapshot
  // of the pre-reset roadmap, so it went stale the moment the roadmap was
  // rewritten and stayed stale — by 2026-09-04 all 23 of its cases failed,
  // reporting nothing more than "the roadmap changed". The live file is still
  // read, but only for what is true of it by construction (it parses, inside
  // budget, and its own Sprint entries are locatable). Everything about scan
  // SEMANTICS is asserted against fixtures below, which cannot drift.
  const realRoadmapPath = ROADMAP_RELATIVE_PATH;
  const realRoadmapFull = path.join("/mnt/c/Users/lahad/Projects/TheCoach", realRoadmapPath);
  const realRoadmap = fs.readFileSync(realRoadmapFull, "utf-8");
  const realParseT0 = process.hrtime.bigint();
  const realHeadings = collectRoadmapPhaseHeadings(realRoadmap);
  const realParseMs = Number(process.hrtime.bigint() - realParseT0) / 1e6;
  const realSprint1a = locateDispatchInRoadmap(realRoadmap, {
    title: "TASK-027",
    description: "",
    roadmap_ref: "",
  });

  // (a) One sprint entry, one unchecked task line -> that task is dispatchable.
  const FIXTURE_SPRINT_ROADMAP = [
    "# ROADMAP",
    "",
    "## Sprints",
    "",
    "| # | Sprint | Status |",
    "|---|--------|--------|",
    "| 01 | The site is on the internet | In progress |",
    "",
    "### Planned sprints (order set by the developer)",
    "",
    "1. The site is on the internet - TASK-101 lands the entrypoint.",
    "2. The site guards itself - TASK-102.",
    "",
    "### Task placement",
    "",
    "| Task | Sprint |",
    "|------|--------|",
    "| TASK-103 | 01 |",
    "",
    "### Backlog (pulled in by a trigger, not by a sprint number)",
    "",
    "| Task | Trigger |",
    "|------|---------|",
    "| TASK-104 | when the door exists |",
    "",
    "### Sprint entry template (copy per sprint)",
    "",
    "## Sprint NN — <one-line demonstrable flow>",
    "",
    "**Tasks:**",
    "- [ ] <short description> (TASK-nnn)",
    "",
    "## Sprint 01 — The site is on the internet",
    "",
    "**Tasks:**",
    "- [x] Groundwork (TASK-100)",
    "- [ ] Root verify entrypoint (TASK-101)",
  ].join("\n");

  // (b) The same planning material with NO `## Sprint NN` entry at all.
  const FIXTURE_PLANNING_ONLY_ROADMAP = FIXTURE_SPRINT_ROADMAP.slice(
    0,
    FIXTURE_SPRINT_ROADMAP.indexOf("## Sprint 01 — The site is on the internet"),
  );

  // (c) The archived pre-reset roadmap's shape: `## Phase N` headings with
  // unchecked TASK-nnn lines that must never become dispatchable.
  const FIXTURE_ARCHIVED_PHASE_ROADMAP = [
    "# ROADMAP (archived 2026-09-02, pre-reset)",
    "",
    "## Phase 4A — Visual Design System",
    "",
    "- [ ] **Promote design-preview (TASK-025)**",
    "",
    "## Phase 9 — Testing & QA Hardening",
    "",
    "- [ ] **Schema/types drift check (TASK-026)**",
  ].join("\n");

  const fixtureSprintHeadings = collectRoadmapPhaseHeadings(FIXTURE_SPRINT_ROADMAP);
  const fixtureSprintHit = locateDispatchInRoadmap(FIXTURE_SPRINT_ROADMAP, {
    title: "Root verify entrypoint (TASK-101)",
    description: "",
    roadmap_ref: "Sprint 01 — The site is on the internet",
  });
  // The resolved line under the same sprint must still be refused.
  const fixtureSprintResolved = locateDispatchInRoadmap(FIXTURE_SPRINT_ROADMAP, {
    title: "Groundwork (TASK-100)",
    description: "",
    roadmap_ref: "Sprint 01",
  });
  // Ids that appear only in the planned list / placement table / backlog.
  const fixturePlanningOnlyHits = ["TASK-102", "TASK-103", "TASK-104"].map((id) =>
    locateDispatchInRoadmap(FIXTURE_SPRINT_ROADMAP, { title: id, description: "", roadmap_ref: "" }),
  );
  // The template's placeholder heading and placeholder task line.
  const fixtureTemplateHit = locateDispatchInRoadmap(FIXTURE_SPRINT_ROADMAP, {
    title: "TASK-nnn",
    description: "",
    roadmap_ref: "Sprint NN",
  });

  const fixturePlanningHeadings = collectRoadmapPhaseHeadings(FIXTURE_PLANNING_ONLY_ROADMAP);
  const fixturePlanningHits = ["TASK-101", "TASK-102", "TASK-103", "TASK-104"].map((id) =>
    locateDispatchInRoadmap(FIXTURE_PLANNING_ONLY_ROADMAP, { title: id, description: "", roadmap_ref: "" }),
  );

  const fixtureArchivedHeadings = collectRoadmapPhaseHeadings(FIXTURE_ARCHIVED_PHASE_ROADMAP);
  const fixtureArchivedHits = ["TASK-025", "TASK-026"].map((id) =>
    locateDispatchInRoadmap(FIXTURE_ARCHIVED_PHASE_ROADMAP, { title: id, description: "", roadmap_ref: "" }),
  );

  origLog(
    JSON.stringify(
      {
        real_roadmap_parse_ms: realParseMs,
        real_roadmap_path: realRoadmapPath,
        real_headings: realHeadings.map((h) => h.scope),
        real_sprint_1a_TASK_027: realSprint1a.ok ? realSprint1a.filePhase : realSprint1a.reason,
        fixture_a_headings: fixtureSprintHeadings.map((h) => h.scope),
        fixture_a_TASK_101: fixtureSprintHit.ok ? fixtureSprintHit.filePhase : fixtureSprintHit.reason,
        fixture_b_headings: fixturePlanningHeadings.map((h) => h.scope),
        fixture_b_reasons: fixturePlanningHits.map((h) => (h.ok ? h.filePhase : h.reason)),
        fixture_c_headings: fixtureArchivedHeadings.map((h) => h.scope),
        fixture_c_reasons: fixtureArchivedHits.map((h) => (h.ok ? h.filePhase : h.reason)),
      },
      null,
      2,
    ),
  );

  const realParseCases = [
    check("real-roadmap-parse-returns", Number.isFinite(realParseMs) && realParseMs < ROADMAP_PARSE_BUDGET_MS, realParseMs),
    // The scan reads _SSoT/ROADMAP.md and only that. Item 8 (c): the archived
    // copy at _SSoT/archive/ROADMAP_2026-09-02_pre-reset.md must never be read.
    check("real-roadmap-path-is-ssot", realRoadmapPath === path.join("_SSoT", "ROADMAP.md"), realRoadmapPath),
    check("real-roadmap-path-not-archive", !String(realRoadmapPath).includes("archive"), realRoadmapPath),
    // The live roadmap really does use Sprint headings now, and TASK-027 —
    // Sprint 1a's first unchecked task, i.e. re-enable condition (c) — is
    // locatable under one. Before this change every id was item-unlocatable.
    check("real-roadmap-has-sprint-headings", realHeadings.length > 0, realHeadings.map((h) => h.scope)),
    check("real-roadmap-no-phase-scopes", realHeadings.every((h) => h.scope.startsWith("sprint:")), realHeadings.map((h) => h.scope)),
    check("real-sprint-1a-locates-TASK-027", realSprint1a.ok === true, realSprint1a),
    check("real-sprint-1a-scope", realSprint1a.filePhase === "sprint:1a", realSprint1a),

    // --- (a) one sprint entry + one unchecked task -> dispatches that task ---
    check("fixture-a-one-heading", fixtureSprintHeadings.length === 1, fixtureSprintHeadings.map((h) => h.scope)),
    check("fixture-a-heading-scope", fixtureSprintHeadings[0]?.scope === "sprint:01", fixtureSprintHeadings),
    check("fixture-a-locates-task", fixtureSprintHit.ok === true, fixtureSprintHit),
    check("fixture-a-task-id", fixtureSprintHit.taskId === "TASK-101", fixtureSprintHit),
    check("fixture-a-scope", fixtureSprintHit.filePhase === "sprint:01", fixtureSprintHit),
    check("fixture-a-resolved-line-refused", fixtureSprintResolved.ok === false && fixtureSprintResolved.reason === "item-resolved", fixtureSprintResolved),
    // Planned-list / placement-table / backlog ids carry no checkbox, so they
    // are unlocatable even though the file names them.
    ...["TASK-102", "TASK-103", "TASK-104"].map((id, i) =>
      check(`fixture-a-${id}-not-dispatchable`, fixturePlanningOnlyHits[i].ok === false, fixturePlanningOnlyHits[i]),
    ),
    // The `## Sprint NN` template heading is not a sprint, so its placeholder
    // checkbox sits under no heading and cannot be dispatched.
    check("fixture-a-template-not-dispatchable", fixtureTemplateHit.ok === false, fixtureTemplateHit),

    // --- (b) planning material only, no `## Sprint NN` -> dispatches nothing ---
    check("fixture-b-no-headings", fixturePlanningHeadings.length === 0, fixturePlanningHeadings),
    ...["TASK-101", "TASK-102", "TASK-103", "TASK-104"].map((id, i) =>
      check(`fixture-b-${id}-not-dispatchable`, fixturePlanningHits[i].ok === false, fixturePlanningHits[i]),
    ),

    // --- (c) `## Phase N` is never a fallback -----------------------------
    check("fixture-c-phase-headings-ignored", fixtureArchivedHeadings.length === 0, fixtureArchivedHeadings),
    ...["TASK-025", "TASK-026"].map((id, i) =>
      check(`fixture-c-${id}-stays-undispatched`, fixtureArchivedHits[i].ok === false, fixtureArchivedHits[i]),
    ),
  ];

  const idleErr1 = memoryIdle();
  const bgErr1 = backgroundBox();
  const scanErr1 = memoryScanState();
  await handleDispatchNext({
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    loadIdle: idleErr1.loadIdle,
    saveIdle: idleErr1.saveIdle,
    thecoachRepo: "/tmp/idle",
    ...bgErr1,
    ...scanErr1,
    ...memoryLedger(),
    scan: async () => {
      throw new Error("scan boom path1");
    },
  });
  await bgErr1.flush();
  const idleErr2 = memoryIdle();
  const bgErr2 = backgroundBox();
  const scanErr2 = memoryScanState();
  await handleDispatchNext({
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    loadIdle: idleErr2.loadIdle,
    saveIdle: idleErr2.saveIdle,
    thecoachRepo: "/tmp/idle",
    ...bgErr2,
    ...scanErr2,
    ...memoryLedger(),
    scan: async () => ({ outcome: "dispatch", decision: dispatchReply, open_count: 0, todo_ids: [] }),
    repoExists: () => true,
    fetchStaging: async () => "x",
    startRun: () => {
      throw new Error("spawn boom path2");
    },
  });
  await bgErr2.flush();
  const idleErr3 = memoryIdle();
  const bgErr3 = backgroundBox();
  const scanErr3 = memoryScanState();
  let findActiveErr3 = 0;
  await handleDispatchNext({
    findActive: () => {
      findActiveErr3 += 1;
      if (findActiveErr3 === 1) return null;
      throw new Error("unhandled boom path3");
    },
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    loadIdle: idleErr3.loadIdle,
    saveIdle: idleErr3.saveIdle,
    thecoachRepo: "/tmp/idle",
    ...bgErr3,
    ...scanErr3,
    ...memoryLedger(),
    scan: async () => ({ outcome: "dispatch", decision: dispatchReply, open_count: 0, todo_ids: [] }),
  });
  await bgErr3.flush();

  const bgBackstop = backgroundBox();
  const scanBackstop = memoryScanState();
  const backstopFirst = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    ...bgBackstop,
    ...scanBackstop,
    ...memoryLedger(),
    scan: async () => ({
      outcome: "nothing-dispatchable",
      open_count: 0,
      todo_ids: [],
      backstop_rejected: true,
      backstop_reason: "phase-disagreement",
    }),
  });
  await bgBackstop.flush();
  const viewed = publicScanState(scanBackstop);
  const backstopSecond = await handleDispatchNext({
    thecoachRepo: "/tmp/thecoach-does-not-matter",
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    writeTodo: sinkTodo,
    readTodo: emptyTodo,
    enqueueBackground: () => {},
    ...memoryScanState(scanBackstop.get()),
    ...memoryLedger(),
    scan: async () => ({ outcome: "nothing-dispatchable", open_count: 0, todo_ids: [] }),
  });
  const silentFailCases = [
    check("scan-err-path1-reason", scanErr1.get()?.outcome?.reason === "scan-errored", scanErr1.get()),
    check("scan-err-path1-telemetry", idleErr1.get().consecutive_idle === 1, idleErr1.get()),
    check("scan-err-path2-reason", scanErr2.get()?.outcome?.reason === "scan-errored", scanErr2.get()),
    check("scan-err-path2-telemetry", idleErr2.get().consecutive_idle === 1, idleErr2.get()),
    check("scan-err-path3-reason", scanErr3.get()?.outcome?.reason === "scan-errored", scanErr3.get()),
    check("scan-err-path3-telemetry", idleErr3.get().consecutive_idle === 1, idleErr3.get()),
    check("backstop-reason-in-scan-state", viewed.backstop_reason === "phase-disagreement", viewed),
    check("backstop-reason-in-next-response", backstopSecond.body.backstop_reason === "phase-disagreement", backstopSecond.body),
    check("backstop-first-was-scan-started", backstopFirst.body.reason === "scan-started", backstopFirst.body.reason),
  ];

  console.log = origLog;

  const allCases = [
    ...parseCases,
    ...extractCases,
    ...backstopDirectCases,
    ...liveBackstopCases,
    ...bypassLiveCases,
    ...phaseDisagreeCases,
    ...dispatchCases,
    ...blockedScopeCases,
    ...missingScopesCases,
    ...emptyBlocksCases,
    ...missingBlocksCases,
    ...ceilingCases,
    ...belowCeilingCases,
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
    ...overlapCases,
    ...staleCases,
    ...ledgerCases,
    ...ledgerQueueCases,
    ...advanceCases,
    ...stubBlankCases,
    ...resolvedCases,
    ...budgetCases,
    ...realParseCases,
    ...silentFailCases,
    ...timingCases,
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

// Task-file contract — ## Branch is the git branch, ## Tool/model is a gate.
// Does not bind the port, does not spawn workflows, does not touch the live
// queue. Uses TASK-027 and TASK-029's real files as fixtures. Invoke:
//   COORDINATOR_TOKEN=x node local-tools/coordinator-trigger.mjs --self-test-task-contract
// Scoped test for run-id resolution (2026-08-30). Proves a dispatch can never
// resolve to a run that predates it, even when task text is byte-identical.
// Requires a scratch DB:
//   COORDINATOR_TOKEN=x COORDINATOR_ANTFARM_DB=/tmp/rid.db \
//     node local-tools/coordinator-trigger.mjs --self-test-run-id-resolution
if (process.argv.includes("--self-test-run-id-resolution")) {
  const failures = [];
  const check = (label, cond, detail) => {
    if (!cond) failures.push({ label, detail });
    return { case: label, ok: Boolean(cond), detail: cond ? null : detail };
  };

  const realDb = path.join(os.homedir(), ".openclaw", "antfarm", "antfarm.db");
  if (!process.env.COORDINATOR_ANTFARM_DB || path.resolve(ANTFARM_DB) === path.resolve(realDb)) {
    console.error("refusing to run: point COORDINATOR_ANTFARM_DB at a scratch database first");
    process.exit(2);
  }

  const TASK = "REPO: /tmp/r\nBRANCH: b\n\nIdentical task text";
  const OLD_ID = "old-run-0037";
  const NEW_ID = "new-run-0038";
  const OLD_AT = "2026-08-30T17:31:00.426Z";
  const NEW_AT = "2026-08-30T20:10:24.664Z";
  // The dispatch that spawns the new run starts just before the new run exists.
  const DISPATCH_SINCE = "2026-08-30T20:10:23.664Z";

  fs.mkdirSync(path.dirname(ANTFARM_DB), { recursive: true });
  fs.rmSync(ANTFARM_DB, { force: true });
  const seed = new DatabaseSync(ANTFARM_DB);
  seed.exec(
    `CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT, task TEXT,
                        status TEXT, created_at TEXT, updated_at TEXT, run_number INTEGER)`,
  );
  const insert = (id, status, at, n) =>
    seed
      .prepare(
        `INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at, run_number)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, DEFAULT_WORKFLOW, TASK, status, at, at, n);

  // Phase 1 — only the older run exists yet, exactly as at the moment of dispatch.
  insert(OLD_ID, "failed", OLD_AT, 37);
  seed.close();

  const unanchored = await waitForAntfarmRunId(TASK, { timeoutMs: 400, intervalMs: 50 });
  const anchored1 = await waitForAntfarmRunId(TASK, { timeoutMs: 400, intervalMs: 50, since: DISPATCH_SINCE });

  // Phase 2 — the run this dispatch actually spawned lands.
  const db2 = new DatabaseSync(ANTFARM_DB);
  db2
    .prepare(
      `INSERT INTO runs (id, workflow_id, task, status, created_at, updated_at, run_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(NEW_ID, DEFAULT_WORKFLOW, TASK, "running", NEW_AT, NEW_AT, 38);
  db2.close();

  const anchored2 = await waitForAntfarmRunId(TASK, { timeoutMs: 400, intervalMs: 50, since: DISPATCH_SINCE });

  const cases = [
    check("unanchored-reproduces-the-bug", unanchored?.id === OLD_ID, unanchored),
    check("anchored-refuses-stale-run", anchored1 === null, anchored1),
    check("anchored-resolves-new-run", anchored2?.id === NEW_ID, anchored2),
    check("anchored-is-not-stale-run", anchored2?.id !== OLD_ID, anchored2),
    check("anchored-run-number-is-new", anchored2?.run_number === 38, anchored2),
  ];

  fs.rmSync(ANTFARM_DB, { force: true });
  console.log(JSON.stringify({ db: ANTFARM_DB, failures, cases }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

if (process.argv.includes("--self-test-task-contract")) {
  const origLog = console.log;
  console.log = (...args) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[queue/dispatch-next]")) return;
    origLog(...args);
  };
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

  function memoryLedger(initial = {}) {
    let l = JSON.parse(JSON.stringify(initial));
    return {
      loadLedger: () => JSON.parse(JSON.stringify(l)),
      saveLedger: (next) => {
        l = JSON.parse(JSON.stringify(next));
      },
      get: () => l,
    };
  }

  const fixtureRepo =
    (process.env.COORDINATOR_THECOACH_REPO || "").trim() || "/mnt/c/Users/lahad/Projects/TheCoach";
  const task027Path = path.join(fixtureRepo, TASKS_RELATIVE_DIR, "TASK-027-root-verification-entrypoints.md");

  // The 029-* cases prove one thing: a `## Tool/model: Claude Code` task is
  // refused with `unsupported-tool`. They used to read TheCoach's LIVE
  // TASK-029 file to do it. On 2026-09-01 that file gained `## Dispatch:
  // manual` (TODO-0013), which refuses one gate earlier — the refusal is
  // right, but the cases went red and stopped proving anything about
  // Tool/model. Read a fixture instead, so the gate is isolated from whatever
  // the real task file says today. Same cure as item 8's `real-*` block.
  // The live file's `## Dispatch: manual` path stays covered by
  // TASK-137-rls-defense-in-depth-manual.md in --self-test-dispatch-scope-gate.
  const fixture029Repo = fs.mkdtempSync(path.join(os.tmpdir(), "task-contract-029-"));
  const fixture029TasksDir = path.join(fixture029Repo, TASKS_RELATIVE_DIR);
  fs.mkdirSync(fixture029TasksDir, { recursive: true });
  const task029Path = path.join(fixture029TasksDir, "TASK-029-rls-negative-test-suite.md");
  fs.copyFileSync(
    path.join(ANTFARM_ROOT, "tests", "fixtures", "TASK-029-rls-negative-test-suite.md"),
    task029Path,
  );

  const markdown027 = fs.readFileSync(task027Path, "utf-8");
  const markdown029 = fs.readFileSync(task029Path, "utf-8");
  const parsed027 = parseTaskContract(markdown027);
  const parsed029 = parseTaskContract(markdown029);
  const loaded027 = loadTaskContractForId("TASK-027", { thecoachRepo: fixtureRepo });
  const loaded029 = loadTaskContractForId("TASK-029", { thecoachRepo: fixture029Repo });
  const loadedMissing = loadTaskContractForId("TASK-099", { thecoachRepo: fixtureRepo });
  const loadedNoRepo = loadTaskContractForId("TASK-027", { thecoachRepo: "" });

  const parseCases = [
    check("027-parse-ok", parsed027.ok === true, parsed027),
    check("027-branch", parsed027.branch === "fix/root-verification-entrypoints", parsed027),
    check("027-tool", parsed027.tool === "Cursor", parsed027),
    check("029-parse-ok", parsed029.ok === true, parsed029),
    check("029-branch", parsed029.branch === "feature/rls-isolation-tests", parsed029),
    check("029-tool", parsed029.tool === "Claude Code", parsed029),
    check("027-load-ok", loaded027.ok === true && loaded027.branch === parsed027.branch, loaded027),
    check("029-load-ok", loaded029.ok === true && loaded029.tool === "Claude Code", loaded029),
    check("099-missing-fallback", loadedMissing.missing === true && loadedMissing.ok === false, loadedMissing),
    check("no-repo-missing-fallback", loadedNoRepo.missing === true && loadedNoRepo.ok === false, loadedNoRepo),
    check(
      "unparseable-branch-refused",
      parseTaskContract("## Branch\n**Not a TheCoach branch.**\n\n## Tool/model\nCursor\n").ok === false &&
        parseTaskContract("## Branch\n**Not a TheCoach branch.**\n\n## Tool/model\nCursor\n").field === "Branch",
    ),
    check(
      "main-branch-refused",
      parseTaskBranch("main — never this").ok === false && parseTaskBranch("main — never this").reason === "refused-main",
    ),
    check(
      "missing-tool-refused",
      parseTaskContract("## Branch\n`fix/example`\n").ok === false &&
        parseTaskContract("## Branch\n`fix/example`\n").field === "Tool/model",
    ),
    // --- TASK-032: ## Status gate -------------------------------------
    check("status-ready-ok", parseTaskStatus("Ready").ok === true, parseTaskStatus("Ready")),
    check("status-ready-with-trailing-prose-ok", parseTaskStatus("Ready - but reduced in scope 2026-08-26").ok === true),
    check(
      "status-blocked-refused",
      parseTaskStatus("Blocked - do not dispatch until TASK-025 has landed").reason === "status-blocked",
    ),
    check(
      "status-ready-but-blocked-refused",
      parseTaskStatus("Ready — **blocked until PR #22 has merged**").reason === "status-blocked",
    ),
    check(
      "status-hold-refused",
      parseTaskStatus("Ready. **Dispatch: hold** — overlaps TASK-011").reason === "status-blocked",
    ),
    check("status-on-hold-refused", parseTaskStatus("**On hold - rescoped 2026-08-25.**").reason === "status-blocked"),
    check("status-superseded-refused", parseTaskStatus("Superseded 2026-08-25 - see TASK-025").reason === "status-blocked"),
    check("status-done-refused", parseTaskStatus("Done. Merged to main (2026-08-01)").reason === "status-not-ready"),
    check("status-missing-refused", parseTaskStatus("").reason === "missing-or-empty"),
    check("status-null-refused", parseTaskStatus(null).reason === "missing-or-empty"),
    // --- TASK-032: ## Branch base gate --------------------------------
    check(
      "base-cut-from-staging",
      parseTaskBase("`fix/x` - cut from `staging`, merged back into `staging`. Never `main`.").base === "staging",
    ),
    check(
      "base-parenthesised-cut-from-staging",
      parseTaskBase("fix/x (cut from `staging`, merged back into `staging` - never `main`)").base === "staging",
    ),
    check(
      "base-later-paragraph-cannot-flip",
      // TASK-028's real shape: staging in paragraph 1, a historical
      // "continue on feature/..." note in paragraph 2. Paragraph 1 must win.
      parseTaskBase(
        [
          "`fix/x` - cut from `staging`, merged back into `staging`.",
          "",
          "**Updated:** previously said to continue on `feature/phase4-core-web`.",
        ].join(String.fromCharCode(10)),
      ).base === "staging",
    ),
    check(
      "base-off-main-refused",
      parseTaskBase("fix/auth-bootstrap-hardening (new branch off `main`)").reason === "base-refused-main",
    ),
    check(
      "base-continue-existing-refused",
      parseTaskBase("feature/data-model-foundation (continue existing branch)").reason === "base-continue-existing",
    ),
    check(
      "base-stay-on-refused",
      parseTaskBase("Stay on `feature/phase4-core-web` (already the working branch).").reason === "base-continue-existing",
    ),
    check(
      "base-prose-pronoun-refused",
      // "or a `fix/` branch cut from it" must not yield the base "it".
      parseTaskBase("Stay on `feature/x` (or a `fix/` branch cut from it).").reason === "base-unparseable",
    ),
    check("base-unstated-refused", parseTaskBase("`fix/x`").reason === "base-unstated"),
    check("base-missing-refused", parseTaskBase("").reason === "base-missing-or-empty"),
    check(
      "base-non-staging-branch-parsed",
      parseTaskBase("`fix/x` - cut from `feature/phase4-core-web`").base === "feature/phase4-core-web",
    ),
  ];

  function pendingItem(id, task) {
    return {
      id,
      task,
      repoPath: "/tmp/task-contract-repo",
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      resolvedAt: null,
      note: null,
    };
  }

  const mq027 = memoryQueue([pendingItem("q-027", "Add root verification entrypoints TASK-027")]);
  const started027 = [];
  const todos027 = [];
  const http027 = await spawnPendingQueueItem(mq027.get(), 0, {
    ...memoryLedger(),
    thecoachRepo: fixtureRepo,
    save: mq027.save,
    appendTodo: (_repo, draft) => {
      todos027.push(draft);
      return { appended: true, entry: draft };
    },
    repoExists: () => true,
    fetchStaging: async () => "tip-027",
    startRun: ({ task }) => {
      started027.push(task);
      return { id: "spawn-027", pid: 1, logPath: "/tmp/spawn-027.log" };
    },
    waitRun: async () => ({ id: "run-027", status: "running", run_number: 27 }),
  });

  const mq029 = memoryQueue([pendingItem("q-029", "RLS isolation test suite TASK-029")]);
  const started029 = [];
  const todos029 = [];
  const http029 = await spawnPendingQueueItem(mq029.get(), 0, {
    ...memoryLedger(),
    thecoachRepo: fixture029Repo,
    save: mq029.save,
    appendTodo: (_repo, draft) => {
      todos029.push(draft);
      return { appended: true, entry: draft };
    },
    repoExists: () => true,
    fetchStaging: async () => {
      throw new Error("fetchStaging must not run on a Tool/model refusal");
    },
    startRun: ({ task }) => {
      started029.push(task);
      throw new Error("startRun must not run on a Tool/model refusal");
    },
    waitRun: async () => {
      throw new Error("waitRun must not run on a Tool/model refusal");
    },
  });

  // --- TASK-032: a Blocked task file must never reach startRun ---------
  // TASK-028 is genuinely `## Status: Blocked` in the working checkout.
  const mq028 = memoryQueue([pendingItem("q-028", "Consolidate completeness logic TASK-028")]);
  const started028 = [];
  const todos028 = [];
  const http028 = await spawnPendingQueueItem(mq028.get(), 0, {
    ...memoryLedger(),
    thecoachRepo: fixtureRepo,
    save: mq028.save,
    appendTodo: (_repo, draft) => {
      todos028.push(draft);
      return { appended: true, entry: draft };
    },
    repoExists: () => true,
    fetchStaging: async () => {
      throw new Error("fetchStaging must not run on a Status refusal");
    },
    startRun: ({ task }) => {
      started028.push(task);
      throw new Error("startRun must not run on a Status refusal");
    },
    waitRun: async () => {
      throw new Error("waitRun must not run on a Status refusal");
    },
  });

  // --- TASK-032: a non-staging base must never reach startRun ----------
  // Synthetic contract: the workflow's setup step can only cut from staging,
  // so a task naming feature/phase4-core-web is refused, not silently cut
  // from staging. This is the run #17 failure class.
  const mqBase = memoryQueue([pendingItem("q-base", "Continue phase 4 work TASK-025")]);
  const startedBase = [];
  const todosBase = [];
  const httpBase = await spawnPendingQueueItem(mqBase.get(), 0, {
    ...memoryLedger(),
    thecoachRepo: fixtureRepo,
    save: mqBase.save,
    loadTaskContract: () => ({
      ok: true,
      branch: "feature/promote-design-preview",
      tool: "Cursor",
      markdown: "# TASK-025",
      dispatch: "auto",
      status: { ok: true, field: "Status", status: "Ready" },
      base: { ok: true, field: "Branch", base: "feature/phase4-core-web" },
    }),
    appendTodo: (_repo, draft) => {
      todosBase.push(draft);
      return { appended: true, entry: draft };
    },
    repoExists: () => true,
    fetchStaging: async () => {
      throw new Error("fetchStaging must not run on a base refusal");
    },
    startRun: ({ task }) => {
      startedBase.push(task);
      throw new Error("startRun must not run on a base refusal");
    },
    waitRun: async () => {
      throw new Error("waitRun must not run on a base refusal");
    },
  });

  const mqAdHoc = memoryQueue([pendingItem("q-adhoc", "README comment proof TASK-099")]);
  const startedAdHoc = [];
  // --- TASK-044: a broken repo path must refuse, not dispatch on defaults ---
  const brokenRepo = `${fixtureRepo}-DOES-NOT-EXIST`;
  const loadedBrokenRepo = loadTaskContractForId("TASK-028", { thecoachRepo: brokenRepo });
  const gatesBrokenRepo = evaluateHostDispatchGates("TASK-028", loadedBrokenRepo);
  // Same blocked/unsupported ids as the live repro, so a regression shows up as
  // "TASK-028 dispatched again" rather than as a silent shape change.
  const brokenRepoGates = ["TASK-027", "TASK-028", "TASK-029"].map((id) =>
    evaluateHostDispatchGates(id, loadTaskContractForId(id, { thecoachRepo: brokenRepo })),
  );
  const mqBroken = memoryQueue([pendingItem("q-broken", "Status-blocked task TASK-028")]);
  const startedBroken = [];
  const todosBroken = [];
  const httpBroken = await spawnPendingQueueItem(mqBroken.get(), 0, {
    ...memoryLedger(),
    thecoachRepo: brokenRepo,
    save: mqBroken.save,
    appendTodo: (_repo, draft) => {
      todosBroken.push(draft);
      return { appended: true };
    },
    repoExists: () => true,
    fetchStaging: async () => "tip-broken",
    startRun: ({ task }) => {
      startedBroken.push(task);
      return { id: "spawn-broken", pid: 3, logPath: "/tmp/spawn-broken.log" };
    },
    waitRun: async () => ({ id: "run-broken", status: "running", run_number: 100 }),
  });

  const httpAdHoc = await spawnPendingQueueItem(mqAdHoc.get(), 0, {
    ...memoryLedger(),
    thecoachRepo: fixtureRepo,
    save: mqAdHoc.save,
    appendTodo: () => ({ appended: false, reason: "unused" }),
    repoExists: () => true,
    fetchStaging: async () => "tip-adhoc",
    startRun: ({ task }) => {
      startedAdHoc.push(task);
      return { id: "spawn-adhoc", pid: 2, logPath: "/tmp/spawn-adhoc.log" };
    },
    waitRun: async () => ({ id: "run-adhoc", status: "running", run_number: 99 }),
  });

  const brokenRepoCases = [
    // The bug: an unreadable repo reported missing:true, and missing:true
    // skips Status, Tool/model and Branch-base in evaluateHostDispatchGates.
    check("044-broken-repo-not-missing", loadedBrokenRepo.missing === false, loadedBrokenRepo),
    check("044-broken-repo-not-ok", loadedBrokenRepo.ok === false, loadedBrokenRepo),
    check("044-broken-repo-reason", loadedBrokenRepo.reason === THECOACH_REPO_UNREADABLE, loadedBrokenRepo),
    check("044-broken-repo-field", loadedBrokenRepo.field === "repo-path", loadedBrokenRepo),
    check("044-broken-repo-names-path", typeof loadedBrokenRepo.path === "string" && loadedBrokenRepo.path.includes(brokenRepo), loadedBrokenRepo),
    check("044-broken-repo-gate-refuses", gatesBrokenRepo.dispatched !== true, gatesBrokenRepo),
    check("044-broken-repo-gate-reason", gatesBrokenRepo.reason === THECOACH_REPO_UNREADABLE, gatesBrokenRepo),
    // The live repro, as a case: nothing dispatches on a broken path.
    check("044-broken-repo-nothing-dispatches", brokenRepoGates.every((g) => g.dispatched !== true), brokenRepoGates),
    // Queue path: refuse, stay pending, never start a run.
    check("044-queue-not-dispatched", httpBroken.body.dispatched === false, httpBroken.body),
    check("044-queue-reason", httpBroken.body.reason === THECOACH_REPO_UNREADABLE, httpBroken.body),
    check("044-queue-startRun-never", startedBroken.length === 0, startedBroken),
    // Not flagged: the item is fine, the operator's path is not. Flagging it
    // would lose the work behind a misconfiguration that is about to be fixed.
    check("044-queue-item-still-pending", mqBroken.get()[0]?.status === "pending", mqBroken.get()[0]),
    // One human-visible signal, global-blocking, not one per queue item.
    check("044-one-todo-written", todosBroken.length === 1, todosBroken),
    check("044-todo-blocks-globally", todosBroken[0]?.blocks?.includes(SCOPE_GLOBAL) === true, todosBroken[0]),
    check("044-todo-names-repo", String(todosBroken[0]?.summary || "").includes(brokenRepo), todosBroken[0]),
    // Regression guard for the genuinely-absent case TASK-032 established:
    // a readable repo with no TASK-099 file still falls back, unchanged.
    check("044-genuine-gap-still-missing", loadedMissing.missing === true, loadedMissing),
  ];

  const dispatchCases = [
    check("027-dispatched", http027.body.dispatched === true, http027.body),
    check("027-branch-literal", http027.body.branch === "fix/root-verification-entrypoints", http027.body.branch),
    check(
      "027-task-text-branch",
      started027[0]?.includes("BRANCH: fix/root-verification-entrypoints"),
      started027[0],
    ),
    check(
      "027-not-hardcoded",
      !started027[0]?.includes("BRANCH: feature/thecoach-dev-coordinator-q-027"),
      started027[0],
    ),
    check("027-no-todo", todos027.length === 0, todos027),
    check("029-not-dispatched", http029.body.dispatched === false, http029.body),
    check("029-reason-rejected", http029.body.reason === "queue-item-rejected", http029.body.reason),
    check("029-field-tool", http029.body.contract_field === "Tool/model", http029.body),
    check("029-reason-unsupported", http029.body.contract_reason === "unsupported-tool", http029.body),
    check("029-value-claude", http029.body.contract_value === "Claude Code", http029.body),
    check("029-item-flagged", mq029.get()[0]?.status === "flagged", mq029.get()[0]),
    check(
      "029-note-names-field",
      typeof mq029.get()[0]?.note === "string" &&
        mq029.get()[0].note.includes("TASK-029") &&
        mq029.get()[0].note.includes("Tool/model") &&
        mq029.get()[0].note.includes("Claude Code"),
      mq029.get()[0]?.note,
    ),
    check("029-startRun-never", started029.length === 0, started029),
    check("029-todo-written", todos029.length === 1, todos029),
    check(
      "029-todo-blocks-task",
      Array.isArray(todos029[0]?.blocks) && todos029[0].blocks.includes("task:TASK-029"),
      todos029[0],
    ),
    check(
      "029-todo-summary-names-field",
      typeof todos029[0]?.summary === "string" &&
        todos029[0].summary.includes("TASK-029") &&
        todos029[0].summary.includes("Tool/model") &&
        todos029[0].summary.includes("Claude Code"),
      todos029[0]?.summary,
    ),
    // --- TASK-032: Status gate, end to end ---------------------------
    check("028-not-dispatched", http028.body.dispatched === false, http028.body),
    check("028-field-status", http028.body.contract_field === "Status", http028.body),
    check("028-reason-blocked", http028.body.contract_reason === "status-blocked", http028.body),
    check("028-startRun-never", started028.length === 0, started028),
    check("028-item-flagged", mq028.get()[0]?.status === "flagged", mq028.get()[0]),
    check(
      "028-note-names-task-field-and-status",
      typeof mq028.get()[0]?.note === "string" &&
        mq028.get()[0].note.includes("TASK-028") &&
        mq028.get()[0].note.includes("Status") &&
        mq028.get()[0].note.includes("Blocked"),
      mq028.get()[0]?.note,
    ),
    check("028-todo-written", todos028.length === 1, todos028),
    check(
      "028-todo-blocks-task",
      Array.isArray(todos028[0]?.blocks) && todos028[0].blocks.includes("task:TASK-028"),
      todos028[0],
    ),
    // --- TASK-032: base gate, end to end -----------------------------
    check("base-not-dispatched", httpBase.body.dispatched === false, httpBase.body),
    check("base-field-branch", httpBase.body.contract_field === "Branch", httpBase.body),
    check("base-reason-unsupported", httpBase.body.contract_reason === "unsupported-base", httpBase.body),
    check("base-value-named", httpBase.body.contract_value === "feature/phase4-core-web", httpBase.body),
    check("base-startRun-never", startedBase.length === 0, startedBase),
    check("base-item-flagged", mqBase.get()[0]?.status === "flagged", mqBase.get()[0]),
    check(
      "base-note-names-task-and-base",
      typeof mqBase.get()[0]?.note === "string" &&
        mqBase.get()[0].note.includes("TASK-025") &&
        mqBase.get()[0].note.includes("Branch") &&
        mqBase.get()[0].note.includes("feature/phase4-core-web"),
      mqBase.get()[0]?.note,
    ),
    check("base-todo-written", todosBase.length === 1, todosBase),
    check("adhoc-dispatched", httpAdHoc.body.dispatched === true, httpAdHoc.body),
    check(
      "adhoc-hardcoded-branch",
      httpAdHoc.body.branch === "feature/thecoach-dev-coordinator-q-adhoc",
      httpAdHoc.body.branch,
    ),
    check(
      "adhoc-task-text-hardcoded",
      startedAdHoc[0]?.includes("BRANCH: feature/thecoach-dev-coordinator-q-adhoc"),
      startedAdHoc[0],
    ),
  ];

  const allCases = [...parseCases, ...dispatchCases, ...brokenRepoCases];
  const report = {
    ok: failures.length === 0,
    failed: failures.length,
    failures,
    cases: allCases,
    fixtures: { task027Path, task029Path, fixtureRepo },
    // The human-facing text each refusal produces, so a reviewer can read the
    // wording without re-deriving it from the templates.
    refusal_notes: {
      "TASK-029 Tool/model": { note: mq029.get()[0]?.note, todo: todos029[0]?.summary, reply_needed: todos029[0]?.reply_needed },
      "TASK-028 Status": { note: mq028.get()[0]?.note, todo: todos028[0]?.summary, reply_needed: todos028[0]?.reply_needed },
      "TASK-025 Branch base": { note: mqBase.get()[0]?.note, todo: todosBase[0]?.summary, reply_needed: todosBase[0]?.reply_needed },
    },
  };
  origLog(JSON.stringify(report, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

// Dry-run the host-side dispatch gates against a TheCoach checkout's
// _SSoT/tasks/ without startRun. Invoke:
//   COORDINATOR_TOKEN=x node local-tools/coordinator-trigger.mjs --eval-dispatch-gates
if (process.argv.includes("--eval-dispatch-gates")) {
  const repo =
    process.env.COORDINATOR_EVAL_TASKS_REPO ||
    process.env.COORDINATOR_THECOACH_REPO ||
    DEFAULT_QUEUE_REPO_PATH;
  // COORDINATOR_EVAL_TASK_IDS overrides the default sample so a specific
  // case can be dry-run without editing this file. Comma/space separated.
  const idsOverride = (process.env.COORDINATOR_EVAL_TASK_IDS || "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const ids = idsOverride.length > 0 ? idsOverride : ["TASK-023", "TASK-033", "TASK-037", "TASK-038", "TASK-039"];
  const ledger = loadLedger();
  const results = ids.map((id) => {
    const contract = loadTaskContractForId(id, { thecoachRepo: repo });
    const gates = evaluateHostDispatchGates(id, contract);
    const scope =
      contract.missing || !contract.markdown
        ? { skipped: true, matches: [] }
        : evaluateTaskScopeGate(contract.markdown);
    return {
      task: id,
      missing: Boolean(contract.missing),
      dispatch: contract.missing ? null : contract.dispatch,
      tool: contract.ok ? contract.tool : null,
      status_ok: contract.missing ? null : contract.status?.ok === true,
      status_value: contract.missing ? null : (contract.status?.status ?? contract.status?.value ?? null),
      base_parsed: contract.missing ? null : (contract.base?.ok ? contract.base.base : contract.base?.reason ?? null),
      ledger_blocked: ledgerBlocksKey(ledger, id),
      ledger_cleared: ledger[id]?.cleared === true,
      scope_matches: scope.matches ?? [],
      scope_skipped: Boolean(scope.skipped),
      ...gates,
    };
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: true,
        repo,
        patterns: [...PROTECTED_PATH_PATTERNS],
        results,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Dispatch-time A1/A2 against tests/fixtures copies. Invoke:
//   COORDINATOR_TOKEN=x node local-tools/coordinator-trigger.mjs --self-test-dispatch-scope-gate
if (process.argv.includes("--self-test-dispatch-scope-gate")) {
  const origLog = console.log;
  const captured = [];
  console.log = (...args) => {
    const line = args.map(String).join(" ");
    captured.push(line);
    if (line.startsWith("[queue/dispatch-next]")) return;
    origLog(...args);
  };
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
  function memoryLedger(initial = {}) {
    let l = JSON.parse(JSON.stringify(initial));
    return {
      loadLedger: () => JSON.parse(JSON.stringify(l)),
      saveLedger: (next) => {
        l = JSON.parse(JSON.stringify(next));
      },
      get: () => l,
    };
  }
  function pendingItem(id, task) {
    return {
      id,
      task,
      repoPath: "/tmp/dispatch-scope-repo",
      status: "pending",
      runId: null,
      createdAt: new Date().toISOString(),
      dispatchedAt: null,
      resolvedAt: null,
      note: null,
    };
  }

  const fixtureSrc = path.join(ANTFARM_ROOT, "tests", "fixtures");
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-scope-gate-"));
  const tasksDir = path.join(fixtureRoot, "_SSoT", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const name of [
    "TASK-033-ci-typecheck-and-tests.md",
    "TASK-037-rls-defense-in-depth.md",
    "TASK-038-ci-dependency-secret-scanning.md",
    "TASK-137-rls-defense-in-depth-manual.md",
    "TASK-040-apps-only.md",
    "TASK-041-no-expected-files.md",
  ]) {
    fs.copyFileSync(path.join(fixtureSrc, name), path.join(tasksDir, name));
  }
  const cases = [];

  async function runSpawn(taskId, taskText, extraDeps = {}) {
    const mq = memoryQueue([pendingItem(`q-${taskId}`, taskText)]);
    const ledger = memoryLedger();
    const started = [];
    const todos = [];
    const http = await spawnPendingQueueItem(mq.get(), 0, {
      ...ledger,
      thecoachRepo: fixtureRoot,
      save: mq.save,
      appendTodo: (_repo, draft) => {
        todos.push(draft);
        return { appended: true, entry: draft };
      },
      repoExists: () => true,
      fetchStaging: async () => "tip",
      startRun: ({ task }) => {
        started.push(task);
        return { id: `spawn-${taskId}`, pid: 1, logPath: "/tmp/spawn.log" };
      },
      waitRun: async () => ({ id: `run-${taskId}`, status: "running", run_number: 1 }),
      ...extraDeps,
    });
    return { http, mq, started, todos, ledger };
  }

  const r033 = await runSpawn("TASK-033", "CI typecheck TASK-033");
  cases.push(check("033-refused", r033.http.body.dispatched === false, r033.http.body));
  cases.push(check("033-reason", r033.http.body.reason === "protected-path-scope", r033.http.body.reason));
  cases.push(
    check(
      "033-match-ci-yml",
      Array.isArray(r033.http.body.matches) &&
        r033.http.body.matches.some(
          (m) => m.path.includes(".github/workflows/ci.yml") && m.pattern === ".github/**",
        ),
      r033.http.body.matches,
    ),
  );
  cases.push(check("033-no-startRun", r033.started.length === 0, r033.started));
  cases.push(
    check(
      "033-ledger-failed",
      r033.ledger.get()["TASK-033"]?.outcome === "failed" &&
        r033.ledger.get()["TASK-033"]?.reason === "protected-path-scope",
      r033.ledger.get(),
    ),
  );
  cases.push(
    check(
      "033-todo-blocks",
      r033.todos.length === 1 && Array.isArray(r033.todos[0].blocks) && r033.todos[0].blocks.includes("task:TASK-033"),
      r033.todos,
    ),
  );

  const r037 = await runSpawn("TASK-037", "RLS defense TASK-037");
  cases.push(check("037-refused", r037.http.body.dispatched === false, r037.http.body));
  cases.push(
    check(
      "037-reason-first-gate",
      r037.http.body.reason === "queue-item-rejected" || r037.http.body.reason === "protected-path-scope",
      r037.http.body.reason,
    ),
  );
  cases.push(check("037-no-startRun", r037.started.length === 0, r037.started));

  const r038 = await runSpawn("TASK-038", "CI secret scan TASK-038");
  cases.push(check("038-refused", r038.http.body.dispatched === false, r038.http.body));
  cases.push(check("038-reason", r038.http.body.reason === "protected-path-scope", r038.http.body.reason));
  cases.push(
    check(
      "038-match-workflows",
      Array.isArray(r038.http.body.matches) &&
        r038.http.body.matches.some((m) => m.pattern === ".github/**"),
      r038.http.body.matches,
    ),
  );

  const rManual = await runSpawn("TASK-137", "RLS defense TASK-137");
  cases.push(check("manual-refused", rManual.http.body.dispatched === false, rManual.http.body));
  cases.push(
    check("manual-reason", rManual.http.body.reason === "not-dispatchable-manual", rManual.http.body.reason),
  );
  cases.push(check("manual-no-todo", rManual.todos.length === 0, rManual.todos));
  cases.push(check("manual-no-startRun", rManual.started.length === 0, rManual.started));
  cases.push(
    check("manual-no-ledger", Object.keys(rManual.ledger.get()).length === 0, rManual.ledger.get()),
  );

  const rApps = await runSpawn("TASK-040", "Apps only TASK-040");
  cases.push(check("apps-dispatched", rApps.http.body.dispatched === true, rApps.http.body));
  cases.push(check("apps-startRun", rApps.started.length === 1, rApps.started));

  captured.length = 0;
  const rSkip = await runSpawn("TASK-041", "No expected files TASK-041");
  cases.push(check("skip-dispatched", rSkip.http.body.dispatched === true, rSkip.http.body));
  cases.push(
    check(
      "skip-log",
      captured.some((l) => l.includes(SCOPE_GATE_SKIPPED_LOG)),
      captured,
    ),
  );

  const report = {
    ok: failures.length === 0,
    failed: failures.length,
    failures,
    cases,
    patterns: [...PROTECTED_PATH_PATTERNS],
  };
  origLog(JSON.stringify(report, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

// Drive the production auto-retry path against a real antfarm run in the
// isolated test DB. Resume is the real CLI (`workflow resume`), not a stub.
// Ambiguous (fixable) failures enqueue a diagnosis job; this eval drains it
// so all three classes can run end to end. Invoke:
//   COORDINATOR_TOKEN=x node local-tools/coordinator-trigger.mjs --eval-auto-retry-resume <run-id>
// Optional: COORDINATOR_EVAL_DIAGNOSIS_REPLY='{"class":"fixable",...}' — same
// runDiagnosisAgent seam the self-test uses. Unset → production openclaw turn.
if (process.argv.includes("--eval-auto-retry-resume")) {
  const idx = process.argv.indexOf("--eval-auto-retry-resume");
  const runIdParam = process.argv[idx + 1];
  if (!runIdParam || runIdParam.startsWith("-")) {
    console.error("usage: --eval-auto-retry-resume <run-id>");
    process.exit(1);
  }
  const taskId = process.env.COORDINATOR_EVAL_TASK_ID || "TASK-940";
  const run = getRunStatus(runIdParam);
  let stepsResult;
  try {
    stepsResult = queryStepsForRun(runIdParam);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
    process.exit(1);
  }
  const item = {
    id: "eval-auto-retry-resume",
    task: `${taskId}: synthetic resume eval`,
    repoPath: "/tmp/auto-retry-repo",
    branch: "fix/auto-retry-resume",
    status: "failed",
    runId: runIdParam,
    createdAt: "2026-08-31T00:00:00.000Z",
    dispatchedAt: "2026-08-31T00:01:00.000Z",
    resolvedAt: "2026-08-31T00:02:00.000Z",
    note: 'run status is "failed" — not a successful completion',
    roadmap_ref: null,
  };
  const mq = [];
  const ledger = {};
  const todos = [];
  const diagnosisJobs = [];
  const evalDeps = {
    loadLedger: () => JSON.parse(JSON.stringify(ledger)),
    saveLedger: (next) => {
      for (const key of Object.keys(ledger)) delete ledger[key];
      Object.assign(ledger, next);
    },
    load: () => mq,
    save: (next) => {
      mq.length = 0;
      mq.push(...next);
    },
    thecoachRepo: "/tmp/thecoach",
    appendTodo: (_repo, draft) => {
      todos.push(draft);
      return { appended: true, entry: draft };
    },
    branchDiff: () => ({ ran: false, digest: null, files: [], error: "eval" }),
    enqueueBackground: (job) => {
      diagnosisJobs.push(job);
    },
  };
  const diagnosisReply = process.env.COORDINATOR_EVAL_DIAGNOSIS_REPLY;
  if (diagnosisReply) {
    evalDeps.runDiagnosisAgent = async () => JSON.stringify({ ok: true, final: String(diagnosisReply) });
  }
  let result = handleFailedRunOutcome(
    {
      ledgerKey: taskId,
      item,
      queue: mq,
      runStatus: run?.status || FAILED_RUN_STATUS,
      queueStatus: "failed",
      stepsResult,
    },
    evalDeps,
  );
  const initialOutcome = result?.outcome;
  for (const job of diagnosisJobs) {
    result = await job();
  }
  const runAfter = getRunStatus(runIdParam);
  console.log(
    JSON.stringify(
      {
        ok: true,
        initialOutcome,
        diagnosisJobs: diagnosisJobs.length,
        result,
        queue: mq,
        ledger: ledger[taskId] || null,
        todos,
        runBefore: run,
        runAfter,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Item 8 / Item 7 / 8-P1 / 8-P2 mechanical self-check. No port, no network,
// no real ledger/queue/TODO file — every dependency is injected. Invoke:
//   COORDINATOR_TOKEN=x node local-tools/coordinator-trigger.mjs --self-test-auto-retry
if (process.argv.includes("--self-test-auto-retry")) {
  const origLog = console.log;
  const captured = [];
  console.log = (...args) => {
    const line = args.map(String).join(" ");
    captured.push(line);
    if (line.startsWith("[queue/dispatch-next]")) return;
    origLog(...args);
  };

  const failures = [];
  const cases = [];
  function check(label, cond, detail) {
    if (!cond) failures.push({ label, detail });
    cases.push({ case: label, ok: Boolean(cond), detail: cond ? null : detail });
  }

  function memoryQueue(initial = []) {
    let q = initial;
    return { load: () => q, save: (next) => { q = next; }, get: () => q };
  }
  function memoryLedger(initial = {}) {
    let l = JSON.parse(JSON.stringify(initial));
    return {
      loadLedger: () => JSON.parse(JSON.stringify(l)),
      saveLedger: (next) => { l = JSON.parse(JSON.stringify(next)); },
      get: () => l,
    };
  }
  function memoryIdle(initial = defaultIdleState()) {
    let state = { ...initial };
    return {
      loadIdle: () => ({ ...state }),
      saveIdle: (_repo, next) => { state = { ...next }; },
      get: () => state,
    };
  }
  function failedItem(id, taskId, extra = {}) {
    return {
      id,
      task: `${taskId}: do the thing`,
      repoPath: "/tmp/auto-retry-repo",
      branch: "fix/auto-retry",
      status: "failed",
      runId: `run-${id}`,
      createdAt: "2026-08-29T00:00:00.000Z",
      dispatchedAt: "2026-08-29T00:01:00.000Z",
      resolvedAt: "2026-08-29T00:02:00.000Z",
      note: 'run status is "failed" — not a successful completion',
      roadmap_ref: null,
      ...extra,
    };
  }
  function pendingItem(id, task) {
    return {
      id,
      task,
      repoPath: "/tmp/auto-retry-repo",
      status: "pending",
      runId: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      dispatchedAt: null,
      resolvedAt: null,
      note: null,
    };
  }
  function stepsFixture(output, stepId = "implement") {
    return {
      found: true,
      run: { id: "run-x", workflowId: DEFAULT_WORKFLOW, status: "failed", runNumber: 99 },
      steps: [
        { stepId: "plan", status: "done", output: "ok", retryCount: 0, maxRetries: 1 },
        { stepId, status: "failed", output, retryCount: 2, maxRetries: 2 },
      ],
    };
  }
  const agentReply = (obj) => JSON.stringify({ ok: true, final: JSON.stringify(obj) });
  const FIXABLE = {
    class: "fixable",
    reason: "the story's tests were never written",
    evidence: "implement: STATUS: blocked",
    retry_guidance: "write the test file named in the story before committing",
  };
  const STRUCTURAL = {
    class: "structural",
    reason: "the task's deliverable is a policy contradiction",
    evidence: "implement: cannot proceed",
    retry_guidance: "",
  };

  // Shared harness: run handleFailedRunOutcome, then drain the background job.
  async function runFailure(opts) {
    const ledger = memoryLedger(opts.ledger || {});
    const mq = memoryQueue(opts.queue || []);
    const todos = [];
    const jobs = [];
    let agentCalls = 0;
    const resumeCalls = [];
    const deps = {
      ...ledger,
      load: mq.load,
      save: mq.save,
      thecoachRepo: "/tmp/thecoach",
      appendTodo: (_repo, draft) => { todos.push(draft); return { appended: true, entry: draft }; },
      branchDiff: () => opts.diff || { ran: false, digest: null, files: [], error: "no repo" },
      enqueueBackground: (job) => { jobs.push(job); },
      loadTaskContract: () => ({ ok: true, branch: "fix/auto-retry", tool: "Cursor", markdown: "# task" }),
      runDiagnosisAgent: async (prompt) => {
        agentCalls += 1;
        if (opts.agentThrows) throw new Error("openclaw agent failed: boom");
        if (opts.agentGarbage) return JSON.stringify({ ok: true, final: "not json at all" });
        return agentReply(opts.agentReply || FIXABLE);
      },
      now: () => Date.parse("2026-08-29T12:00:00.000Z"),
      getRunStatus: opts.getRunStatus || (() => ({ status: opts.liveRunStatus || "failed" })),
      resumeRun: (id) => {
        resumeCalls.push(id);
        if (opts.resumeSucceeds) return { ok: true, stdout: `Resumed run ${id.slice(0, 8)} from step "implement"` };
        if (opts.resumeThrows) throw new Error("resume exploded");
        return { ok: false, error: opts.resumeError || "resume not available in harness" };
      },
    };
    const liveQueue = opts.liveQueue === false ? null : mq.get();
    const result = handleFailedRunOutcome(
      {
        ledgerKey: opts.taskId,
        item: opts.item,
        queue: liveQueue,
        runStatus: "failed",
        queueStatus: "failed",
        stepsResult: opts.steps || stepsFixture("STATUS: blocked\nREASON: something specific and new"),
      },
      deps,
    );
    let finished = result;
    for (const job of jobs) finished = await job();
    return { result, finished, ledger, mq, todos, agentCalls, deps, resumeCalls };
  }

  // 1. fixable + attempts 0 -> retry-pending, item pushed with feedback, NO todo
  {
    const item = failedItem("q1", "TASK-901");
    const r = await runFailure({ taskId: "TASK-901", item, queue: [item] });
    const entry = r.ledger.get()["TASK-901"];
    const pushed = r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE);
    check("1a-retry-pending", entry?.outcome === LEDGER_OUTCOME_RETRY_PENDING, entry);
    check("1b-not-blocking", ledgerBlocksKey(r.ledger.get(), "TASK-901") === false, entry);
    check("1c-attempts-1", entry?.autoRetry?.attempts === 1, entry?.autoRetry);
    check("1d-item-pushed", pushed.length === 1, r.mq.get().length);
    check("1e-feedback", pushed[0] && pushed[0].task.includes("DO DIFFERENTLY: write the test file"), pushed[0]?.task);
    check("1f-class-in-feedback", pushed[0] && pushed[0].task.includes("CLASS: fixable"), pushed[0]?.task);
    check("1g-no-todo", r.todos.length === 0, r.todos);
    check("1h-agent-called", r.agentCalls === 1, r.agentCalls);
    check("1i-history", entry?.autoRetry?.history?.length === 1, entry?.autoRetry?.history);
  }

  // 2. transient (deterministic signature) -> retry with NO feedback block, no agent turn
  {
    const item = failedItem("q2", "TASK-902");
    const r = await runFailure({
      taskId: "TASK-902",
      item,
      queue: [item],
      steps: stepsFixture("ENGINE_ERROR: openclaw agent failed: gateway unreachable"),
    });
    const entry = r.ledger.get()["TASK-902"];
    const pushed = r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE);
    check("2a-retry-pending", entry?.outcome === LEDGER_OUTCOME_RETRY_PENDING, entry);
    check("2b-transient-class", entry?.autoRetry?.lastDiagnosis?.class === "transient", entry?.autoRetry?.lastDiagnosis);
    check("2c-no-feedback", pushed[0] && !pushed[0].task.includes(AUTO_RETRY_FEEDBACK_HEADER), pushed[0]?.task);
    check("2d-no-agent-turn", r.agentCalls === 0, r.agentCalls);
    check("2e-attempts-1", entry?.autoRetry?.attempts === 1, entry?.autoRetry);
    check("2f-resume-attempted-then-fell-back", r.resumeCalls.length === 1 && r.resumeCalls[0] === item.runId, r.resumeCalls);
    check("2g-fallback-pending", pushed[0] && pushed[0].status === "pending" && pushed[0].runId === null, pushed[0]);
  }

  // 3. attempts already at cap -> park, todo written, no retry pushed
  {
    const item = failedItem("q3", "TASK-903");
    const r = await runFailure({
      taskId: "TASK-903",
      item,
      queue: [item],
      ledger: {
        "TASK-903": {
          key: "TASK-903",
          outcome: "retry-pending",
          autoRetry: { attempts: 2, cap: 2, parked: false, parkedReason: null, lastDiagnosis: null, history: [
            { at: "2026-08-29T10:00:00.000Z", class: "fixable", reason: "older reason one", diffHash: null },
            { at: "2026-08-29T11:00:00.000Z", class: "fixable", reason: "older reason two", diffHash: null },
          ] },
        },
      },
    });
    const entry = r.ledger.get()["TASK-903"];
    check("3a-failed", entry?.outcome === LEDGER_OUTCOME_FAILED, entry);
    check("3b-blocking", ledgerBlocksKey(r.ledger.get(), "TASK-903") === true, entry);
    check("3c-cap-reached", entry?.autoRetry?.parkedReason === "cap-reached", entry?.autoRetry);
    check("3d-no-retry", r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE).length === 0, r.mq.get());
    check("3e-todo", r.todos.length === 1, r.todos);
    check("3f-todo-scoped", r.todos[0]?.blocks?.length === 1 && r.todos[0].blocks[0] === "task:TASK-903", r.todos[0]?.blocks);
    check("3g-todo-summary-has-count", /failed 3x/.test(r.todos[0]?.summary || ""), r.todos[0]?.summary);
    check("3h-todo-summary-has-class", /class: fixable/.test(r.todos[0]?.summary || ""), r.todos[0]?.summary);
  }

  // 4. structural at attempts 0 -> park immediately, attempts untouched
  {
    const item = failedItem("q4", "TASK-904");
    const r = await runFailure({ taskId: "TASK-904", item, queue: [item], agentReply: STRUCTURAL });
    const entry = r.ledger.get()["TASK-904"];
    check("4a-failed", entry?.outcome === LEDGER_OUTCOME_FAILED, entry);
    check("4b-structural", entry?.autoRetry?.parkedReason === "structural", entry?.autoRetry);
    check("4c-attempts-0", entry?.autoRetry?.attempts === 0, entry?.autoRetry);
    check("4d-no-retry", r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE).length === 0, r.mq.get());
    check("4e-todo", r.todos.length === 1, r.todos);
    check("4f-resume-not-called", r.resumeCalls.length === 0, r.resumeCalls);
  }

  // 5. repeated diff digest -> structural, no agent turn, no attempt spent
  {
    const item = failedItem("q5", "TASK-905");
    const digest = "a".repeat(64);
    const r = await runFailure({
      taskId: "TASK-905",
      item,
      queue: [item],
      diff: { ran: true, digest, files: ["apps/web/page.tsx"] },
      ledger: {
        "TASK-905": {
          key: "TASK-905",
          outcome: "retry-pending",
          autoRetry: { attempts: 1, cap: 2, parked: false, parkedReason: null, lastDiagnosis: null, history: [
            { at: "2026-08-29T10:00:00.000Z", class: "fixable", reason: "an unrelated earlier reason", diffHash: digest },
          ] },
        },
      },
    });
    const entry = r.ledger.get()["TASK-905"];
    check("5a-structural", entry?.autoRetry?.parkedReason === "structural", entry?.autoRetry);
    check("5b-no-agent-turn", r.agentCalls === 0, r.agentCalls);
    check("5c-attempts-unchanged", entry?.autoRetry?.attempts === 1, entry?.autoRetry);
    check("5d-failed", entry?.outcome === LEDGER_OUTCOME_FAILED, entry);
  }

  // 6. protected-path gate signature -> structural, no agent turn
  {
    const item = failedItem("q6", "TASK-906");
    const r = await runFailure({
      taskId: "TASK-906",
      item,
      queue: [item],
      steps: stepsFixture("Protected-path gate: diff touches supabase/migrations/001.sql", "pr"),
    });
    const entry = r.ledger.get()["TASK-906"];
    check("6a-structural", entry?.autoRetry?.parkedReason === "structural", entry?.autoRetry);
    check("6a-reason", String(entry?.autoRetry?.lastDiagnosis?.reason || "").includes("host-enforced list"), entry?.autoRetry?.lastDiagnosis);
    check("6b-no-agent-turn", r.agentCalls === 0, r.agentCalls);
    check("6c-attempts-0", entry?.autoRetry?.attempts === 0, entry?.autoRetry);
    check("6d-todo", r.todos.length === 1, r.todos);
  }

  // 6d2. A step that PASSED the gate and says so must NOT read as a hit.
  // TASK-023 run 295daa2f: verify passed, its own prose contained
  // "Protected-path gate: ...", the old bare-prefix signature matched it, and the
  // run parked "structural" with zero retries spent — while the actual failure
  // was the test step (OQ-09 /404 prerender), which is not structural at all.
  {
    const item = failedItem("q6d2", "TASK-906D2");
    const r = await runFailure({
      taskId: "TASK-906D2",
      item,
      queue: [item],
      steps: {
        found: true,
        run: { id: "run-x", workflowId: DEFAULT_WORKFLOW, status: "failed", runNumber: 99 },
        steps: [
          {
            stepId: "verify",
            status: "done",
            output:
              "GATE: pass\nProtected-path gate: git diff --stat for this commit is empty of protected paths, so the gate passes.",
            retryCount: 0,
            maxRetries: 1,
          },
          {
            stepId: "test",
            status: "failed",
            output: "STATUS: blocked\nREASON: next build failed on the /404 prerender (OQ-09)",
            retryCount: 2,
            maxRetries: 2,
          },
        ],
      },
      agentReply: FIXABLE,
    });
    const entry = r.ledger.get()["TASK-906D2"];
    check(
      "6d2-passing-gate-prose-not-a-hit",
      !String(entry?.autoRetry?.lastDiagnosis?.evidence || "").includes("protected-path gate signature"),
      entry?.autoRetry?.lastDiagnosis,
    );
    check(
      "6d2-not-parked-structural",
      entry?.autoRetry?.parkedReason !== "structural",
      entry?.autoRetry,
    );
    check("6d2-agent-turn-spent", r.agentCalls === 1, r.agentCalls);
    check("6d2-retry-pending", entry?.outcome === LEDGER_OUTCOME_RETRY_PENDING, entry);
    check("6d2-attempt-spent", entry?.autoRetry?.attempts === 1, entry?.autoRetry);
  }

  // 6e. git_failed is NOT a protected-path hit — retryable-or-engine (transient)
  {
    const item = failedItem("q6e", "TASK-906E");
    const r = await runFailure({
      taskId: "TASK-906E",
      item,
      queue: [item],
      steps: stepsFixture(
        "ENGINE_ERROR: protected_path_gate_git_failed — ambiguous argument / unknown revision",
        "verify",
      ),
    });
    const entry = r.ledger.get()["TASK-906E"];
    check("6e-git-failed-transient", entry?.autoRetry?.lastDiagnosis?.class === "transient", entry?.autoRetry?.lastDiagnosis);
    check("6e-git-failed-reason", String(entry?.autoRetry?.lastDiagnosis?.reason || "").includes("failed to run"), entry?.autoRetry?.lastDiagnosis);
    check("6e-git-failed-retry", entry?.outcome === LEDGER_OUTCOME_RETRY_PENDING, entry);
    check("6e-git-failed-no-agent", r.agentCalls === 0, r.agentCalls);
    check("6e-git-failed-not-parked", entry?.autoRetry?.parked !== true, entry?.autoRetry);
  }

  // 6f. missing_context is STRUCTURAL — NOT the same class as git_failed.
  // TASK-027 #37 and its auto-retry #38 both died on this exact signature; the
  // retry could not have supplied the absent field. Parks instead of retrying.
  {
    const item = failedItem("q6f", "TASK-906F");
    const r = await runFailure({
      taskId: "TASK-906F",
      item,
      queue: [item],
      steps: stepsFixture("ENGINE_ERROR: protected_path_gate_missing_context: commit_sha", "verify"),
    });
    const entry = r.ledger.get()["TASK-906F"];
    check("6f-missing-context-structural", entry?.autoRetry?.lastDiagnosis?.class === "structural", entry?.autoRetry?.lastDiagnosis);
    check("6f-missing-context-reason", String(entry?.autoRetry?.lastDiagnosis?.reason || "").includes("required run context was missing"), entry?.autoRetry?.lastDiagnosis);
    check("6f-missing-context-parked", entry?.autoRetry?.parkedReason === "structural", entry?.autoRetry);
    check("6f-missing-context-no-retry", entry?.outcome !== LEDGER_OUTCOME_RETRY_PENDING, entry);
    check("6f-missing-context-no-agent", r.agentCalls === 0, r.agentCalls);
    check("6f-missing-context-attempts-0", (entry?.autoRetry?.attempts ?? -1) === 0, entry?.autoRetry);
  }

  // 6f2. The two signatures must not collapse back into one bucket. When both
  // appear in one haystack, structural wins (the run still cannot supply the
  // absent field). 6e proves a git_failed-only haystack still retries.
  {
    const item = failedItem("q6f2", "TASK-906F2");
    const r = await runFailure({
      taskId: "TASK-906F2",
      item,
      queue: [item],
      steps: stepsFixture(
        "ENGINE_ERROR: protected_path_gate_missing_context: commit_sha\nORIGINAL_OUTPUT:\nearlier note mentioned protected_path_gate_git_failed",
        "verify",
      ),
    });
    const entry = r.ledger.get()["TASK-906F2"];
    check("6f2-both-structural", entry?.autoRetry?.lastDiagnosis?.class === "structural", entry?.autoRetry?.lastDiagnosis);
    check("6f2-both-parked", entry?.autoRetry?.parked === true, entry?.autoRetry);
  }

  // 6g. both signatures in one haystack — a real hit wins (F2)
  {
    const item = failedItem("q6g", "TASK-906G");
    const r = await runFailure({
      taskId: "TASK-906G",
      item,
      queue: [item],
      steps: {
        found: true,
        run: { id: "run-x", workflowId: DEFAULT_WORKFLOW, status: "failed", runNumber: 99 },
        steps: [
          {
            stepId: "verify",
            status: "failed",
            output: "ENGINE_ERROR: protected_path_gate_git_failed — ambiguous argument / unknown revision",
            retryCount: 2,
            maxRetries: 2,
          },
          {
            stepId: "merge",
            status: "failed",
            output: "Protected-path gate: diff touches _SSoT/CORE.md",
            retryCount: 2,
            maxRetries: 2,
          },
        ],
      },
    });
    const entry = r.ledger.get()["TASK-906G"];
    check("6g-both-structural", entry?.autoRetry?.parkedReason === "structural", entry?.autoRetry);
    check("6g-both-reason", String(entry?.autoRetry?.lastDiagnosis?.reason || "").includes("host-enforced list"), entry?.autoRetry?.lastDiagnosis);
    check("6g-both-not-transient", entry?.autoRetry?.lastDiagnosis?.class !== "transient", entry?.autoRetry?.lastDiagnosis);
    check("6g-both-parked", entry?.autoRetry?.parked === true, entry?.autoRetry);
  }

  {
    const item = failedItem("q6g2", "TASK-906G2");
    const r = await runFailure({
      taskId: "TASK-906G2",
      item,
      queue: [item],
      steps: stepsFixture(
        "Protected-path gate: diff touches _SSoT/CORE.md\nORIGINAL_OUTPUT:\nagent mentioned protected_path_gate_git_failed in notes",
        "pr",
      ),
    });
    const entry = r.ledger.get()["TASK-906G2"];
    check("6g-orig-structural", entry?.autoRetry?.parkedReason === "structural", entry?.autoRetry);
    check("6g-orig-reason", String(entry?.autoRetry?.lastDiagnosis?.reason || "").includes("host-enforced list"), entry?.autoRetry?.lastDiagnosis);
  }

  // 7. diagnosis agent throws -> park (today's behaviour), no retry
  {
    const item = failedItem("q7", "TASK-907");
    const r = await runFailure({ taskId: "TASK-907", item, queue: [item], agentThrows: true, liveQueue: false });
    const entry = r.ledger.get()["TASK-907"];
    check("7a-failed", entry?.outcome === LEDGER_OUTCOME_FAILED, entry);
    check("7b-diagnosis-unavailable", entry?.autoRetry?.parkedReason === "diagnosis-unavailable", entry?.autoRetry);
    check("7c-no-retry", r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE).length === 0, r.mq.get());
    check("7d-todo", r.todos.length === 1, r.todos);
    check("7e-blocking", ledgerBlocksKey(r.ledger.get(), "TASK-907") === true, entry);
  }

  // 8. unparseable diagnosis reply -> park
  {
    const item = failedItem("q8", "TASK-908");
    const r = await runFailure({ taskId: "TASK-908", item, queue: [item], agentGarbage: true, liveQueue: false });
    const entry = r.ledger.get()["TASK-908"];
    check("8a-failed", entry?.outcome === LEDGER_OUTCOME_FAILED, entry);
    check("8b-diagnosis-unavailable", entry?.autoRetry?.parkedReason === "diagnosis-unavailable", entry?.autoRetry);
    check("8c-no-retry", r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE).length === 0, r.mq.get());
  }

  // 8b. strict reply parsing rejects the shapes it must
  {
    const good = parseDiagnosisReply(JSON.stringify(FIXABLE));
    const extraKey = parseDiagnosisReply(JSON.stringify({ ...FIXABLE, extra: 1 }));
    const badClass = parseDiagnosisReply(JSON.stringify({ ...FIXABLE, class: "weird" }));
    const noGuidance = parseDiagnosisReply(JSON.stringify({ ...FIXABLE, retry_guidance: "" }));
    const structuralOk = parseDiagnosisReply(JSON.stringify(STRUCTURAL));
    check("8d-parse-good", good.ok === true, good);
    check("8e-parse-extra-key", extraKey.ok === false, extraKey);
    check("8f-parse-bad-class", badClass.ok === false, badClass);
    check("8g-parse-guidance-required", noGuidance.ok === false, noGuidance);
    check("8h-parse-structural-empty-guidance", structuralOk.ok === true, structuralOk);
  }

  // 9. diagnosis-pending older than TTL -> parked by the sweep
  {
    const ledger = memoryLedger({
      "TASK-909": {
        key: "TASK-909",
        outcome: LEDGER_OUTCOME_DIAGNOSIS_PENDING,
        diagnosisStartedAt: "2026-08-29T11:00:00.000Z",
        runId: "run-909",
        autoRetry: { attempts: 0, cap: 2, parked: false, parkedReason: null, lastDiagnosis: null, history: [] },
      },
      "TASK-910": {
        key: "TASK-910",
        outcome: LEDGER_OUTCOME_DIAGNOSIS_PENDING,
        diagnosisStartedAt: "2026-08-29T11:55:00.000Z",
        runId: "run-910",
      },
    });
    const todos = [];
    const deps = {
      ...ledger,
      thecoachRepo: "/tmp/thecoach",
      appendTodo: (_repo, draft) => { todos.push(draft); return { appended: true, entry: draft }; },
      now: () => Date.parse("2026-08-29T12:00:00.000Z"),
    };
    const swept = sweepStaleDiagnoses(deps);
    check("9a-swept-stale", swept.length === 1 && swept[0] === "TASK-909", swept);
    check("9b-stale-parked", ledger.get()["TASK-909"]?.outcome === LEDGER_OUTCOME_FAILED, ledger.get()["TASK-909"]);
    check("9c-fresh-untouched", ledger.get()["TASK-910"]?.outcome === LEDGER_OUTCOME_DIAGNOSIS_PENDING, ledger.get()["TASK-910"]);
    check("9d-stale-todo", todos.length === 1 && todos[0].blocks[0] === "task:TASK-909", todos);
    check("9e-stale-blocking", ledgerBlocksKey(ledger.get(), "TASK-909") === true, ledger.get()["TASK-909"]);
  }

  // ---- 8-P1: a ledger-blocked pending item must not halt the queue --------
  async function spawnHarness(queueItems, ledgerInit, extraDeps = {}) {
    const mq = memoryQueue(queueItems);
    const ledger = memoryLedger(ledgerInit);
    const idle = memoryIdle();
    const started = [];
    const todos = [];
    const http = await spawnPendingQueueItem(mq.get(), 0, {
      ...ledger,
      ...idle,
      thecoachRepo: "/tmp/thecoach",
      save: mq.save,
      load: mq.load,
      appendTodo: (_repo, draft) => { todos.push(draft); return { appended: true, entry: draft }; },
      repoExists: () => true,
      fetchStaging: async () => "tip",
      loadTaskContract: (id) => ({ ok: true, branch: `fix/${id.toLowerCase()}`, tool: "Cursor", markdown: `# ${id}` }),
      branchDiff: () => ({ ran: false, digest: null, files: [], error: "not computed" }),
      startRun: ({ task }) => { started.push(task); return { id: "spawn-1", pid: 1, logPath: "/tmp/s.log" }; },
      waitRun: async () => ({ id: "run-new", status: "running", run_number: 100 }),
      ...extraDeps,
    });
    return { http, mq, ledger, idle, started, todos };
  }

  // 10. blocked head-of-queue item is flagged and the NEXT item dispatches
  {
    const r = await spawnHarness(
      [pendingItem("blocked-1", "TASK-911 blocked work"), pendingItem("ok-1", "TASK-912 good work")],
      { "TASK-911": { key: "TASK-911", outcome: "failed", cleared: false } },
    );
    const q = r.mq.get();
    check("10a-blocked-flagged", q[0].status === "flagged", q[0]);
    check("10b-blocked-note", /parked so the queue can advance/.test(q[0].note || ""), q[0].note);
    check("10c-second-dispatched", q[1].status === "dispatched", q[1]);
    check("10d-startRun-called", r.started.length === 1 && r.started[0].includes("TASK-912"), r.started);
    check("10e-response-dispatched", r.http.body.dispatched === true, r.http.body);
    check("10f-no-todo", r.todos.length === 0, r.todos);
  }

  // 10b. blocked item alone -> flagged, reason ledger-blocked, queue advances to empty
  {
    const r = await spawnHarness(
      [pendingItem("blocked-2", "TASK-913 blocked work")],
      { "TASK-913": { key: "TASK-913", outcome: "failed", cleared: false } },
    );
    check("10g-flagged", r.mq.get()[0].status === "flagged", r.mq.get()[0]);
    check("10h-reason", r.http.body.reason === "ledger-blocked", r.http.body);
    check("10i-no-pending-left", r.mq.get().every((i) => i.status !== "pending"), r.mq.get());
    check("10j-idle-incremented", r.idle.get().consecutive_idle === 1, r.idle.get());
  }

  // 11. applyIdleTelemetry counts ledger-blocked as idle
  {
    const idle = memoryIdle({ consecutive_idle: 4, last_idle_at: null, last_escalated_at: null });
    const out = applyIdleTelemetry(
      { dispatched: false, reason: "ledger-blocked" },
      { ...idle, thecoachRepo: "/tmp/thecoach" },
    );
    check("11a-idle-counted", idle.get().consecutive_idle === 5, idle.get());
    check("11b-not-escalated-yet", out.escalated === false, out);
    const idle2 = memoryIdle({ consecutive_idle: 11, last_idle_at: null, last_escalated_at: null });
    const out2 = applyIdleTelemetry(
      { dispatched: false, reason: "ledger-blocked" },
      { ...idle2, thecoachRepo: "/tmp/thecoach" },
    );
    check("11c-escalates-at-12", out2.escalated === true && idle2.get().consecutive_idle === 12, idle2.get());
  }

  // 12. a parked task blocks only its own scope; ceiling counts * only (8-P2)
  {
    const entries = [
      { id: "TODO-1", status: "open", blocks: ["task:TASK-901"] },
      { id: "TODO-2", status: "open", blocks: ["task:TASK-902"] },
      { id: "TODO-3", status: "open", blocks: ["task:TASK-903"] },
      { id: "TODO-4", status: "open", blocks: [] },
      { id: "TODO-5", status: "open", blocks: ["*"] },
      { id: "TODO-6", status: "resolved", blocks: ["*"] },
    ];
    const sum = summarizeOpenTodos(entries);
    check("12a-open-count", sum.open_count === 5, sum.open_count);
    check("12b-global-count", sum.global_open_count === 1, sum.global_open_count);
    check("12c-scopes", sum.blockedScopes.has("task:task-901") && !sum.blockedScopes.has("task:task-999"), [...sum.blockedScopes]);
    check("12d-star-present", sum.blockedScopes.has(SCOPE_GLOBAL), [...sum.blockedScopes]);
    // 15 task-scoped parks must NOT reach the ceiling
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `T-${i}`, status: "open", blocks: [`task:TASK-${900 + i}`] }));
    const manySum = summarizeOpenTodos(many);
    check("12e-many-scoped-below-ceiling", manySum.global_open_count < OPEN_QUESTION_CEILING, manySum.global_open_count);
    check("12f-many-scoped-open-count", manySum.open_count === 15, manySum.open_count);
    // a malformed blocks array still counts as global (fail safe)
    const malformed = summarizeOpenTodos([{ id: "T-x", status: "open" }]);
    check("12g-malformed-counts-global", malformed.global_open_count === 1, malformed);
  }

  // 17. Item 7: repeated empty diff parks on attempt 2 without dispatching
  {
    const r = await spawnHarness(
      [pendingItem("empty-1", "TASK-914 review only"), pendingItem("next-1", "TASK-915 real work")],
      {
        "TASK-914": {
          key: "TASK-914",
          outcome: "retry-pending",
          cleared: false,
          autoRetry: {
            attempts: 1, cap: 2, parked: false, parkedReason: null, lastDiagnosis: null,
            history: [{ at: "2026-08-29T10:00:00.000Z", class: "fixable", reason: "r", diffHash: EMPTY_DIFF_DIGEST }],
          },
        },
      },
      { branchDiff: (_repo, branch) => (branch === "fix/task-914" ? { ran: true, digest: EMPTY_DIFF_DIGEST, files: [] } : { ran: false, digest: null, files: [], error: "n/a" }) },
    );
    const q = r.mq.get();
    check("17a-parked", q[0].status === "flagged", q[0]);
    check("17b-note", /empty diff/.test(q[0].note || ""), q[0].note);
    check("17c-ledger-failed", r.ledger.get()["TASK-914"]?.outcome === LEDGER_OUTCOME_FAILED, r.ledger.get()["TASK-914"]);
    check("17d-reason", r.ledger.get()["TASK-914"]?.reason === "repeated-empty-diff", r.ledger.get()["TASK-914"]);
    check("17e-attempt-not-spent", r.ledger.get()["TASK-914"]?.autoRetry?.attempts === 1, r.ledger.get()["TASK-914"]?.autoRetry);
    check("17f-todo-scoped", r.todos.length === 1 && r.todos[0].blocks[0] === "task:TASK-914", r.todos);
    check("17g-queue-advanced", q[1].status === "dispatched", q[1]);
    check("17h-only-next-started", r.started.length === 1 && r.started[0].includes("TASK-915"), r.started);
  }

  // 17b. a FIRST empty diff (no prior empty attempt) still dispatches
  {
    const r = await spawnHarness(
      [pendingItem("empty-2", "TASK-916 review only")],
      {},
      { branchDiff: () => ({ ran: true, digest: EMPTY_DIFF_DIGEST, files: [] }) },
    );
    check("17i-first-empty-dispatches", r.mq.get()[0].status === "dispatched", r.mq.get()[0]);
    check("17j-startRun-called", r.started.length === 1, r.started);
  }

  // 17c. a diff that could not be COMPUTED is never treated as empty
  {
    const r = await spawnHarness(
      [pendingItem("nodiff-1", "TASK-917 new branch")],
      {
        "TASK-917": {
          key: "TASK-917", outcome: "retry-pending", cleared: false,
          autoRetry: { attempts: 1, cap: 2, parked: false, parkedReason: null, lastDiagnosis: null,
            history: [{ at: "2026-08-29T10:00:00.000Z", class: "fixable", reason: "r", diffHash: EMPTY_DIFF_DIGEST }] },
        },
      },
      { branchDiff: () => ({ ran: false, digest: null, files: [], error: "unknown revision" }) },
    );
    check("17k-uncomputable-dispatches", r.mq.get()[0].status === "dispatched", r.mq.get()[0]);
  }

  // ---- TASK-048: redispatch of an already-worked branch must tell `plan` -----
  // The regression these lock down is TASK-025 run #43: three roadmap-auto
  // dispatches onto feature/promote-design-preview, each planned from the task
  // text alone, until a story targeted files an earlier story had deleted.

  // 18. a task with a prior ledger entry and real commits on its branch gets
  //     the prior-progress preamble in the DISPATCHED text.
  {
    const progressFiles = [
      "apps/web/app/(trainer)/workouts/WorkoutsDirectionA.tsx",
      "apps/web/components/design-system/PreviewChrome.tsx",
    ];
    const r = await spawnHarness(
      [pendingItem("prog-1", "TASK-920 promote the preview screens")],
      {
        // Exactly the shape a CLEARED entry has: the entry and its runId
        // survive, autoRetry.history does not. Keying on history would miss it.
        "TASK-920": {
          key: "TASK-920",
          outcome: "dispatched",
          cleared: false,
          runId: "run-earlier-attempt",
          autoRetry: { attempts: 0, cap: 2, parked: false, parkedReason: null, lastDiagnosis: null, history: [] },
        },
      },
      { branchDiff: () => ({ ran: true, digest: "deadbeef", files: progressFiles }) },
    );
    const sent = r.started[0] || "";
    check("18a-dispatched", r.mq.get()[0].status === "dispatched", r.mq.get()[0]);
    check("18b-preamble-present", sent.includes(PRIOR_PROGRESS_HEADER), sent);
    check("18c-names-branch", sent.includes("fix/task-920"), sent);
    check("18d-exact-file-count", sent.includes("in 2 file(s)"), sent);
    check("18e-lists-files", progressFiles.every((f) => sent.includes(f)), sent);
    check("18f-names-prior-run", sent.includes("run-earlier-attempt"), sent);
    check("18g-forbids-replanning-done-work", /already committed/.test(sent), sent);
    check("18h-warns-about-moved-paths", /already moved or deleted/.test(sent), sent);
    // The preamble is dispatch-time only: the queue item keeps the human text,
    // so it can never stack the way an auto-retry feedback block can.
    check("18i-not-persisted-to-item", !String(r.mq.get()[0].task).includes(PRIOR_PROGRESS_HEADER), r.mq.get()[0].task);
    check("18j-task-text-still-present", sent.includes("TASK-920 promote the preview screens"), sent);
  }

  // 18b. first dispatch ever (no ledger entry at all): no preamble, and the
  //      branch diff is never even computed. Unchanged behaviour, no git call.
  {
    let diffCalls = 0;
    const r = await spawnHarness(
      [pendingItem("prog-2", "TASK-921 brand new work")],
      {},
      {
        branchDiff: () => {
          diffCalls += 1;
          return { ran: true, digest: "x", files: ["should/not/matter.ts"] };
        },
      },
    );
    check("18k-first-dispatches", r.mq.get()[0].status === "dispatched", r.mq.get()[0]);
    check("18l-no-preamble", !String(r.started[0] || "").includes(PRIOR_PROGRESS_HEADER), r.started[0]);
    check("18m-no-git-call", diffCalls === 0, diffCalls);
  }

  // 18c. prior entry but the branch does not exist yet (ran:false) -> no
  //      preamble. `ran:false` must never be read as progress.
  {
    const r = await spawnHarness(
      [pendingItem("prog-3", "TASK-922 branch not cut yet")],
      { "TASK-922": { key: "TASK-922", outcome: "dispatched", cleared: false } },
      { branchDiff: () => ({ ran: false, digest: null, files: [], error: "unknown revision" }) },
    );
    check("18n-dispatches", r.mq.get()[0].status === "dispatched", r.mq.get()[0]);
    check("18o-no-preamble", !String(r.started[0] || "").includes(PRIOR_PROGRESS_HEADER), r.started[0]);
  }

  // 18d. prior entry, branch exists, but identical to staging -> no progress,
  //      no preamble. (Not the same path as Item 7: no empty-diff history here.)
  {
    const r = await spawnHarness(
      [pendingItem("prog-4", "TASK-923 nothing landed last time")],
      { "TASK-923": { key: "TASK-923", outcome: "dispatched", cleared: false } },
      { branchDiff: () => ({ ran: true, digest: EMPTY_DIFF_DIGEST, files: [] }) },
    );
    check("18p-dispatches", r.mq.get()[0].status === "dispatched", r.mq.get()[0]);
    check("18q-no-preamble", !String(r.started[0] || "").includes(PRIOR_PROGRESS_HEADER), r.started[0]);
  }

  // 18e. Item 7 still wins: a repeated empty diff parks and never dispatches,
  //      so no preamble can leak out of a parked item.
  {
    const r = await spawnHarness(
      [pendingItem("prog-5", "TASK-924 review only")],
      {
        "TASK-924": {
          key: "TASK-924", outcome: "retry-pending", cleared: false,
          autoRetry: { attempts: 1, cap: 2, parked: false, parkedReason: null, lastDiagnosis: null,
            history: [{ at: "2026-08-29T10:00:00.000Z", class: "fixable", reason: "r", diffHash: EMPTY_DIFF_DIGEST }] },
        },
      },
      { branchDiff: () => ({ ran: true, digest: EMPTY_DIFF_DIGEST, files: [] }) },
    );
    check("18r-still-parks", r.mq.get()[0].status === "flagged", r.mq.get()[0]);
    check("18s-nothing-started", r.started.length === 0, r.started);
  }

  // 18f. the file list is capped but the COUNT stays exact — a 60-file branch
  //      must not silently report 40.
  {
    const many = Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`);
    const r = await spawnHarness(
      [pendingItem("prog-6", "TASK-925 big branch")],
      { "TASK-925": { key: "TASK-925", outcome: "dispatched", cleared: false } },
      { branchDiff: () => ({ ran: true, digest: "big", files: many }) },
    );
    const sent = r.started[0] || "";
    check("18t-exact-count", sent.includes("in 60 file(s)"), sent);
    check("18u-capped-list", sent.includes("...and 20 more"), sent);
    check("18v-first-file-listed", sent.includes("src/file-0.ts"), sent);
    check("18w-last-file-omitted", !sent.includes("src/file-59.ts"), sent);
  }

  // 18g. preamble and auto-retry feedback are independent and coexist.
  {
    const withFeedback = `TASK-926 do it\n\n${AUTO_RETRY_FEEDBACK_HEADER}2 of 3 — automatic diagnosis, not a human):\nCLASS: fixable\nWHAT FAILED: x\nEVIDENCE: y\nDO DIFFERENTLY: z`;
    const r = await spawnHarness(
      [pendingItem("prog-7", withFeedback)],
      { "TASK-926": { key: "TASK-926", outcome: "retry-pending", cleared: false } },
      { branchDiff: () => ({ ran: true, digest: "d", files: ["a.ts"] }) },
    );
    const sent = r.started[0] || "";
    check("18x-both-blocks", sent.includes(AUTO_RETRY_FEEDBACK_HEADER) && sent.includes(PRIOR_PROGRESS_HEADER), sent);
    check("18y-single-progress-block", sent.split(PRIOR_PROGRESS_HEADER).length - 1 === 1, sent);
  }

  // JC7. a `## Dispatch: manual` task never enters the retry cycle at all
  {
    const r = await spawnHarness(
      [pendingItem("manual-1", "TASK-918 manual work")],
      {},
      { loadTaskContract: () => ({ ok: true, branch: "fix/task-918", tool: "Cursor", markdown: "# t", dispatch: "manual", dispatchUnknown: false }) },
    );
    check("jc7a-manual-skipped", r.http.body.reason === "not-dispatchable-manual", r.http.body);
    check("jc7b-no-ledger-entry", Object.keys(r.ledger.get()).length === 0, r.ledger.get());
    check("jc7c-no-autoretry", r.ledger.get()["TASK-918"] === undefined, r.ledger.get());
    check("jc7d-no-startRun", r.started.length === 0, r.started);
  }

  // feedback blocks must not stack across attempts
  {
    const withFeedback = `TASK-919: do it\n\n${AUTO_RETRY_FEEDBACK_HEADER}2 of 3 — automatic diagnosis, not a human):\nCLASS: fixable\nWHAT FAILED: old\nEVIDENCE: old\nDO DIFFERENTLY: old`;
    const rebuilt = buildAutoRetryQueueItem({
      item: { task: withFeedback, repoPath: "/tmp/r", roadmap_ref: null },
      diagnosis: FIXABLE,
      attemptNumber: 2,
      cap: 2,
    });
    const occurrences = rebuilt.task.split(AUTO_RETRY_FEEDBACK_HEADER).length - 1;
    check("fb-single-block", occurrences === 1, rebuilt.task);
    check("fb-new-guidance", rebuilt.task.includes("write the test file"), rebuilt.task);
    check("fb-old-guidance-gone", !rebuilt.task.includes("DO DIFFERENTLY: old"), rebuilt.task);
    check("fb-source", rebuilt.source === AUTO_RETRY_SOURCE, rebuilt.source);
  }

  // 20. transient + resume succeeds → same run-id continues, no fresh pending item
  {
    const item = failedItem("q20", "TASK-920");
    const r = await runFailure({
      taskId: "TASK-920",
      item,
      queue: [item],
      steps: stepsFixture("ENGINE_ERROR: openclaw agent failed: gateway unreachable"),
      resumeSucceeds: true,
    });
    const entry = r.ledger.get()["TASK-920"];
    const pushed = r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE);
    check("20a-retry-pending", entry?.outcome === LEDGER_OUTCOME_RETRY_PENDING, entry);
    check("20b-attempts-1", entry?.autoRetry?.attempts === 1, entry?.autoRetry);
    check("20c-resume-called", r.resumeCalls.length === 1 && r.resumeCalls[0] === item.runId, r.resumeCalls);
    check("20d-same-run-id", pushed[0] && pushed[0].runId === item.runId, pushed[0]);
    check("20e-already-dispatched", pushed[0] && pushed[0].status === "dispatched", pushed[0]);
    check("20f-no-fresh-pending", pushed.every((i) => i.status !== "pending"), pushed);
    check("20g-resume-note", pushed[0] && String(pushed[0].note || "").startsWith(AUTO_RETRY_RESUME_NOTE_PREFIX), pushed[0]?.note);
    check("20h-result-resumed", r.result?.resumed === true, r.result);
    check("20i-no-todo", r.todos.length === 0, r.todos);
    check("20j-one-tracker", pushed.length === 1, pushed.length);
  }

  // 21. fixable + resume succeeds → same run-id, attempts still increment
  {
    const item = failedItem("q21", "TASK-921");
    const r = await runFailure({ taskId: "TASK-921", item, queue: [item], resumeSucceeds: true });
    const entry = r.ledger.get()["TASK-921"];
    const pushed = r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE);
    check("21a-retry-pending", entry?.outcome === LEDGER_OUTCOME_RETRY_PENDING, entry);
    check("21b-attempts-1", entry?.autoRetry?.attempts === 1, entry?.autoRetry);
    check("21c-resume-called", r.resumeCalls[0] === item.runId, r.resumeCalls);
    check("21d-same-run-id", pushed[0]?.runId === item.runId, pushed[0]);
    check("21e-dispatched", pushed[0]?.status === "dispatched", pushed[0]);
    check("21f-resumed-flag", r.finished?.resumed === true, r.finished);
  }

  // 22. resume throws → today's fresh redispatch, attempt still spent
  {
    const item = failedItem("q22", "TASK-922");
    const r = await runFailure({
      taskId: "TASK-922",
      item,
      queue: [item],
      steps: stepsFixture("ENGINE_ERROR: openclaw agent failed: gateway unreachable"),
      resumeThrows: true,
    });
    const entry = r.ledger.get()["TASK-922"];
    const pushed = r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE);
    check("22a-retry-pending", entry?.outcome === LEDGER_OUTCOME_RETRY_PENDING, entry);
    check("22b-attempts-1", entry?.autoRetry?.attempts === 1, entry?.autoRetry);
    check("22c-fallback-pending", pushed[0] && pushed[0].status === "pending" && pushed[0].runId === null, pushed[0]);
    check("22d-not-resumed", r.result?.resumed === false, r.result);
    check("22e-resume-error", Boolean(r.result?.resumeError), r.result);
  }

  // 23. resume returns not-ok → same fresh-redispatch fallback
  {
    const item = failedItem("q23", "TASK-923");
    const r = await runFailure({
      taskId: "TASK-923",
      item,
      queue: [item],
      steps: stepsFixture("ENGINE_ERROR: openclaw agent failed: gateway unreachable"),
      resumeError: "Run abcdef12 is \"running\", not \"failed\". Nothing to resume.",
    });
    const pushed = r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE);
    check("23a-fallback-pending", pushed[0]?.status === "pending", pushed[0]);
    check("23b-not-resumed", r.result?.resumed === false, r.result);
  }

  // 24. structural still parks and never calls resume (negative control)
  {
    const item = failedItem("q24", "TASK-924");
    const r = await runFailure({
      taskId: "TASK-924",
      item,
      queue: [item],
      steps: stepsFixture("Protected-path gate: diff touches supabase/migrations/001.sql", "pr"),
      resumeSucceeds: true,
    });
    const entry = r.ledger.get()["TASK-924"];
    check("24a-parked", entry?.autoRetry?.parkedReason === "structural", entry?.autoRetry);
    check("24b-failed", entry?.outcome === LEDGER_OUTCOME_FAILED, entry);
    check("24c-resume-not-called", r.resumeCalls.length === 0, r.resumeCalls);
    check("24d-no-retry-item", r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE).length === 0, r.mq.get());
    check("24e-attempts-0", entry?.autoRetry?.attempts === 0, entry?.autoRetry);
  }

  // 25. cap-reached still parks without resume
  {
    const item = failedItem("q25", "TASK-925");
    const r = await runFailure({
      taskId: "TASK-925",
      item,
      queue: [item],
      resumeSucceeds: true,
      ledger: {
        "TASK-925": {
          key: "TASK-925",
          outcome: "retry-pending",
          autoRetry: { attempts: 2, cap: 2, parked: false, parkedReason: null, lastDiagnosis: null, history: [
            { at: "2026-08-29T10:00:00.000Z", class: "fixable", reason: "older reason one", diffHash: null },
            { at: "2026-08-29T11:00:00.000Z", class: "fixable", reason: "older reason two", diffHash: null },
          ] },
        },
      },
    });
    const entry = r.ledger.get()["TASK-925"];
    check("25a-cap-reached", entry?.autoRetry?.parkedReason === "cap-reached", entry?.autoRetry);
    check("25b-resume-not-called", r.resumeCalls.length === 0, r.resumeCalls);
    check("25c-attempts-unchanged", entry?.autoRetry?.attempts === 2, entry?.autoRetry);
  }

  // 26. antfarm status is not failed → do not resume, fall back to redispatch
  {
    const item = failedItem("q26", "TASK-926");
    const r = await runFailure({
      taskId: "TASK-926",
      item,
      queue: [item],
      steps: stepsFixture("ENGINE_ERROR: openclaw agent failed: gateway unreachable"),
      liveRunStatus: "cancelled",
      resumeSucceeds: true,
    });
    const pushed = r.mq.get().filter((i) => i.source === AUTO_RETRY_SOURCE);
    check("26a-resume-not-called", r.resumeCalls.length === 0, r.resumeCalls);
    check("26b-fallback-pending", pushed[0]?.status === "pending", pushed[0]);
    check("26c-attempts-1", r.ledger.get()["TASK-926"]?.autoRetry?.attempts === 1, r.ledger.get()["TASK-926"]?.autoRetry);
  }

  const report = {
    ok: failures.length === 0,
    failed: failures.length,
    total: cases.length,
    failures,
    cases,
    config: {
      autoRetryCap: AUTO_RETRY_CAP,
      diagnosisTtlMs: DIAGNOSIS_TTL_MS,
      openQuestionCeiling: OPEN_QUESTION_CEILING,
      emptyDiffDigest: EMPTY_DIFF_DIGEST,
      autoRetryResumeClasses: [...AUTO_RETRY_RESUME_CLASSES],
      autoRetryResumeTimeoutMs: AUTO_RETRY_RESUME_TIMEOUT_MS,
    },
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
