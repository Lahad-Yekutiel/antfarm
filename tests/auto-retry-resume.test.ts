import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { getDb } from "../dist/db.js";
import { claimStep, completeStep } from "../dist/installer/step-ops.js";

/**
 * Coordinator auto-retry must resume a failed run at its failed story, not
 * dispatch a fresh run. Fixture shape matches the D1/C1 gate-fix tests: a
 * real throwaway git repo + real antfarm.db rows, then the production
 * retry path (`--eval-auto-retry-resume` → `antfarm workflow resume`).
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const TRANSIENT_IMPLEMENT_OUTPUT =
  "ENGINE_ERROR: openclaw agent failed: gateway unreachable";
const STRUCTURAL_VERIFY_OUTPUT =
  "Protected-path gate: diff touches supabase/migrations/001.sql";
const S1_OUTPUT = "STATUS: done\nCHANGES: story 1 committed\nTEST_RESULT: 1 pass";
const S2_OUTPUT = "STATUS: done\nCHANGES: story 2 committed\nTEST_RESULT: 1 pass";
const EVAL_TIMEOUT_MS = 45_000;
const VERIFY_PASS_OUTPUT = "GATE: pass\nSTATUS: pass\nSTATUS_REASON: n/a";
const DEVELOPER_AGENT_ID = "thecoach-dev_developer";
const VERIFIER_AGENT_ID = "thecoach-dev_verifier";

let cleanRepoCache: { repo: string; sha: string } | null = null;
function cleanFixtureRepo(): { repo: string; sha: string } {
  if (cleanRepoCache) return cleanRepoCache;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-resume-fixture-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8", env: GIT_ENV });
  git(["init", "-q", "-b", "staging"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-qb", "feat-resume"]);
  fs.mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
  fs.writeFileSync(path.join(repo, "apps", "web", "page.tsx"), "export default () => null;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "stories"]);
  cleanRepoCache = { repo, sha: git(["rev-parse", "HEAD"]).trim() };
  return cleanRepoCache;
}

function implementOutput(): string {
  return `STATUS: done\nCHANGES: finished remaining story\nCOMMIT_SHA: ${cleanFixtureRepo().sha}\nTEST_RESULT: 1 pass`;
}

type SeededRun = {
  runId: string;
  stepDbIds: Record<string, string>;
  stories: { id: string; storyId: string }[];
};

function insertFailedMidImplementRun(opts: {
  failedOutput: string;
  failedStepId?: "implement" | "verify";
}): SeededRun {
  const db = getDb();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const { repo, sha } = cleanFixtureRepo();
  const context = JSON.stringify({ repo, branch: "feat-resume", commit_sha: sha });

  db.prepare(
    `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
     VALUES (?, 'thecoach-dev', 'TASK-940: synthetic resume', 'failed', ?, ?, ?)`,
  ).run(runId, context, now, now);

  const stepDbIds: Record<string, string> = {};
  const steps: Array<{
    stepId: string;
    agentId: string;
    stepIndex: number;
    expects: string;
    status: string;
    type?: string;
    loopConfig?: Record<string, unknown>;
    output?: string | null;
  }> = [
    {
      stepId: "setup",
      agentId: "thecoach-dev_setup",
      stepIndex: 0,
      expects: "STATUS:",
      status: "done",
    },
    {
      stepId: "plan",
      agentId: "thecoach-dev_planner",
      stepIndex: 1,
      expects: "STATUS:",
      status: "done",
    },
    {
      stepId: "implement",
      agentId: DEVELOPER_AGENT_ID,
      stepIndex: 2,
      expects: "STATUS:",
      status: opts.failedStepId === "verify" ? "running" : "failed",
      type: "loop",
      loopConfig: { over: "stories", verifyEach: true, verifyStep: "verify" },
      output: opts.failedStepId === "implement" || !opts.failedStepId ? opts.failedOutput : null,
    },
    {
      stepId: "verify",
      agentId: VERIFIER_AGENT_ID,
      stepIndex: 3,
      expects: "GATE: STATUS:",
      status: opts.failedStepId === "verify" ? "failed" : "waiting",
      output: opts.failedStepId === "verify" ? opts.failedOutput : null,
    },
    {
      stepId: "pr",
      agentId: "thecoach-dev_pr",
      stepIndex: 4,
      expects: "STATUS:",
      status: "waiting",
    },
  ];

  for (const step of steps) {
    const id = randomUUID();
    stepDbIds[step.stepId] = id;
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type, loop_config, current_story_id, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      step.stepId,
      runId,
      step.agentId,
      step.stepIndex,
      "test input",
      step.expects,
      step.status,
      now,
      now,
      step.type ?? "single",
      step.loopConfig ? JSON.stringify(step.loopConfig) : null,
      null,
      step.output ?? null,
    );
  }

  const stories = [
    { storyId: "S1", title: "First story", status: "done", output: S1_OUTPUT },
    { storyId: "S2", title: "Second story", status: "done", output: S2_OUTPUT },
    { storyId: "S3", title: "Third story", status: "failed", output: opts.failedOutput },
  ];
  const storyRows: { id: string; storyId: string }[] = [];
  stories.forEach((s, index) => {
    const id = randomUUID();
    storyRows.push({ id, storyId: s.storyId });
    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at, output)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 0, 2, ?, ?, ?)`,
    ).run(id, runId, index, s.storyId, s.title, s.title, s.status, now, now, s.output);
  });

  const failedStoryId = storyRows[2].id;
  if (opts.failedStepId === "verify") {
    db.prepare("UPDATE steps SET current_story_id = ? WHERE id = ?").run(failedStoryId, stepDbIds.implement);
  } else {
    db.prepare("UPDATE steps SET current_story_id = ? WHERE id = ?").run(failedStoryId, stepDbIds.implement);
  }

  return { runId, stepDbIds, stories: storyRows };
}

function storySnapshot(runId: string): Array<{ story_id: string; status: string; output: string | null }> {
  const db = getDb();
  return db
    .prepare(
      "SELECT story_id, status, COALESCE(output, '') AS output FROM stories WHERE run_id = ? ORDER BY story_index ASC",
    )
    .all(runId) as Array<{ story_id: string; status: string; output: string | null }>;
}

function evalResume(runId: string, taskId: string): {
  status: number | null;
  parsed: Record<string, unknown>;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ["local-tools/coordinator-trigger.mjs", "--eval-auto-retry-resume", runId],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        COORDINATOR_TOKEN: "x",
        COORDINATOR_EVAL_TASK_ID: taskId,
      },
      encoding: "utf-8",
      timeout: EVAL_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  let parsed: Record<string, unknown> = {};
  try {
    const start = (result.stdout || "").lastIndexOf("\n{");
    const jsonText = start >= 0 ? (result.stdout || "").slice(start + 1) : result.stdout || "{}";
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = { parseError: true, stdout: result.stdout };
  }
  return {
    status: result.status,
    parsed,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

describe("auto-retry resumes a failed multi-story run instead of dispatching a new one", () => {
  const runIds: string[] = [];

  afterEach(() => {
    const db = getDb();
    for (const runId of runIds) {
      db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
    runIds.length = 0;
  });

  it("transient-class: resumes the same run, leaves completed stories untouched, and the remaining story can finish", () => {
    const seeded = insertFailedMidImplementRun({
      failedOutput: TRANSIENT_IMPLEMENT_OUTPUT,
      failedStepId: "implement",
    });
    runIds.push(seeded.runId);

    const before = storySnapshot(seeded.runId);
    assert.deepEqual(
      before.map((s) => [s.story_id, s.status]),
      [
        ["S1", "done"],
        ["S2", "done"],
        ["S3", "failed"],
      ],
    );

    const evaled = evalResume(seeded.runId, "TASK-940");
    assert.equal(evaled.status, 0, `eval failed: ${evaled.stderr || evaled.stdout}`);
    const result = evaled.parsed.result as {
      resumed?: boolean;
      runId?: string;
      outcome?: string;
      retryItem?: { runId?: string; status?: string };
    };
    assert.equal(result?.resumed, true, JSON.stringify(evaled.parsed, null, 2));
    assert.equal(result?.runId, seeded.runId);
    assert.equal(result?.retryItem?.runId, seeded.runId);
    assert.equal(result?.retryItem?.status, "dispatched");
    assert.equal(result?.outcome, "retry-pending");

    const runAfter = evaled.parsed.runAfter as { id?: string; status?: string };
    assert.equal(runAfter?.id, seeded.runId);
    assert.equal(runAfter?.status, "running");

    const afterResume = storySnapshot(seeded.runId);
    assert.equal(afterResume[0].status, "done");
    assert.equal(afterResume[0].output, S1_OUTPUT);
    assert.equal(afterResume[1].status, "done");
    assert.equal(afterResume[1].output, S2_OUTPUT);
    assert.equal(afterResume[2].status, "pending", JSON.stringify(afterResume[2]));

    const claimed = claimStep(DEVELOPER_AGENT_ID);
    assert.equal(claimed.found, true, JSON.stringify(claimed));
    assert.equal(claimed.runId, seeded.runId);
    assert.equal(claimed.stepId, seeded.stepDbIds.implement);

    const db = getDb();
    const current = db
      .prepare("SELECT current_story_id FROM steps WHERE id = ?")
      .get(seeded.stepDbIds.implement) as { current_story_id: string };
    assert.equal(current.current_story_id, seeded.stories[2].id);

    const implementResult = completeStep(seeded.stepDbIds.implement, implementOutput());
    assert.equal(implementResult.advanced, false);

    db.prepare("UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(
      seeded.stepDbIds.verify,
    );
    const verifyResult = completeStep(seeded.stepDbIds.verify, VERIFY_PASS_OUTPUT);
    assert.equal(verifyResult.advanced, true, "loop should finish and advance to pr");
    assert.equal(verifyResult.runCompleted, false);

    const finished = storySnapshot(seeded.runId);
    assert.equal(finished[0].status, "done");
    assert.equal(finished[0].output, S1_OUTPUT, "S1 output must not be rewritten");
    assert.equal(finished[1].status, "done");
    assert.equal(finished[1].output, S2_OUTPUT, "S2 output must not be rewritten");
    assert.equal(finished[2].status, "done");

    const implement = db.prepare("SELECT status FROM steps WHERE id = ?").get(seeded.stepDbIds.implement) as {
      status: string;
    };
    const verify = db.prepare("SELECT status FROM steps WHERE id = ?").get(seeded.stepDbIds.verify) as {
      status: string;
    };
    const pr = db.prepare("SELECT status FROM steps WHERE id = ?").get(seeded.stepDbIds.pr) as { status: string };
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(seeded.runId) as { status: string };
    assert.equal(implement.status, "done");
    assert.equal(verify.status, "done");
    assert.equal(pr.status, "pending");
    assert.equal(run.status, "running");
  });

  it("structural-class negative control: parks, does not resume, completed stories stay put", () => {
    const seeded = insertFailedMidImplementRun({
      failedOutput: STRUCTURAL_VERIFY_OUTPUT,
      failedStepId: "verify",
    });
    runIds.push(seeded.runId);

    const evaled = evalResume(seeded.runId, "TASK-941");
    assert.equal(evaled.status, 0, `eval failed: ${evaled.stderr || evaled.stdout}`);
    const result = evaled.parsed.result as {
      resumed?: boolean;
      outcome?: string;
      parkedReason?: string;
    };
    assert.equal(result?.resumed, false, JSON.stringify(evaled.parsed, null, 2));
    assert.equal(result?.outcome, "failed");
    assert.equal(result?.parkedReason, "structural");

    const runAfter = evaled.parsed.runAfter as { id?: string; status?: string };
    assert.equal(runAfter?.id, seeded.runId);
    assert.equal(runAfter?.status, "failed", "structural must not flip the run back to running");

    const queue = evaled.parsed.queue as Array<{ status?: string; runId?: string }>;
    assert.equal(
      (queue || []).filter((i) => i.status === "dispatched" || i.status === "pending").length,
      0,
      JSON.stringify(queue),
    );

    const after = storySnapshot(seeded.runId);
    assert.equal(after[0].status, "done");
    assert.equal(after[0].output, S1_OUTPUT);
    assert.equal(after[1].status, "done");
    assert.equal(after[1].output, S2_OUTPUT);
    assert.equal(after[2].status, "failed");
  });
});
