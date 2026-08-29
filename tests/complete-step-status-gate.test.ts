import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDb } from "../dist/db.js";
import { claimStep, completeStep, matchOutputFailure } from "../dist/installer/step-ops.js";
import { getStepFailWhen } from "../dist/installer/workflow-spec.js";
import { resolveAntfarmRoot } from "../dist/installer/paths.js";

/**
 * A real, throwaway git repo with a `staging` base and one commit touching an
 * ordinary application file. The host protected-path gate fails CLOSED when
 * its `git diff` cannot run at all (2026-08-29), so fixtures that expect the
 * gate to PASS must give it a diff it can actually compute — a fake
 * "/tmp/repo" now reads as "the gate could not run", not "nothing matched".
 */
let cleanRepoCache: { repo: string; sha: string } | null = null;
function cleanFixtureRepo(): { repo: string; sha: string } {
  if (cleanRepoCache) return cleanRepoCache;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-clean-fixture-"));
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf-8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  git(["init", "-q", "-b", "staging"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-qb", "feat-x"]);
  fs.mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
  fs.writeFileSync(path.join(repo, "apps", "web", "page.tsx"), "export default () => null;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "story"]);
  const sha = git(["rev-parse", "HEAD"]).trim();
  cleanRepoCache = { repo, sha };
  return cleanRepoCache;
}

describe("completeStep status and contract gates", () => {
  const testRunIds: string[] = [];
  const testStepIds: string[] = [];

  afterEach(() => {
    const db = getDb();
    for (const runId of testRunIds) {
      db.prepare("DELETE FROM stories WHERE run_id = ?").run(runId);
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
    type?: string;
    loopConfig?: Record<string, unknown>;
    currentStoryId?: string;
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
        `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type, loop_config, current_story_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        step.type ?? "single",
        step.loopConfig ? JSON.stringify(step.loopConfig) : null,
        step.currentStoryId ?? null,
      );
    }

    return { runId, stepDbIds };
  }

  // COMMIT_SHA must be the fixture repo's real head: completeStep copies it
  // into run context, and the host protected-path gate now fails CLOSED when
  // its `git diff` cannot run against that sha (2026-08-29). A placeholder sha
  // used to read as "nothing matched"; it now reads as "the gate could not run".
  const IMPLEMENT_OUTPUT_WITHOUT_GATE =
    `STATUS: done\nCHANGES: touched packages/check-types/src/type-aliases.ts\nCOMMIT_SHA: ${cleanFixtureRepo().sha}\nTEST_RESULT: 1 pass`;

  function insertVerifyEachFixture(opts: { verifyMaxRetries?: number } = {}) {
    const storyPk = randomUUID();
    const now = new Date().toISOString();
    const { runId, stepDbIds } = insertRun(
      [
        {
          stepId: "implement",
          agentId: "thecoach-dev_developer",
          stepIndex: 0,
          expects: "STATUS:",
          status: "running",
          type: "loop",
          loopConfig: { over: "stories", verifyEach: true, verifyStep: "verify" },
          currentStoryId: storyPk,
        },
        {
          stepId: "verify",
          agentId: "thecoach-dev_verifier",
          stepIndex: 1,
          expects: "GATE: STATUS:",
          status: "waiting",
          maxRetries: opts.verifyMaxRetries ?? 1,
        },
        {
          stepId: "pr",
          agentId: "thecoach-dev_pr",
          stepIndex: 2,
          expects: "STATUS:",
          status: "waiting",
        },
      ],
      { repo: cleanFixtureRepo().repo, branch: "feat-x", commit_sha: cleanFixtureRepo().sha },
    );
    const db = getDb();
    db.prepare(
      `INSERT INTO stories (id, run_id, story_index, story_id, title, description, acceptance_criteria, status, retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, 0, 'STORY-01', 'One story', 'desc', '[]', 'pending', 0, 2, ?, ?)`,
    ).run(storyPk, runId, now, now);
    return { runId, stepDbIds, storyPk };
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
    assert.ok(setup.output.includes("ENGINE_ERROR: missing_required_keys: status"));
    assert.ok(setup.output.includes("BUILD_CMD: npm run build"));
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

  it("STATUS: changes_requested from review fails the step and does not advance to merge", () => {
    const { stepDbIds } = insertRun([
      { stepId: "review", agentId: "thecoach-dev_reviewer", stepIndex: 0, expects: "STATUS:", status: "running", maxRetries: 1 },
      { stepId: "merge", agentId: "thecoach-dev_merge", stepIndex: 1, expects: "STATUS:", status: "waiting" },
    ], { repo: "/tmp/repo", branch: "feat-x", pr_url: "https://github.com/o/r/pull/1" });

    const result = completeStep(stepDbIds.review, "STATUS: changes_requested\nNOTES: fix the tests");

    assert.equal(result.advanced, false);
    assert.equal(result.runCompleted, false);

    const db = getDb();
    const review = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepDbIds.review) as {
      status: string;
      retry_count: number;
      output: string;
    };
    assert.notEqual(review.status, "done");
    assert.equal(review.status, "pending");
    assert.equal(review.retry_count, 1);
    assert.ok(review.output.includes("STATUS: changes_requested"));

    const merge = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.merge) as { status: string };
    assert.equal(merge.status, "waiting");
  });

  it("verify GATE: fail + STATUS: pass fails the step and does not advance", () => {
    const { stepDbIds } = insertRun([
      { stepId: "verify", agentId: "thecoach-dev_verifier", stepIndex: 0, expects: "GATE: STATUS:", status: "running", maxRetries: 1 },
      { stepId: "test", agentId: "thecoach-dev_tester", stepIndex: 1, expects: "STATUS:", status: "waiting" },
    ], { repo: "/tmp/repo", branch: "feat-x", commit_sha: "abc123" });

    const result = completeStep(
      stepDbIds.verify,
      "GATE: fail\nGATE_REASON: _SSoT/CORE.md\nSTATUS: pass",
    );

    assert.equal(result.advanced, false);
    assert.equal(result.runCompleted, false);

    const db = getDb();
    const verify = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepDbIds.verify) as {
      status: string;
      retry_count: number;
      output: string;
    };
    assert.notEqual(verify.status, "done");
    assert.equal(verify.status, "pending");
    assert.equal(verify.retry_count, 1);
    assert.ok(verify.output.includes("GATE: fail"));

    const test = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.test) as { status: string };
    assert.equal(test.status, "waiting");
  });

  it("verify GATE: fail for newly protected paths (supabase config, workflows, gitignore) does not advance", () => {
    for (const offending of ["supabase/config.toml", ".github/workflows/anything.yml", ".gitignore"]) {
      const { stepDbIds } = insertRun([
        { stepId: "verify", agentId: "thecoach-dev_verifier", stepIndex: 0, expects: "GATE: STATUS:", status: "running", maxRetries: 1 },
        { stepId: "test", agentId: "thecoach-dev_tester", stepIndex: 1, expects: "STATUS:", status: "waiting" },
      ], { repo: "/tmp/repo", branch: "feat-x", commit_sha: "abc123" });

      const result = completeStep(
        stepDbIds.verify,
        `GATE: fail\nGATE_REASON: ${offending}\nSTATUS: pass`,
      );
      assert.equal(result.advanced, false, offending);

      const db = getDb();
      const verify = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepDbIds.verify) as {
        status: string;
        output: string;
      };
      assert.notEqual(verify.status, "done", offending);
      assert.ok(verify.output.includes("GATE: fail"), offending);
    }
  });

  it("verify step fail_when from workflow.yml fails on STATUS: blocked and fail, passes on STATUS: pass", () => {
    const failWhen = getStepFailWhen("thecoach-dev", "verify");
    assert.deepEqual(failWhen, { gate: ["fail"], status: ["fail", "blocked", "failed", "error"] });

    // matchOutputFailure also reports WHY a verdict failed (TASK-040); the
    // hit itself is still key + value.
    const hit = (parsed: Record<string, string>, fw: Record<string, string[]> | undefined) => {
      const failure = matchOutputFailure(parsed, fw);
      return failure && { key: failure.key, value: failure.value };
    };

    const blockedWithPassingGate = hit({ status: "blocked", gate: "pass" }, failWhen);
    assert.deepEqual(blockedWithPassingGate, { key: "status", value: "blocked" });

    const blockedWithoutGate = hit({ status: "blocked" }, failWhen);
    assert.deepEqual(blockedWithoutGate, { key: "status", value: "blocked" });

    const failHit = hit({ status: "fail", gate: "pass" }, failWhen);
    assert.deepEqual(failHit, { key: "status", value: "fail" });

    const ok = matchOutputFailure({ status: "pass", gate: "pass" }, failWhen);
    assert.equal(ok, null);
  });

  it("fail_when with only a non-status key still applies the default status deny-list", () => {
    // Declaring fail_when: { gate: [fail] } must ADD a gate check, not opt
    // the step out of STATUS: blocked/failed/error/fail.
    const gateOnly = { gate: ["fail"] };

    for (const status of ["blocked", "failed", "error", "fail"]) {
      const hit = matchOutputFailure({ status, gate: "pass" }, gateOnly);
      assert.deepEqual(
        hit && { key: hit.key, value: hit.value },
        { key: "status", value: status },
        `STATUS: ${status} should still fail`,
      );
    }

    const gateHit = matchOutputFailure({ status: "pass", gate: "fail" }, gateOnly);
    assert.deepEqual(gateHit && { key: gateHit.key, value: gateHit.value }, {
      key: "gate",
      value: "fail",
    });

    const ok = matchOutputFailure({ status: "pass", gate: "pass" }, gateOnly);
    assert.equal(ok, null);
  });

  it("without fail_when, default deny-list still fails STATUS: fail and does not advance", () => {
    const { stepDbIds } = insertRun([
      { stepId: "setup", agentId: "thecoach-dev_setup", stepIndex: 0, expects: "STATUS:", status: "running", maxRetries: 2 },
      { stepId: "implement", agentId: "thecoach-dev_developer", stepIndex: 1, expects: "STATUS:", status: "waiting" },
    ]);

    const result = completeStep(stepDbIds.setup, "STATUS: fail\nREASON: baseline tests red");

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
    assert.ok(setup.output.includes("STATUS: fail"));

    const implement = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string };
    assert.equal(implement.status, "waiting");
  });

  it("missing template key on claim fails immediately without consuming retries", () => {
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
    const step = db.prepare("SELECT status, retry_count, output, failure_cause FROM steps WHERE id = ?").get(stepDbIds.implement) as {
      status: string;
      retry_count: number;
      output: string;
      failure_cause: string | null;
    };
    assert.equal(step.status, "failed");
    assert.equal(step.retry_count, 0);
    assert.equal(step.failure_cause, "own-output");
    assert.ok(step.output.includes("missing required template key(s) build_cmd, test_cmd"));
    assert.ok(step.output.includes("ENGINE_ERROR: missing_template_keys: build_cmd, test_cmd"));

    const again = claimStep(agentId);
    assert.equal(again.found, false);
    const stepAfter = db.prepare("SELECT retry_count FROM steps WHERE id = ?").get(stepDbIds.implement) as { retry_count: number };
    assert.equal(stepAfter.retry_count, 0);

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");
  });

  it("implement STATUS: done without GATE completes the story and leaves verify pending", () => {
    const { runId, stepDbIds } = insertVerifyEachFixture();

    const result = completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);

    assert.equal(result.advanced, false);
    assert.equal(result.runCompleted, false);

    const db = getDb();
    const implement = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string };
    assert.equal(implement.status, "running");

    const verify = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.verify) as { status: string };
    assert.equal(verify.status, "pending");

    const pr = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.pr) as { status: string };
    assert.equal(pr.status, "waiting");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running");
  });

  it("verify missing GATE is an engine error, not a gate verdict, and terminalizes the run", () => {
    const { runId, stepDbIds } = insertVerifyEachFixture({ verifyMaxRetries: 0 });

    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);

    const agentOutput = "STATUS: done\nCHANGES: ran the verifier, looks fine";
    const result = completeStep(stepDbIds.verify, agentOutput);

    assert.equal(result.advanced, false);

    const db = getDb();
    const verify = db.prepare("SELECT status, output, failure_cause FROM steps WHERE id = ?").get(stepDbIds.verify) as {
      status: string;
      output: string;
      failure_cause: string | null;
    };
    assert.equal(verify.status, "failed");
    assert.ok(verify.output.startsWith("ENGINE_ERROR: missing_required_keys: gate"));
    assert.ok(verify.output.includes("ORIGINAL_OUTPUT:"));
    assert.ok(verify.output.includes(agentOutput));
    assert.notEqual(verify.output.trim(), "Step output missing required key(s): gate");
    assert.equal(verify.failure_cause, "own-output");

    const implement = db.prepare("SELECT status, failure_cause FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string; failure_cause: string | null };
    assert.equal(implement.status, "failed");
    assert.equal(implement.failure_cause, "terminalized-by-run-failure");

    const pr = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.pr) as { status: string };
    assert.equal(pr.status, "cancelled");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");
  });

  it("verify GATE: pass STATUS: pass after implement-without-gate reaches the pr step", () => {
    const { runId, stepDbIds } = insertVerifyEachFixture();

    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);

    const result = completeStep(stepDbIds.verify, "GATE: pass\nSTATUS: pass");

    assert.equal(result.advanced, true);
    assert.equal(result.runCompleted, false);

    const db = getDb();
    const implement = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string };
    assert.equal(implement.status, "done");

    const verify = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepDbIds.verify) as { status: string; output: string };
    assert.equal(verify.status, "done", verify.output);

    const pr = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.pr) as { status: string };
    assert.equal(pr.status, "pending");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running");
  });

  it("verify CHANGES: GATE: pass (run #23 nested-key anti-pattern) still counts as GATE and advances", () => {
    const { runId, stepDbIds } = insertVerifyEachFixture();

    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);

    const run23OriginalOutput = [
      "STATUS: done",
      "CHANGES: GATE: pass",
      "GATE_REASON: (n/a — pass) only package.json touched",
      "STATUS: pass",
      "STATUS_REASON: (n/a — pass) matches the claim",
      "TESTS: npm test exit 0",
    ].join("\n");
    const result = completeStep(stepDbIds.verify, run23OriginalOutput);

    assert.equal(result.advanced, true);

    const db = getDb();
    const verify = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepDbIds.verify) as {
      status: string;
      output: string;
    };
    assert.equal(verify.status, "done");
    assert.equal(verify.output.includes("ENGINE_ERROR: missing_required_keys"), false);

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running");
  });

  it("implement output without COMMIT_SHA fails at implement and preserves original output", () => {
    const { runId, stepDbIds } = insertVerifyEachFixture();
    const db = getDb();
    db.prepare("UPDATE steps SET expects = 'STATUS: COMMIT_SHA:', max_retries = 0 WHERE id = ?").run(stepDbIds.implement);
    db.prepare("UPDATE stories SET max_retries = 0 WHERE run_id = ?").run(runId);

    const output = "STATUS: done\nCHANGES: touched tools/schema-drift/\nTESTS: 2 pass";
    const result = completeStep(stepDbIds.implement, output);

    assert.equal(result.advanced, false);

    const implement = db.prepare("SELECT status, output, failure_cause FROM steps WHERE id = ?").get(stepDbIds.implement) as {
      status: string;
      output: string;
      failure_cause: string | null;
    };
    assert.equal(implement.status, "failed");
    assert.equal(implement.failure_cause, "own-output");
    assert.ok(implement.output.startsWith("ENGINE_ERROR: missing_required_keys: commit_sha"));
    assert.ok(implement.output.includes("ORIGINAL_OUTPUT:"));
    assert.ok(implement.output.includes(output));

    const verify = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.verify) as { status: string };
    assert.equal(verify.status, "cancelled");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");
  });

  it("implement mid-line COMMIT_SHA is recovered and verify template renders it", () => {
    const verifierAgent = `thecoach-dev_verifier-${randomUUID().slice(0, 8)}`;
    const { runId, stepDbIds } = insertVerifyEachFixture();
    const db = getDb();
    db.prepare("UPDATE steps SET expects = 'STATUS: COMMIT_SHA:' WHERE id = ?").run(stepDbIds.implement);
    db.prepare("UPDATE steps SET agent_id = ?, input_template = ? WHERE id = ?").run(
      verifierAgent,
      "COMMIT: {{commit_sha}}\nCHANGES: {{changes}}",
      stepDbIds.verify,
    );
    db.prepare("UPDATE runs SET context = ? WHERE id = ?").run(
      JSON.stringify({ repo: "/tmp/repo", branch: "feat-x" }),
      runId,
    );

    const output = [
      "STATUS: done",
      "CHANGES: added parser",
      "TESTS: both tests passed (tests 2, pass 2, fail 0): \"parseMigrations ignores create index statements and comment-only lines\". COMMIT_SHA: 9e98c16",
    ].join("\n");
    completeStep(stepDbIds.implement, output);

    const ctxRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(ctxRow.context) as Record<string, string>;
    assert.equal(ctx.commit_sha, "9e98c16");

    const claimed = claimStep(verifierAgent);
    assert.equal(claimed.found, true);
    assert.ok(claimed.resolvedInput?.includes("COMMIT: 9e98c16"));
  });

  it("verify claim with genuinely absent commit_sha fails once immediately", () => {
    const agentId = `thecoach-dev_verifier-${randomUUID().slice(0, 8)}`;
    const { runId, stepDbIds } = insertRun([
      {
        stepId: "verify",
        agentId,
        stepIndex: 0,
        expects: "GATE: STATUS:",
        status: "pending",
        maxRetries: 1,
        inputTemplate: "COMMIT: {{commit_sha}}\nREPO: {{repo}}",
      },
    ], { repo: "/tmp/repo" });

    const first = claimStep(agentId);
    assert.equal(first.found, false);

    const db = getDb();
    const step = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepDbIds.verify) as {
      status: string;
      retry_count: number;
      output: string;
    };
    assert.equal(step.status, "failed");
    assert.equal(step.retry_count, 0);
    assert.ok(step.output.includes("missing required template key(s) commit_sha"));
    assert.ok(step.output.includes("ENGINE_ERROR: missing_template_keys: commit_sha"));

    const second = claimStep(agentId);
    assert.equal(second.found, false);
    const after = db.prepare("SELECT retry_count FROM steps WHERE id = ?").get(stepDbIds.verify) as { retry_count: number };
    assert.equal(after.retry_count, 0);

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");
  });

  it("verifyEach STATUS: fail bounces to implement with STATUS_REASON as verify_feedback, then a corrected attempt completes", () => {
    const developerAgent = `thecoach-dev_developer-${randomUUID().slice(0, 8)}`;
    const { runId, stepDbIds } = insertVerifyEachFixture();
    const db = getDb();
    db.prepare("UPDATE steps SET agent_id = ?, input_template = ?, max_retries = 2 WHERE id = ?").run(
      developerAgent,
      "STORY:\n{{current_story}}\nVERIFY FEEDBACK:\n{{verify_feedback}}\n",
      stepDbIds.implement,
    );

    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);

    const failOutput = [
      "GATE: pass",
      "STATUS: fail",
      "STATUS_REASON: claimed 10 sub-tests but the file has 8",
    ].join("\n");
    const bounce = completeStep(stepDbIds.verify, failOutput);

    assert.equal(bounce.advanced, false);
    assert.equal(bounce.runCompleted, false);

    const verifyAfterFail = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepDbIds.verify) as {
      status: string;
      retry_count: number;
      output: string;
    };
    assert.equal(verifyAfterFail.status, "waiting");
    assert.equal(verifyAfterFail.retry_count, 0);
    assert.equal(verifyAfterFail.output, failOutput);

    const implementAfterFail = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string };
    assert.equal(implementAfterFail.status, "pending");

    const storyAfterFail = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ?").get(runId) as {
      status: string;
      retry_count: number;
    };
    assert.equal(storyAfterFail.status, "pending");
    assert.equal(storyAfterFail.retry_count, 1);

    const runAfterFail = db.prepare("SELECT status, context FROM runs WHERE id = ?").get(runId) as {
      status: string;
      context: string;
    };
    assert.equal(runAfterFail.status, "running");
    const ctx = JSON.parse(runAfterFail.context) as Record<string, string>;
    assert.equal(ctx.verify_feedback, "claimed 10 sub-tests but the file has 8");

    const claimed = claimStep(developerAgent);
    assert.equal(claimed.found, true);
    assert.ok(claimed.resolvedInput?.includes("claimed 10 sub-tests but the file has 8"));

    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);
    const passed = completeStep(stepDbIds.verify, "GATE: pass\nSTATUS: pass");

    assert.equal(passed.advanced, true);
    assert.equal(passed.runCompleted, false);

    const runAfterPass = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(runAfterPass.status, "running");
    const implementDone = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string };
    assert.equal(implementDone.status, "done");
    const pr = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.pr) as { status: string };
    assert.equal(pr.status, "pending");
  });

  it("verifyEach GATE: fail + STATUS: fail together bounces to implement with both reasons in verify_feedback", () => {
    const developerAgent = `thecoach-dev_developer-${randomUUID().slice(0, 8)}`;
    const { runId, stepDbIds } = insertVerifyEachFixture();
    const db = getDb();
    db.prepare("UPDATE steps SET agent_id = ?, input_template = ?, max_retries = 2 WHERE id = ?").run(
      developerAgent,
      "STORY:\n{{current_story}}\nVERIFY FEEDBACK:\n{{verify_feedback}}\n",
      stepDbIds.implement,
    );

    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);

    const gateReason = "packages/foo.ts is outside claimed CHANGES";
    const statusReason = "claimed 10 sub-tests but the file has 8";
    const failOutput = [
      "GATE: fail",
      `GATE_REASON: ${gateReason}`,
      "STATUS: fail",
      `STATUS_REASON: ${statusReason}`,
    ].join("\n");
    const bounce = completeStep(stepDbIds.verify, failOutput);

    assert.equal(bounce.advanced, false);
    assert.equal(bounce.runCompleted, false);

    const verifyAfterFail = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(stepDbIds.verify) as {
      status: string;
      retry_count: number;
    };
    assert.equal(verifyAfterFail.status, "waiting");
    assert.equal(verifyAfterFail.retry_count, 0);

    const implementAfterFail = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string };
    assert.equal(implementAfterFail.status, "pending");

    const storyAfterFail = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ?").get(runId) as {
      status: string;
      retry_count: number;
    };
    assert.equal(storyAfterFail.status, "pending");
    assert.equal(storyAfterFail.retry_count, 1);

    const runAfterFail = db.prepare("SELECT status, context FROM runs WHERE id = ?").get(runId) as {
      status: string;
      context: string;
    };
    assert.equal(runAfterFail.status, "running");
    const ctx = JSON.parse(runAfterFail.context) as Record<string, string>;
    assert.equal(ctx.verify_feedback, `${gateReason}\n${statusReason}`);

    const claimed = claimStep(developerAgent);
    assert.equal(claimed.found, true);
    assert.ok(claimed.resolvedInput?.includes(gateReason));
    assert.ok(claimed.resolvedInput?.includes(statusReason));
  });

  it("verifyEach does not bleed a stale GATE_REASON into a later GATE: pass bounce", () => {
    const { runId, stepDbIds, storyPk } = insertVerifyEachFixture();
    const db = getDb();
    db.prepare("UPDATE steps SET max_retries = 2 WHERE id = ?").run(stepDbIds.implement);

    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);
    completeStep(
      stepDbIds.verify,
      [
        "GATE: fail",
        "GATE_REASON: touched packages/unrelated.ts",
        "STATUS: fail",
        "STATUS_REASON: test count wrong",
      ].join("\n"),
    );

    const afterFirst = JSON.parse(
      (db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string }).context,
    ) as Record<string, string>;
    assert.equal(afterFirst.verify_feedback, "touched packages/unrelated.ts\ntest count wrong");

    db.prepare("UPDATE steps SET current_story_id = ?, status = 'running' WHERE id = ?").run(
      storyPk,
      stepDbIds.implement,
    );
    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);
    completeStep(
      stepDbIds.verify,
      "GATE: pass\nSTATUS: fail\nSTATUS_REASON: still off by one",
    );

    const afterSecond = JSON.parse(
      (db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string }).context,
    ) as Record<string, string>;
    assert.equal(afterSecond.gate_reason, "touched packages/unrelated.ts");
    assert.equal(afterSecond.gate, "pass");
    assert.equal(afterSecond.verify_feedback, "still off by one");
    assert.equal(afterSecond.verify_feedback.includes("touched packages/unrelated.ts"), false);
  });

  it("verifyEach empty STATUS_REASON falls through to ISSUES in verify_feedback", () => {
    const { runId, stepDbIds } = insertVerifyEachFixture();
    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);

    const bounce = completeStep(
      stepDbIds.verify,
      "GATE: pass\nSTATUS: fail\nSTATUS_REASON:\nISSUES: tests were not actually run",
    );
    assert.equal(bounce.runCompleted, false);

    const db = getDb();
    const verify = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.verify) as { status: string };
    assert.equal(verify.status, "waiting");
    const ctxRow = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const ctx = JSON.parse(ctxRow.context) as Record<string, string>;
    assert.equal(ctx.verify_feedback, "tests were not actually run");
  });

  it("verifyEach STATUS: fail is capped by implement.max_retries and does not retry verify forever", () => {
    const { runId, stepDbIds, storyPk } = insertVerifyEachFixture();
    const db = getDb();
    db.prepare("UPDATE steps SET max_retries = 2 WHERE id = ?").run(stepDbIds.implement);

    const failOutput = "GATE: pass\nSTATUS: fail\nSTATUS_REASON: still wrong";
    function completeImplementForStory(): void {
      db.prepare("UPDATE steps SET current_story_id = ?, status = 'running' WHERE id = ?").run(
        storyPk,
        stepDbIds.implement,
      );
      completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
      dbSetVerifyRunning(stepDbIds.verify);
    }

    for (let i = 0; i < 2; i++) {
      completeImplementForStory();
      const bounce = completeStep(stepDbIds.verify, failOutput);
      assert.equal(bounce.runCompleted, false, `bounce ${i}`);
      const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
      assert.equal(run.status, "running", `bounce ${i}`);
      const verify = db.prepare("SELECT retry_count, status FROM steps WHERE id = ?").get(stepDbIds.verify) as {
        retry_count: number;
        status: string;
      };
      assert.equal(verify.retry_count, 0, `bounce ${i}`);
      assert.equal(verify.status, "waiting", `bounce ${i}`);
    }

    completeImplementForStory();
    const exhausted = completeStep(stepDbIds.verify, failOutput);
    assert.equal(exhausted.runCompleted, false);

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed");
    const story = db.prepare("SELECT status, retry_count FROM stories WHERE run_id = ?").get(runId) as {
      status: string;
      retry_count: number;
    };
    assert.equal(story.status, "failed");
    assert.equal(story.retry_count, 3);
    const verify = db.prepare("SELECT retry_count FROM steps WHERE id = ?").get(stepDbIds.verify) as { retry_count: number };
    assert.equal(verify.retry_count, 0);
    assert.equal(lastRunFailedDetail(runId), "Verification retries exhausted: still wrong");
  });

  it("verifyEach GATE: fail still fails verify itself and does not bounce to implement", () => {
    const { runId, stepDbIds } = insertVerifyEachFixture({ verifyMaxRetries: 1 });
    completeStep(stepDbIds.implement, IMPLEMENT_OUTPUT_WITHOUT_GATE);
    dbSetVerifyRunning(stepDbIds.verify);

    const result = completeStep(
      stepDbIds.verify,
      "GATE: fail\nGATE_REASON: _SSoT/CORE.md\nSTATUS: pass",
    );
    assert.equal(result.advanced, false);

    const db = getDb();
    const verify = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(stepDbIds.verify) as {
      status: string;
      retry_count: number;
    };
    assert.equal(verify.status, "pending");
    assert.equal(verify.retry_count, 1);

    const implement = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbIds.implement) as { status: string };
    assert.equal(implement.status, "running");

    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running");
  });
});

function dbSetVerifyRunning(verifyDbId: string): void {
  const db = getDb();
  db.prepare("UPDATE steps SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(verifyDbId);
}

function lastRunFailedDetail(runId: string): string | undefined {
  // Same resolution events.ts uses — under `npm test` this is the per-worker
  // OPENCLAW_STATE_DIR temp dir, not the developer's real events.jsonl.
  const eventsFile = path.join(resolveAntfarmRoot(), "events.jsonl");
  if (!fs.existsSync(eventsFile)) return undefined;
  let detail: string | undefined;
  for (const line of fs.readFileSync(eventsFile, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as { event?: string; runId?: string; detail?: string };
      if (evt.event === "run.failed" && evt.runId === runId) {
        detail = evt.detail;
      }
    } catch {
      // skip malformed lines
    }
  }
  return detail;
}
