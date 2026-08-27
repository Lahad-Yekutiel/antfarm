import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  EXPECTED_FAILURES_NONE,
  formatExpectedFailuresForPrompt,
  matchesExpectedFailureBaseline,
  parseExpectedFailures,
} from "../src/lib/expected-failures.ts";
import { claimStep, completeStep, resolveTemplate } from "../dist/installer/step-ops.js";
import { getDb } from "../dist/db.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Tester session output from antfarm run #19 (TASK-027 attempt 1), as
 * reconstructed from the 2026-08-27 diagnosis. Verify passed; test failed
 * four times on the known OQ-09 /404 prerender. Tests themselves passed.
 */
const TASK_027_RUN19_TEST_OUTPUT = [
  "STATUS: fail",
  "FAILURES: `npm run build` in apps/web fails during Next.js static export/prerendering with `[TypeError: Cannot read properties of null (reading 'useContext')]`. Error occurred prerendering page `/404`. Next.js build worker exited with code: 1. Reproduced twice (clean `.next` removed between runs) with identical failure signature both times, so this is not a flake. Root typecheck passes cleanly for all three workspaces. The unit test suite passes (1/1).",
].join("\n");

const OQ09_SIGNATURE = "Cannot read properties of null (reading 'useContext')";
const OQ09_EXPECTED_RAW = `- npm run build :: ${OQ09_SIGNATURE}`;

function loadThecoachStep(stepId: string): { input: string; expects: string } {
  const raw = fs.readFileSync(path.join(repoRoot, "workflows", "thecoach-dev", "workflow.yml"), "utf-8");
  const spec = YAML.parse(raw) as {
    steps: Array<{ id: string; input: string; expects: string }>;
  };
  const step = spec.steps.find((s) => s.id === stepId);
  assert.ok(step, `${stepId} step missing from thecoach-dev workflow.yml`);
  assert.equal(typeof step.input, "string");
  assert.equal(typeof step.expects, "string");
  return { input: step.input, expects: step.expects };
}

describe("parseExpectedFailures / formatExpectedFailuresForPrompt", () => {
  it("treats none, empty, and missing as no baseline", () => {
    assert.deepEqual(parseExpectedFailures(undefined), []);
    assert.deepEqual(parseExpectedFailures(""), []);
    assert.deepEqual(parseExpectedFailures("none"), []);
    assert.deepEqual(parseExpectedFailures("none — any non-zero exit is a task failure"), []);
    assert.equal(formatExpectedFailuresForPrompt([]), EXPECTED_FAILURES_NONE);
  });

  it("round-trips a command :: signature line", () => {
    const parsed = parseExpectedFailures(OQ09_EXPECTED_RAW);
    assert.deepEqual(parsed, [{ command: "npm run build", signature: OQ09_SIGNATURE }]);
    const formatted = formatExpectedFailuresForPrompt(parsed);
    assert.equal(formatted, `- \`npm run build\` :: \`${OQ09_SIGNATURE}\``);
    assert.deepEqual(parseExpectedFailures(formatted), parsed);
  });
});

describe("matchesExpectedFailureBaseline", () => {
  const expected = parseExpectedFailures(OQ09_EXPECTED_RAW);
  const failuresText = TASK_027_RUN19_TEST_OUTPUT.replace(/^STATUS: fail\nFAILURES: /, "");

  it("matches the run #19 OQ-09 build failure, including 'test suite passes' prose", () => {
    const result = matchesExpectedFailureBaseline({
      expected,
      failuresText,
      testCmd: "npm test",
      buildCmd: "npm run build",
    });
    assert.equal(result.matched, true, result.reason);
  });

  it("does not match when the signature changes shape", () => {
    const result = matchesExpectedFailureBaseline({
      expected,
      failuresText: failuresText.replace("useContext", "useState"),
      testCmd: "npm test",
      buildCmd: "npm run build",
    });
    assert.equal(result.matched, false);
    assert.ok(result.reason.includes("shape changed"));
  });

  it("does not match an undeclared test-suite failure alongside the expected build error", () => {
    const result = matchesExpectedFailureBaseline({
      expected,
      failuresText: `${failuresText} npm test failed: 3 failing.`,
      testCmd: "npm test",
      buildCmd: "npm run build",
    });
    assert.equal(result.matched, false);
    assert.equal(result.reason, "undeclared test-suite failure");
  });

  it("does not match when no baseline was declared", () => {
    const result = matchesExpectedFailureBaseline({
      expected: [],
      failuresText,
      testCmd: "npm test",
      buildCmd: "npm run build",
    });
    assert.equal(result.matched, false);
    assert.equal(result.reason, "no expected-failure baseline declared");
  });
});

