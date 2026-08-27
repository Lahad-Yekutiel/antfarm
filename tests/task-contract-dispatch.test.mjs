import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("dispatch honours task-file ## Branch and ## Tool/model", () => {
  it("TASK-027 uses its Branch name; TASK-029 is refused as Claude Code", () => {
    const result = spawnSync(
      process.execPath,
      ["local-tools/coordinator-trigger.mjs", "--self-test-task-contract"],
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
    assert.equal(byCase["027-branch"].ok, true);
    assert.equal(byCase["027-dispatched"].ok, true);
    assert.equal(byCase["027-branch-literal"].ok, true);
    assert.equal(byCase["027-not-hardcoded"].ok, true);
    assert.equal(byCase["029-tool"].ok, true);
    assert.equal(byCase["029-not-dispatched"].ok, true);
    assert.equal(byCase["029-field-tool"].ok, true);
    assert.equal(byCase["029-value-claude"].ok, true);
    assert.equal(byCase["029-startRun-never"].ok, true);
    assert.equal(byCase["029-todo-summary-names-field"].ok, true);
    assert.equal(byCase["adhoc-hardcoded-branch"].ok, true);
  });
});
