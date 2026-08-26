import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("/queue/check failed-run resolution", () => {
  it("self-test-pr-base-gate distinguishes failed runs from legitimate no-PR", () => {
    const result = spawnSync(
      process.execPath,
      ["local-tools/coordinator-trigger.mjs", "--self-test-pr-base-gate"],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, COORDINATOR_TOKEN: "x" },
        encoding: "utf-8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    const byCase = Object.fromEntries(parsed.gateCases.map((c) => [c.case, c]));
    assert.equal(byCase["failed-run-pr-waiting"].status, "failed");
    assert.equal(byCase["completed-run-pr-waiting-legitimate-no-pr"].status, "done");
    assert.notEqual(byCase["cancelled-run-pr-waiting"].status, "done");
    assert.deepEqual(parsed.errors, []);
  });
});
