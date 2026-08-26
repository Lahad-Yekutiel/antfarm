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
/** phase:<id> / oq:OQ-<n> / task:TASK-<n> / * — compared after canonicalizeScopeToken(). */
const SCOPE_TOKEN_RE = /^(?:\*|phase:[a-z0-9]+|oq:oq-\d+|task:task-\d+)$/;
const TASK_ID_RE = /TASK-(\d+)/i;
const PHASE_HEADING_RE = /phase\s+(\d+[a-z]?)\b/i;
/** `## Phase 9 — ...` / `## Phase 4B — ...` — ground truth for dispatch phase. */
const PHASE_HEADING_LINE_RE = /^##\s+Phase\s+(\d+[a-z]?)\b/i;
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
  const m = roadmapRef.match(PHASE_HEADING_RE);
  if (!m) return null;
  return canonicalizeScopeToken(`phase:${m[1]}`);
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

function collectRoadmapPhaseHeadings(roadmapText, deps = {}) {
  const headings = [];
  iterateRoadmapLines(
    roadmapText,
    (line, index) => {
      const hm = line.match(PHASE_HEADING_LINE_RE);
      if (hm) {
        headings.push({
          phaseId: hm[1].toLowerCase(),
          scope: canonicalizeScopeToken(`phase:${hm[1]}`),
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
    if (reason === "nothing-dispatchable" || reason === "scan-errored" || reason === "queue-item-rejected") {
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
  const assertedPhases = listed.canonical.filter((s) => s.startsWith("phase:"));
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
async function waitForAntfarmRunId(taskText, { timeoutMs = WAIT_FOR_RUN_TIMEOUT_MS, intervalMs = 250 } = {}) {
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

Scope grammar (for both dispatch "scopes" and record-question "blocks"):
- phase:<id>   e.g. phase:4B, phase:9
- oq:<id>      e.g. oq:OQ-12
- task:TASK-<n> e.g. task:TASK-033
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

  let parsed;
  try {
    const prompt = buildRoadmapScanPrompt(roadmap, todoRaw, snapshot.blockedScopes);
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
    return { open_count: 0, todo_ids: [], blockedScopes: new Set() };
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
    return {
      status: 200,
      body: withIdleTelemetry(
        {
          ok: true,
          dispatched: false,
          reason: "ledger-blocked",
          ledger_blocked: ledgerKey,
        },
        deps,
      ),
    };
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

  if (snapshot.open_count >= OPEN_QUESTION_CEILING) {
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
      const ledgerKey = extractTaskIdFromText(item.task, item.roadmap_ref);
      const ledgerOutcome =
        run.status === "failed" || outcome.status === "flagged" ? "failed" : "completed";
      recordLedgerAttempt(ledgerKey, {
        outcome: ledgerOutcome,
        runStatus: run.status,
        queueStatus: outcome.status,
        runId: item.runId,
        queueItemId: item.id,
        outcomeAt: item.resolvedAt,
        roadmap_ref: item.roadmap_ref ?? null,
      });
      if (ledgerOutcome === "failed" && ledgerKey) {
        try {
          appendDeveloperTodoEntry(THECOACH_REPO, {
            summary: `Dispatch of ${ledgerKey} failed (run ${item.runId}); do not retry until the ledger entry is cleared`,
            why: `The last antfarm run for this item ended runStatus=${run.status} queueStatus=${outcome.status}. Re-dispatching it unattended would repeat the failure.`,
            source: ledgerKey,
            type: "blocked",
            evidence: item.note || `run ${item.runId}`,
            reply_needed: `Diagnose ${ledgerKey}, then clear coordinator-dispatch-ledger.json[${ledgerKey}] to allow a retry.`,
            blocks: [`task:${ledgerKey}`],
          });
        } catch (err) {
          logDispatchNextError(`ledger failure-question write failed: ${err?.message || String(err)}`);
        }
      }
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

  const STUB_ROADMAP = [
    "# ROADMAP",
    "",
    "## Phase 4A — Visual Design System",
    "",
    "- [x] **Design system build-out (TASK-019)**",
    "- [x] ~~Staging integration (TASK-022)~~",
    "- [ ] **Promote design-preview (TASK-025)**",
    "",
    "## Phase 4B — Trainer Web App Build",
    "",
    "- [ ] **Auth rework (TASK-040)**",
    "",
    "## Phase 9 — Testing & QA Hardening",
    "",
    "- [ ] **Add reliability note (TASK-099)**",
    "- [ ] **Schema/types drift check (TASK-026)**",
  ].join("\n");

  const dispatchReply = {
    decision: "dispatch",
    title: "Add reliability note (TASK-099)",
    description: "Write the Phase 4 reliability paragraph into README.md",
    roadmap_ref: "Phase 9 — Testing & QA Hardening: reliability paragraph (TASK-099)",
    scopes: ["phase:9"],
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
    description: "Write the Phase 4 reliability paragraph into README.md",
    roadmap_ref: "Phase 9 — Testing & QA Hardening: reliability paragraph (TASK-099)",
  };
  const recordQuestionReply = {
    decision: "record-question",
    summary: "Need a yes/no on adding CI",
    why: "Spends Actions minutes",
    source: "roadmap:Phase9",
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
      parseAgentDecision(JSON.stringify({ ...dispatchReply, scopes: ["banana", "", "phase:", 42] })).ok === false,
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
    roadmap_ref: "Phase 4B — Auth rework (TASK-040)",
    scopes: ["phase:4B"],
  };
  const parsedBlocked = parseAgentDecision(JSON.stringify(phase4bDispatch));
  const blockedBackstop = evaluateDispatchBackstop(
    parsedBlocked.decision.scopes,
    new Set(["phase:4B", "oq:OQ-12"]),
    phase4bDispatch.roadmap_ref,
    STUB_ROADMAP,
    phase4bDispatch,
  );
  const missingScopesBackstop = evaluateDispatchBackstop(undefined, new Set());
  const emptyScopesBackstop = evaluateDispatchBackstop([], new Set());
  const emptyBlocksBackstop = evaluateDispatchBackstop(
    ["phase:9"],
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
    { id: "TODO-0004", status: "open", summary: "oauth", blocks: ["phase:4B", "oq:OQ-12"] },
  ]);
  const liveMissingScopesScan = await liveScanDispatch(dispatchReplyNoScopes, []);
  const liveBackstopCases = [
    check("live-backstop-blocked-outcome", liveBlockedScan.outcome === "nothing-dispatchable", liveBlockedScan),
    check("live-backstop-blocked-rejected", liveBlockedScan.backstop_rejected === true, liveBlockedScan),
    check("live-backstop-blocked-reason", liveBlockedScan.backstop_reason === "intersects-blocked", liveBlockedScan),
    check("live-backstop-missing-scopes-rejected", liveMissingScopesScan.backstop_rejected === true, liveMissingScopesScan),
    check("live-backstop-missing-scopes-reason", liveMissingScopesScan.backstop_reason === "missing-or-empty-scopes", liveMissingScopesScan),
  ];

  const bypassStrings = ["phase:4b", "Phase:4B", "phase:4B ", "phase:4", "", "not-a-scope"];
  const bypassLiveCases = [];
  for (const [i, scope] of bypassStrings.entries()) {
    const decision = { ...phase4bDispatch, scopes: [scope] };
    let scanResult;
    if (scope === "" || scope === "not-a-scope" || scope === "phase:4") {
      // parse may reject empty/not-a-scope; phase:4 is valid grammar but disagrees with derived 4b
      const parsed = parseAgentDecision(JSON.stringify(decision));
      if (!parsed.ok) {
        scanResult = { outcome: "nothing-dispatchable", failReason: parsed.error, parseRejected: true };
      } else {
        scanResult = await liveScanDispatch(decision, [
          { id: "TODO-0004", status: "open", summary: "oauth", blocks: ["phase:4B"] },
        ]);
      }
    } else {
      scanResult = await liveScanDispatch(decision, [
        { id: "TODO-0004", status: "open", summary: "oauth", blocks: ["phase:4B"] },
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
    { ...dispatchReply, scopes: ["phase:9"], roadmap_ref: "Phase 4B — Auth rework (TASK-099)" },
    [],
  );
  const coherentWrong = {
    decision: "dispatch",
    title: "Promote design-preview (TASK-025)",
    description: "Replace the old screens with design-preview",
    roadmap_ref: "Phase 9 — Testing & QA Hardening: Promote design-preview (TASK-025)",
    scopes: ["phase:9"],
  };
  const coherentWrongScan = await liveScanDispatch(coherentWrong, []);
  const phase77Scan = await liveScanDispatch(
    {
      ...dispatchReply,
      scopes: ["phase:77"],
      roadmap_ref: "Phase 77 — Does not exist (TASK-099)",
    },
    [],
  );
  const unlocatableScan = await liveScanDispatch(
    {
      decision: "dispatch",
      title: "Invented work (TASK-888)",
      description: "This checkbox is not in the roadmap",
      roadmap_ref: "Phase 9 — Testing & QA Hardening: Invented work (TASK-888)",
      scopes: ["phase:9"],
    },
    [],
  );
  const omitTaskIdScan = await liveScanDispatch(
    {
      decision: "dispatch",
      title: "Add reliability note",
      description: "Write the Phase 4 reliability paragraph into README.md",
      roadmap_ref: "Phase 9 — Testing & QA Hardening: reliability paragraph",
      scopes: ["phase:9"],
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
    ...dispatchMocks(),
    load: mqDispatch.load,
    save: mqDispatch.save,
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
    findActive: () => null,
    load: mqBlocked.load,
    save: mqBlocked.save,
    readTodo: () => JSON.stringify([{ id: "TODO-0004", status: "open", summary: "oauth", blocks: ["phase:4B", "oq:OQ-12"] }]),
    ...bgBlocked,
    ...memoryScanState(),
    ...memoryLedger(),
    scan: async (scanDeps) => {
      blockedAgentCalls += 1;
      return scanRoadmapForWork({
        ...scanDeps,
        thecoachRepo: "/tmp/thecoach-does-not-matter",
        readTodo: () => JSON.stringify([{ id: "TODO-0004", status: "open", summary: "oauth", blocks: ["phase:4B", "oq:OQ-12"] }]),
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
      capturedLogs.some((l) => l.includes("backstop-rejected-dispatch") && l.includes("phase:4B")),
      capturedLogs.filter((l) => l.includes("backstop")),
    ),
    check("blocked-scope-scan-outcome-nothing", bgBlocked.length === 0 && mqBlocked.get().length === 0),
  ];

  const mqMissingScopes = memoryQueue([]);
  const bgMissingScopes = backgroundBox();
  let startRunOnMissingScopes = 0;
  const missingScopesHttp = await handleDispatchNext({
    findActive: () => null,
    load: mqMissingScopes.load,
    save: mqMissingScopes.save,
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
    ...dispatchMocks(),
    load: mqEmptyBlocks.load,
    save: mqEmptyBlocks.save,
    readTodo: () => JSON.stringify([{ id: "TODO-0006", status: "open", summary: "billing", blocks: [] }]),
    ...bgEmptyBlocks,
    ...memoryScanState(),
    ...memoryLedger(),
    scan: async () =>
      scanRoadmapForWork({
        thecoachRepo: "/tmp/thecoach-does-not-matter",
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
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
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
  let ceilingHttpScan = 0;
  const ceilingHttp = await handleDispatchNext({
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
    readTodo: () => JSON.stringify(tenOpen),
    scan: async () => {
      ceilingHttpScan += 1;
      throw new Error("scan must not run on ceiling");
    },
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
    check("ceiling-http-no-scan", ceilingHttpScan === 0, ceilingHttpScan),
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
  const bgNine = backgroundBox();
  const nineHttp = await handleDispatchNext({
    ...dispatchMocks(),
    load: mqNine.load,
    save: mqNine.save,
    readTodo: () => JSON.stringify(nineOpen),
    ...bgNine,
    ...memoryScanState(),
    ...memoryLedger(),
    scan: async () =>
      scanRoadmapForWork({
        thecoachRepo: "/tmp/thecoach-does-not-matter",
        readTodo: () => JSON.stringify(nineOpen),
        readRoadmap: () => STUB_ROADMAP,
        runAgent: async () => {
          nineAgentCalls += 1;
          return JSON.stringify({ payloads: [{ text: JSON.stringify(dispatchReply) }] });
        },
      }),
  });
  await bgNine.flush();
  const nineEmptyCases = [
    check("nine-empty-blocks-http-scan-started", nineHttp.body.reason === "scan-started", nineHttp.body.reason),
    check("nine-empty-blocks-agent-called", nineAgentCalls === 1, nineAgentCalls),
    check("nine-empty-blocks-dispatched", mqNine.get()[0]?.status === "dispatched", mqNine.get()[0]),
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
    const bg = backgroundBox();
    const httpResult = await handleDispatchNext({
      findActive: () => null,
      load: mq.load,
      save: mq.save,
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
    readTodo: () => JSON.stringify(tenOpen),
  });
  let idleThrowLoads = 0;
  const bgIdleSwallow = backgroundBox();
  dispatchMocks.started = [];
  const idleSwallowHttp = await handleDispatchNext({
    ...dispatchMocks(),
    load: memoryQueue([]).load,
    save: () => {},
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
      source: "roadmap:Phase9",
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
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
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
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
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
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
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
    roadmap_ref: "Phase 9 — Testing & QA Hardening: Schema/types drift check (TASK-026)",
    scopes: ["phase:9", "task:TASK-026"],
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
    findActive: () => null,
    load: mqLedger.load,
    save: mqLedger.save,
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
    findActive: () => null,
    load: mq504.load,
    save: mq504.save,
    ...ledger504,
    repoExists: () => true,
    fetchStaging: async () => "504-tip",
    startRun: () => ({ id: "spawn-504", pid: 5, logPath: "/tmp/spawn-504.log" }),
    waitRun: async () => null,
  });
  let startAfter504 = 0;
  const after504 = await handleDispatchNext({
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
    check("human-ledger-still-pending", mqHumanLedger.get()[0]?.status === "pending", mqHumanLedger.get()[0]),
    check("human-ledger-no-startRun", humanLedgerStartRun === 0, humanLedgerStartRun),
    check("human-ledger-no-fetch", humanLedgerFetch === 0, humanLedgerFetch),
    check("human-cleared-dispatched", humanClearedHttp.body.dispatched === true, humanClearedHttp.body),
    check("human-cleared-did-start", humanClearedStarted.length === 1, humanClearedStarted.length),
    check("unledgerable-status-200", unledgerableHttp.status === 200, unledgerableHttp.status),
    check("unledgerable-reason", unledgerableHttp.body.reason === "queue-item-rejected", unledgerableHttp.body),
    check("unledgerable-no-startRun", unledgerableStartRun === 0, unledgerableStartRun),
    check("unledgerable-flagged", mqUnledgerable.get()[0]?.status === "flagged", mqUnledgerable.get()[0]),
    check("504-status", http504.status === 504, http504.status),
    check("504-item-still-pending", mq504.get()[0]?.status === "pending", mq504.get()[0]),
    check("504-ledger-failed", ledger504.get()["TASK-026"]?.outcome === "failed", ledger504.get()["TASK-026"]),
    check("504-followup-blocked", after504.body.reason === "ledger-blocked", after504.body),
    check("504-followup-no-startRun", startAfter504 === 0, startAfter504),
    check("cleared-nonboolean-not-agent-settable", clearedForcedFalse === true, clearedWrite.get()["TASK-001"]),
    check("cleared-true-only-when-boolean-true", clearedWrite.get()["TASK-001"]?.cleared === true, clearedWrite.get()["TASK-001"]),
  ];

  const bgSlow = backgroundBox();
  const t0 = Date.now();
  const slowHttp = await handleDispatchNext({
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
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

  const realRoadmapPath = "/mnt/c/Users/lahad/Projects/TheCoach/_SSoT/ROADMAP.md";
  const realRoadmap = fs.readFileSync(realRoadmapPath, "utf-8");
  const realParseT0 = process.hrtime.bigint();
  const realHeadings = collectRoadmapPhaseHeadings(realRoadmap);
  const realParseMs = Number(process.hrtime.bigint() - realParseT0) / 1e6;
  const openTaskIds = [
    "TASK-031", "TASK-032", "TASK-035", "TASK-034",
    "TASK-025", "TASK-023", "TASK-030", "TASK-028",
    "TASK-026", "TASK-027", "TASK-029", "TASK-033",
    "TASK-024",
  ];
  const expectedOpen = {
    "TASK-031": "underivable-phase",
    "TASK-032": "underivable-phase",
    "TASK-035": "underivable-phase",
    "TASK-034": "underivable-phase",
    "TASK-025": "phase:4a",
    "TASK-023": "phase:4b",
    "TASK-030": "phase:4b",
    "TASK-028": "phase:4b",
    "TASK-026": "phase:9",
    "TASK-027": "phase:9",
    "TASK-029": "phase:9",
    "TASK-033": "phase:9",
    "TASK-024": "phase:10",
  };
  const realOpen = {};
  for (const id of openTaskIds) {
    realOpen[id] = locateDispatchInRoadmap(realRoadmap, { title: id, description: "", roadmap_ref: "" });
  }
  const completed4a = ["TASK-013", "TASK-014", "TASK-015", "TASK-016", "TASK-017", "TASK-018", "TASK-019", "TASK-020", "TASK-022"];
  const realCompleted = completed4a.map((id) => locateDispatchInRoadmap(realRoadmap, { title: id, description: "", roadmap_ref: "" }));
  origLog(
    JSON.stringify(
      {
        real_roadmap_parse_ms: realParseMs,
        headings: realHeadings.map((h) => h.scope),
        open: Object.fromEntries(
          openTaskIds.map((id) => [
            id,
            realOpen[id].ok ? realOpen[id].filePhase : realOpen[id].reason,
          ]),
        ),
        completed_4a: Object.fromEntries(completed4a.map((id, i) => [id, realCompleted[i].reason])),
      },
      null,
      2,
    ),
  );
  const realParseCases = [
    check("real-roadmap-parse-returns", Number.isFinite(realParseMs) && realParseMs < ROADMAP_PARSE_BUDGET_MS, realParseMs),
    check("real-roadmap-has-blank-lines", realRoadmap.split("\n").filter((l) => l.trim() === "").length >= 70, realRoadmap.split("\n").filter((l) => l.trim() === "").length),
    ...openTaskIds.map((id) =>
      check(
        `real-open-${id}`,
        expectedOpen[id].startsWith("phase:")
          ? realOpen[id].ok === true && realOpen[id].filePhase === expectedOpen[id]
          : realOpen[id].ok === false && realOpen[id].reason === expectedOpen[id],
        { id, expected: expectedOpen[id], got: realOpen[id] },
      ),
    ),
    ...completed4a.map((id, i) =>
      check(`real-completed-${id}-rejected`, realCompleted[i].ok === false && realCompleted[i].reason === "item-resolved", realCompleted[i]),
    ),
  ];

  const idleErr1 = memoryIdle();
  const bgErr1 = backgroundBox();
  const scanErr1 = memoryScanState();
  await handleDispatchNext({
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
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
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
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
    findActive: () => null,
    load: memoryQueue([]).load,
    save: () => {},
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
