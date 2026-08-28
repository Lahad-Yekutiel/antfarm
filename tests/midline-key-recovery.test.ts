/**
 * Mid-line expected-key recovery (run #27 COMMIT_SHA buried at the end of TESTS:).
 * Generalizes b900bd2's leading nested-GATE recovery to every eligible key.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  keysForMidlineRecovery,
  parseExpectsKeys,
  parseOutputKeyValues,
  recoverMidLineExpectedKeys,
  resolveTemplate,
  WELL_KNOWN_OUTPUT_KEYS,
} from "../dist/installer/step-ops.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN27_FIXTURE = path.join(repoRoot, "tests", "fixtures", "run-27-implement-output.txt");

describe("mid-line expected-key recovery", () => {
  it("thecoach-dev implement expects STATUS and COMMIT_SHA", () => {
    const raw = fs.readFileSync(path.join(repoRoot, "workflows", "thecoach-dev", "workflow.yml"), "utf-8");
    const spec = YAML.parse(raw) as { steps: Array<{ id: string; expects: string }> };
    const implement = spec.steps.find((s) => s.id === "implement");
    assert.ok(implement, "implement step missing");
    assert.deepEqual(parseExpectsKeys(implement.expects), ["status", "commit_sha"]);
  });

  it("run #27 implement fixture extracts commit_sha 9e98c16", () => {
    const output = fs.readFileSync(RUN27_FIXTURE, "utf-8");
    assert.equal(output.includes("COMMIT_SHA: 9e98c16"), true);
    assert.equal(/^COMMIT_SHA:/m.test(output), false, "COMMIT_SHA must not be line-anchored in this fixture");

    const withoutRecovery = parseOutputKeyValues(output);
    assert.equal(withoutRecovery.commit_sha, undefined);
    assert.ok(withoutRecovery.tests?.includes("COMMIT_SHA: 9e98c16"));

    const parsed = parseOutputKeyValues(output, keysForMidlineRecovery("STATUS:"));
    assert.equal(parsed.commit_sha, "9e98c16");
    assert.equal(parsed.status, "done");

    const rendered = resolveTemplate(
      "COMMIT: {{commit_sha}}\n`git -C {{repo}} show {{commit_sha}}`",
      { ...parsed, repo: "/tmp/repo" },
    );
    assert.equal(rendered.includes("[missing: commit_sha]"), false);
    assert.equal(rendered.includes("COMMIT: 9e98c16"), true);
    assert.equal(rendered.includes("git -C /tmp/repo show 9e98c16"), true);
  });

  it("recovers a mid-line variant for every well-known key", () => {
    const cases: Array<{ key: string; output: string; value: string }> = [
      { key: "status", output: "prefix text STATUS: done", value: "done" },
      { key: "gate", output: "CHANGES: touched files GATE: pass", value: "pass" },
      { key: "changes", output: "STATUS: done extra CHANGES: touched foo.ts", value: "touched foo.ts" },
      { key: "tests", output: "STATUS: done extra TESTS: 2 passed", value: "2 passed" },
      { key: "commit_sha", output: "TESTS: both passed. COMMIT_SHA: 9e98c16", value: "9e98c16" },
      { key: "expected_failures", output: "STATUS: done extra EXPECTED_FAILURES: none", value: "none" },
      { key: "test_result", output: "CHANGES: files extra TEST_RESULT: npm test exit 0", value: "npm test exit 0" },
    ];
    assert.deepEqual(
      cases.map((c) => c.key).sort(),
      [...WELL_KNOWN_OUTPUT_KEYS].sort(),
    );
    for (const { key, output, value } of cases) {
      const parsed = parseOutputKeyValues(output, keysForMidlineRecovery());
      assert.equal(parsed[key], value, `mid-line ${key} should recover`);
    }
  });

  it("does not recover prose that is not an eligible key (EROFS / buried TEST_CMD)", () => {
    const output = [
      "STATUS: done",
      "BASELINE: mkdir failed with EROFS: read-only file system",
      "INTEGRATION_RESULT: setup ran TEST_CMD: none found",
    ].join("\n");
    const parsed = parseOutputKeyValues(output, keysForMidlineRecovery("STATUS:"));
    assert.equal(parsed.status, "done");
    assert.equal(parsed.erofs, undefined);
    assert.equal(parsed.test_cmd, undefined);
    assert.ok(parsed.baseline?.includes("EROFS: read-only file system"));
    assert.ok(parsed.integration_result?.includes("TEST_CMD: none found"));
  });

  it("recoverMidLineExpectedKeys reports which keys were recovered", () => {
    const parsed: Record<string, string> = { status: "done", tests: "passed. COMMIT_SHA: abcdef1" };
    const recovered = recoverMidLineExpectedKeys(
      "STATUS: done\nTESTS: passed. COMMIT_SHA: abcdef1",
      parsed,
      ["status", "commit_sha"],
    );
    assert.deepEqual(recovered, ["commit_sha"]);
    assert.equal(parsed.commit_sha, "abcdef1");
  });
});
