import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Item 8 (auto-diagnose-and-retry), Item 7 (repeated empty diff), 8-P1 (the
 * silent ledger-blocked queue stall) and 8-P2 (the open-question ceiling).
 *
 * The mechanism lives in local-tools/coordinator-trigger.mjs, which binds a
 * port and reads real state files at import time, so it is exercised through
 * its own --self-test-auto-retry harness (every dependency injected: ledger,
 * queue, TODO writer, git diff, background queue, diagnosis agent, clock).
 * Same pattern as queue-check-failed-run.test.mjs.
 */
function runSelfTest() {
  const result = spawnSync(
    process.execPath,
    ["local-tools/coordinator-trigger.mjs", "--self-test-auto-retry"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, COORDINATOR_TOKEN: "x" },
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.ok(result.stdout, result.stderr || "(no stdout)");
  const parsed = JSON.parse(result.stdout);
  return { result, parsed, byCase: Object.fromEntries(parsed.cases.map((c) => [c.case, c])) };
}

describe("coordinator auto-diagnose-and-retry", () => {
  const { result, parsed, byCase } = runSelfTest();
  const ok = (label) => assert.equal(byCase[label]?.ok, true, JSON.stringify(byCase[label]));

  it("the whole harness passes", () => {
    assert.equal(result.status, 0, JSON.stringify(parsed.failures, null, 2));
    assert.equal(parsed.failed, 0, JSON.stringify(parsed.failures, null, 2));
    assert.ok(parsed.total >= 80, `only ${parsed.total} cases ran`);
  });

  it("caps retries at 2 (3 runs per queue item)", () => {
    assert.equal(parsed.config.autoRetryCap, 2);
  });

  it("1. a fixable failure retries with feedback and writes no TODO", () => {
    for (const c of ["1a-retry-pending", "1b-not-blocking", "1c-attempts-1", "1d-item-pushed",
      "1e-feedback", "1f-class-in-feedback", "1g-no-todo", "1h-agent-called", "1i-history"]) ok(c);
  });

  it("2. a transient failure retries as-is, with no feedback block and no agent turn", () => {
    for (const c of ["2a-retry-pending", "2b-transient-class", "2c-no-feedback", "2d-no-agent-turn", "2e-attempts-1"]) ok(c);
  });

  it("3. at the cap it parks with a task-scoped TODO naming the attempt count", () => {
    for (const c of ["3a-failed", "3b-blocking", "3c-cap-reached", "3d-no-retry", "3e-todo",
      "3f-todo-scoped", "3g-todo-summary-has-count", "3h-todo-summary-has-class"]) ok(c);
  });

  it("4. a structural failure parks immediately without spending an attempt", () => {
    for (const c of ["4a-failed", "4b-structural", "4c-attempts-0", "4d-no-retry", "4e-todo"]) ok(c);
  });

  it("5. a repeated diff digest is structural, decided without an agent turn", () => {
    for (const c of ["5a-structural", "5b-no-agent-turn", "5c-attempts-unchanged", "5d-failed"]) ok(c);
  });

  it("6. a protected-path gate hit is structural, decided without an agent turn", () => {
    for (const c of ["6a-structural", "6a-reason", "6b-no-agent-turn", "6c-attempts-0", "6d-todo"]) ok(c);
  });

  it("6e/f. git_failed / missing_context are transient, not a protected-path hit", () => {
    for (const c of [
      "6e-git-failed-transient", "6e-git-failed-reason", "6e-git-failed-retry",
      "6e-git-failed-no-agent", "6e-git-failed-not-parked",
      "6f-missing-context-transient", "6f-missing-context-retry",
      "6g-both-structural", "6g-both-reason", "6g-both-not-transient", "6g-both-parked",
      "6g-orig-structural", "6g-orig-reason",
    ]) ok(c);
  });

  it("7. a diagnosis agent that throws parks instead of retrying or stalling", () => {
    for (const c of ["7a-failed", "7b-diagnosis-unavailable", "7c-no-retry", "7d-todo", "7e-blocking"]) ok(c);
  });

  it("8. an unparseable diagnosis reply parks, and the parser is strict", () => {
    for (const c of ["8a-failed", "8b-diagnosis-unavailable", "8c-no-retry", "8d-parse-good",
      "8e-parse-extra-key", "8f-parse-bad-class", "8g-parse-guidance-required",
      "8h-parse-structural-empty-guidance"]) ok(c);
  });

  it("9. a diagnosis-pending key past its TTL is parked; a fresh one is left alone", () => {
    for (const c of ["9a-swept-stale", "9b-stale-parked", "9c-fresh-untouched", "9d-stale-todo", "9e-stale-blocking"]) ok(c);
    assert.equal(parsed.config.diagnosisTtlMs, 600000);
  });

  it("10. 8-P1: a ledger-blocked item is parked and the queue keeps going", () => {
    for (const c of ["10a-blocked-flagged", "10b-blocked-note", "10c-second-dispatched",
      "10d-startRun-called", "10e-response-dispatched", "10f-no-todo",
      "10g-flagged", "10h-reason", "10i-no-pending-left", "10j-idle-incremented"]) ok(c);
  });

  it("11. ledger-blocked counts as idle so the 12-cycle escalation can see it", () => {
    for (const c of ["11a-idle-counted", "11b-not-escalated-yet", "11c-escalates-at-12"]) ok(c);
  });

  it("12. 8-P2: only *-blocking TODOs count toward the ceiling", () => {
    for (const c of ["12a-open-count", "12b-global-count", "12c-scopes", "12d-star-present",
      "12e-many-scoped-below-ceiling", "12f-many-scoped-open-count", "12g-malformed-counts-global"]) ok(c);
  });

  it("17. Item 7: a repeated empty diff parks on attempt 2 without a run", () => {
    for (const c of ["17a-parked", "17b-note", "17c-ledger-failed", "17d-reason",
      "17e-attempt-not-spent", "17f-todo-scoped", "17g-queue-advanced", "17h-only-next-started"]) ok(c);
  });

  it("17b/c. a first empty diff, or one that could not be computed, still dispatches", () => {
    for (const c of ["17i-first-empty-dispatches", "17j-startRun-called", "17k-uncomputable-dispatches"]) ok(c);
  });

  it("a ## Dispatch: manual task never enters the retry cycle", () => {
    for (const c of ["jc7a-manual-skipped", "jc7b-no-ledger-entry", "jc7c-no-autoretry", "jc7d-no-startRun"]) ok(c);
  });

  it("retry feedback blocks replace, never stack", () => {
    for (const c of ["fb-single-block", "fb-new-guidance", "fb-old-guidance-gone", "fb-source"]) ok(c);
  });
});
