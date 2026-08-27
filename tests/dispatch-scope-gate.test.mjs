import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("dispatch-time A1/A2 spawnPendingQueueItem", () => {
  it("refuses 033/038 on protected-path-scope and 137 quietly as manual", () => {
    const result = spawnSync(
      process.execPath,
      ["local-tools/coordinator-trigger.mjs", "--self-test-dispatch-scope-gate"],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, COORDINATOR_TOKEN: "x" },
        encoding: "utf-8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.failures, []);
    const byCase = Object.fromEntries(parsed.cases.map((c) => [c.case, c]));
    assert.equal(byCase["033-reason"].ok, true);
    assert.equal(byCase["033-match-ci-yml"].ok, true);
    assert.equal(byCase["033-ledger-failed"].ok, true);
    assert.equal(byCase["038-reason"].ok, true);
    assert.equal(byCase["manual-reason"].ok, true);
    assert.equal(byCase["manual-no-todo"].ok, true);
    assert.equal(byCase["manual-no-ledger"].ok, true);
    assert.equal(byCase["apps-dispatched"].ok, true);
    assert.equal(byCase["skip-log"].ok, true);
  });
});
