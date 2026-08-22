import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb } from "../dist/db.js";
import { claimStep, completeStep } from "../dist/installer/step-ops.js";

describe("completeStep status and contract gates", () => {
  const testRunIds: string[] = [];
  const testStepIds: string[] = [];

  afterEach(() => {
    const db = getDb();
    for (const runId of testRunIds) {
      db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
    testRunIds.length = 0;
    testStepIds.length = 0;
  });

  function insertRun(steps: Array<{
    stepId: string;
    agentId: string;
    stepIndex: number;
    expects: string;
    status: string;
    maxRetries?: number;
    inputTemplate?: string;
  }>, context: Record<string, string> = {}): { runId: string; stepDbIds: Record<string, string> } {
    const db = getDb();
    const runId = randomUUID();
    const now = new Date().toISOString();
    testRunIds.push(runId);

    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'test task', 'running', ?, ?, ?)`
    ).run(runId, JSON.stringify(context), now, now);

    const stepDbIds: Record<string, string> = {};
    for (const step of steps) {
      const id = randomUUID();
      stepDbIds[step.stepId] = id;
      testStepIds.push(id);
      db.prepare(
        `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'single')`
      ).run(
        id,
        step.stepId,
        runId,
        step.agentId,
        step.stepIndex,
        step.inputTemplate ?? "test input",
        step.expects,
        step.status,
        step.maxRetries ?? 2,
        now,
        now,
      );
    }

    return { runId, stepDbIds };
  }

  it("STATUS: blocked routes through failStep — pending retry, no advance", () => {
    const { runId, stepDbIds } = insertRun([
      { stepId: "setup", agentId: "thecoach-dev_setup", stepIndex: 0, expects: "STATUS:", status: "running", maxRetries: 2 },
      { stepId: "implement", agentId: "thecoach-dev_developer", stepIndex: 1, expects: "STATUS:", status: "waiting" },
    ]);

    const result = completeStep(stepDbIds.setup, "STATUS: blocked\nREASON: git auth failed");

    assert.equal(result.advanced, false);
    assert.equal(result.runCompleted, false);

    const db = getDb();
    const setup = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepDbIds.setup) as {
      status: string;
      retry_count: number;
      output: string;
    };
    assert.equal(setup.status, "pending");
    assert.equal(setup.retry_count, 1);
    assert.ok(setup.output.includes("STATUS: blocked"));
    assert.ok(setup.output.includes("git auth failed"));

    const implement = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string };
    assert.equal(implement.status, "waiting");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running");
  });

  it("missing a declared expects key fails with the key named in the message", () => {
    const { stepDbIds } = insertRun([
      { stepId: "setup", agentId: "thecoach-dev_setup", stepIndex: 0, expects: "STATUS:", status: "running" },
      { stepId: "implement", agentId: "thecoach-dev_developer", stepIndex: 1, expects: "STATUS:", status: "waiting" },
    ]);

    completeStep(stepDbIds.setup, "BUILD_CMD: npm run build\nTEST_CMD: npm test");

    const db = getDb();
    const setup = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepDbIds.setup) as {
      status: string;
      retry_count: number;
      output: string;
    };
    assert.equal(setup.status, "pending");
    assert.equal(setup.retry_count, 1);
    assert.ok(setup.output.includes("missing required key(s): status"));
  });

  it("STATUS: done with required keys present advances the pipeline", () => {
    const { stepDbIds } = insertRun([
      { stepId: "setup", agentId: "thecoach-dev_setup", stepIndex: 0, expects: "STATUS:", status: "running" },
      { stepId: "implement", agentId: "thecoach-dev_developer", stepIndex: 1, expects: "STATUS:", status: "waiting" },
    ]);

    const result = completeStep(
      stepDbIds.setup,
      "STATUS: done\nBUILD_CMD: npm run build\nTEST_CMD: npm test\nBASELINE: build passes",
    );

    assert.equal(result.advanced, true);
    assert.equal(result.runCompleted, false);

    const db = getDb();
    const setup = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.setup) as { status: string };
    assert.equal(setup.status, "done");

    const implement = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string };
    assert.equal(implement.status, "pending");
  });

  it("STATUS: changes_requested from review completes and advances (not blocked by gate)", () => {
    const { stepDbIds } = insertRun([
      { stepId: "review", agentId: "thecoach-dev_reviewer", stepIndex: 0, expects: "STATUS:", status: "running" },
      { stepId: "merge", agentId: "thecoach-dev_merge", stepIndex: 1, expects: "STATUS:", status: "waiting" },
    ], { repo: "/tmp/repo", branch: "feat-x", pr_url: "https://github.com/o/r/pull/1" });

    const result = completeStep(stepDbIds.review, "STATUS: changes_requested\nNOTES: fix the tests");

    assert.equal(result.advanced, true);
    assert.equal(result.runCompleted, false);

    const db = getDb();
    const review = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(stepDbIds.review) as {
      status: string;
      retry_count: number;
    };
    assert.equal(review.status, "done");
    assert.equal(review.retry_count, 0);

    const merge = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.merge) as { status: string };
    assert.equal(merge.status, "pending");
  });

  it("missing template key on claim routes through retry — pending, run stays running", () => {
    const agentId = `thecoach-dev_developer-${randomUUID().slice(0, 8)}`;
    const { runId, stepDbIds } = insertRun([
      {
        stepId: "implement",
        agentId,
        stepIndex: 0,
        expects: "STATUS:",
        status: "pending",
        maxRetries: 2,
        inputTemplate: "BUILD_CMD: {{build_cmd}}\nTEST_CMD: {{test_cmd}}",
      },
    ], { repo: "/tmp/repo", branch: "feat-x" });

    const result = claimStep(agentId);

    assert.equal(result.found, false);

    const db = getDb();
    const step = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepDbIds.implement) as {
      status: string;
      retry_count: number;
      output: string;
    };
    assert.equal(step.status, "pending");
    assert.equal(step.retry_count, 1);
    assert.ok(step.output.includes("missing required template key(s) build_cmd, test_cmd"));

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running");
  });
});