describe("test step template cannot drift from expected-failures.ts", () => {
  it("templates {{expected_failures}} instead of a hand-copied baseline", () => {
    const { input } = loadThecoachStep("test");
    assert.ok(input.includes("{{expected_failures}}"));
    assert.equal(input.includes(OQ09_SIGNATURE), false);
    assert.ok(input.includes("expected/non-blocking"));
    assert.ok(input.includes("changed"));
  });

  it("setup requires a structured EXPECTED_FAILURES field", () => {
    const { input, expects } = loadThecoachStep("setup");
    assert.ok(input.includes("EXPECTED_FAILURES:"));
    assert.ok(expects.includes("EXPECTED_FAILURES:"));
    assert.ok(input.includes("::"));
  });

  it("a missing expected_failures context value is visible, not silently omitted", () => {
    const { input } = loadThecoachStep("test");
    const resolved = resolveTemplate(input, {
      repo: "/tmp/repo",
      branch: "feat",
      build_cmd: "npm run build",
      test_cmd: "npm test",
    });
    assert.ok(resolved.includes("[missing: expected_failures]"));
  });

  it("resolved test prompt includes the formatted OQ-09 baseline from the parser", () => {
    const { input } = loadThecoachStep("test");
    const expected = parseExpectedFailures(OQ09_EXPECTED_RAW);
    const resolved = resolveTemplate(input, {
      repo: "/tmp/repo",
      branch: "feat",
      build_cmd: "npm run build",
      test_cmd: "npm test",
      expected_failures: formatExpectedFailuresForPrompt(expected),
    });
    assert.equal(resolved.includes("[missing: expected_failures]"), false);
    assert.ok(resolved.includes(OQ09_SIGNATURE));
    assert.ok(resolved.includes("npm run build"));
    assert.ok(resolved.includes("STATUS: pass"));
  });
});

describe("completeStep test-step expected-failure baseline (run #19)", () => {
  const testRunIds: string[] = [];

  afterEach(() => {
    const db = getDb();
    for (const runId of testRunIds) {
      db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
    testRunIds.length = 0;
  });

  function insertTestRun(context: Record<string, string>): { runId: string; testStepId: string; nextStepId: string } {
    const db = getDb();
    const runId = randomUUID();
    const testStepId = randomUUID();
    const nextStepId = randomUUID();
    const now = new Date().toISOString();
    testRunIds.push(runId);
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'TASK-027', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify(context), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'test', ?, 'thecoach-dev_tester', 0, 'test', 'STATUS:', 'running', 2, ?, ?, 'single')`,
    ).run(testStepId, runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'browser-qa', ?, 'thecoach-dev_browser-qa', 1, 'test', 'STATUS:', 'waiting', 1, ?, ?, 'single')`,
    ).run(nextStepId, runId, now, now);
    return { runId, testStepId, nextStepId };
  }

  it("run #19 STATUS: fail matching OQ-09 baseline is non-blocking and advances", () => {
    const { testStepId, nextStepId } = insertTestRun({
      repo: "/tmp/repo",
      branch: "feat",
      build_cmd: "npm run build",
      test_cmd: "npm test",
      expected_failures: OQ09_EXPECTED_RAW,
    });

    const result = completeStep(testStepId, TASK_027_RUN19_TEST_OUTPUT);
    assert.equal(result.advanced, true);

    const db = getDb();
    const test = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(testStepId) as {
      status: string;
      output: string;
    };
    assert.equal(test.status, "done");
    assert.ok(test.output.includes("STATUS: fail"));
    assert.ok(test.output.includes(OQ09_SIGNATURE));

    const next = db.prepare("SELECT status FROM steps WHERE id = ?").get(nextStepId) as { status: string };
    assert.equal(next.status, "pending");
  });

  it("run #19 STATUS: fail without a declared baseline still fails the step", () => {
    const { testStepId, nextStepId } = insertTestRun({
      repo: "/tmp/repo",
      branch: "feat",
      build_cmd: "npm run build",
      test_cmd: "npm test",
    });

    const result = completeStep(testStepId, TASK_027_RUN19_TEST_OUTPUT);
    assert.equal(result.advanced, false);

    const db = getDb();
    const test = db.prepare("SELECT status FROM steps WHERE id = ?").get(testStepId) as { status: string };
    assert.notEqual(test.status, "done");
    const next = db.prepare("SELECT status FROM steps WHERE id = ?").get(nextStepId) as { status: string };
    assert.equal(next.status, "waiting");
  });

  it("run #19 STATUS: fail with a changed signature still fails the step", () => {
    const { testStepId } = insertTestRun({
      repo: "/tmp/repo",
      branch: "feat",
      build_cmd: "npm run build",
      test_cmd: "npm test",
      expected_failures: OQ09_EXPECTED_RAW,
    });

    const result = completeStep(
      testStepId,
      TASK_027_RUN19_TEST_OUTPUT.replace("useContext", "useState"),
    );
    assert.equal(result.advanced, false);

    const db = getDb();
    const test = db.prepare("SELECT status FROM steps WHERE id = ?").get(testStepId) as { status: string };
    assert.notEqual(test.status, "done");
  });

  it("claim injects none when setup omitted EXPECTED_FAILURES, so the key is never missing", () => {
    const db = getDb();
    const runId = randomUUID();
    const stepId = randomUUID();
    const agentId = `thecoach-dev_tester-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    testRunIds.push(runId);
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'TASK-027', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify({ repo: "/tmp/repo", branch: "feat", build_cmd: "npm run build", test_cmd: "npm test" }), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'test', ?, ?, 0, ?, 'STATUS:', 'pending', 2, ?, ?, 'single')`,
    ).run(stepId, runId, agentId, loadThecoachStep("test").input, now, now);

    const claimed = claimStep(agentId);
    assert.equal(claimed.found, true);
    assert.ok(claimed.resolvedInput);
    assert.equal(claimed.resolvedInput.includes("[missing: expected_failures]"), false);
    assert.ok(claimed.resolvedInput.includes(EXPECTED_FAILURES_NONE));
  });

  it("tester AGENTS.md mentions the expected-failures carve-out", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "workflows", "thecoach-dev", "agents", "tester", "AGENTS.md"),
      "utf-8",
    );
    assert.ok(content.includes("{{expected_failures}}"));
    assert.ok(content.includes("expected/non-blocking"));
  });
});
