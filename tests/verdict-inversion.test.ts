/**
 * TASK-040: gate-recovery verdict inversion.
 *
 * cec1ac8 taught the parser to recover a KEY: written mid-line. Correct for
 * COMMIT_SHA:, wrong for GATE:/STATUS:, because fail_when compared the
 * recovered value by exact whole-value equality: a recovered
 * `fail (reason: ...)` is not the literal string `fail`, so the deny-list
 * never fired and the step advanced as if the gate had passed.
 *
 * Fixtures are run #18's own verifier reply, byte-for-byte out of
 * /home/lahad/.openclaw/agents/thecoach-dev_verifier/sessions/
 * 1ffe1ec7-7d24-4ed0-b4dd-50638a929a60.jsonl line 36
 * (ts 2026-08-25T17:51:52.803Z, 2399 bytes), with two documented edits:
 *   - em dashes replaced with "-" so the fixtures are pure ASCII;
 *   - run-18-verify-output-gate-fail.txt additionally flips that reply's
 *     single mid-line `GATE: pass (...)` to `GATE: fail (reason: ...)`,
 *     which is the exact shape the TASK-026 diagnosis predicted would be
 *     silently passed.
 * run-18-verify-output.txt is otherwise unmodified.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  classifyVerdictValue,
  findContradictingVerdict,
  keysForMidlineRecovery,
  matchOutputFailure,
  parseOutputKeyValues,
  resolveFailWhen,
} from "../dist/installer/step-ops.js";
import { getStepFailWhen } from "../dist/installer/workflow-spec.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name: string) =>
  fs.readFileSync(path.join(repoRoot, "tests", "fixtures", name), "utf-8");

const VERIFY_EXPECTS = "GATE: STATUS:";
const verifyFailWhen = () => getStepFailWhen("thecoach-dev", "verify");

describe("verdict inversion: mid-line GATE: fail must not pass the gate", () => {
  it("requirement 1: run #18 shaped reply with a mid-line GATE: fail is caught", () => {
    const output = fixture("run-18-verify-output-gate-fail.txt");

    // Preconditions: GATE is genuinely mid-line, and its recovered value is
    // NOT the bare literal "fail" that the old exact-equality check needed.
    assert.equal(/^GATE:/m.test(output), false, "GATE must not be line-anchored here");
    assert.equal(output.includes("GATE: fail (reason:"), true);

    const parsed = parseOutputKeyValues(output, keysForMidlineRecovery(VERIFY_EXPECTS));
    assert.equal(parsed.status, "done", "line-anchored boilerplate status");
    assert.notEqual(parsed.gate, "fail", "recovered gate carries its reason text");
    assert.equal(parsed.gate.startsWith("fail (reason: commit under review"), true);

    const failure = matchOutputFailure(parsed, verifyFailWhen(), output);
    assert.notEqual(failure, null, "a mid-line GATE: fail must fail the step");
    assert.equal(failure!.key, "gate");
    assert.equal(failure!.value.startsWith("fail (reason:"), true);
    assert.equal(failure!.reason, 'verdict is "fail"');
  });

  it("requirement 3: a clean GATE: pass / STATUS: pass still advances", () => {
    const failWhen = verifyFailWhen();
    const clean = "GATE: pass\nSTATUS: pass\nCHANGES: reviewed the diff\nTESTS: none run\n";
    const parsed = parseOutputKeyValues(clean, keysForMidlineRecovery(VERIFY_EXPECTS));
    assert.deepEqual({ gate: parsed.gate, status: parsed.status }, { gate: "pass", status: "pass" });
    assert.equal(matchOutputFailure(parsed, failWhen, clean), null);

    // And a pass whose reason rides on the same line is still a pass.
    assert.deepEqual(
      classifyVerdictValue("pass (689f6df itself touches no protected paths).", ["fail"]),
      { verdict: "pass" },
    );
    assert.deepEqual(classifyVerdictValue("done - all six stories landed", failWhen.status), {
      verdict: "pass",
    });
  });

  it("run #18's real reply: mid-line GATE: pass is a pass, but its mid-line STATUS: fail is not", () => {
    const output = fixture("run-18-verify-output.txt");
    const failWhen = verifyFailWhen();
    const parsed = parseOutputKeyValues(output, keysForMidlineRecovery(VERIFY_EXPECTS));

    assert.equal(parsed.status, "done");
    assert.equal(parsed.gate, "pass (689f6df itself touches no protected paths).");

    // No false fail from the parenthetical gate reason.
    assert.deepEqual(classifyVerdictValue(parsed.gate, failWhen.gate), { verdict: "pass" });

    // The verifier's real verdict sits mid-line inside CHANGES; `status` was
    // already line-anchored to the boilerplate `done`, so recovery skipped it
    // and the parsed values alone read as a clean pass.
    assert.equal(output.includes("STATUS: fail - commit under review"), true);
    assert.equal(matchOutputFailure(parsed, failWhen), null, "parsed values alone look clean");

    // Scanning the reply body catches the contradiction.
    const failure = matchOutputFailure(parsed, failWhen, output);
    assert.notEqual(failure, null, "a failing verdict anywhere in the reply must fail the step");
    assert.equal(failure!.key, "status");
    assert.equal(failure!.value.startsWith("fail - commit under review"), true);
  });

  it("the body scan is fail-only: a clean reply body adds no failure", () => {
    const effective = resolveFailWhen(verifyFailWhen());
    const clean = "GATE: pass\nSTATUS: pass\nCHANGES: nothing protected was touched\n";
    assert.equal(findContradictingVerdict(clean, effective), null);
  });

  it("edge case: an ambiguous multi-word verdict refuses to advance and says why", () => {
    const ambiguous = classifyVerdictValue("mostly ok, see notes below", ["fail"]);
    assert.equal(ambiguous.verdict, "fail");
    assert.equal(
      (ambiguous as { reason: string }).reason,
      'verdict "mostly" is neither a recognized pass nor a clean fail - refusing to advance',
    );
  });

  it("a failing word anywhere on the verdict line fails, punctuation and case included", () => {
    const statusFailures = ["fail", "blocked", "failed", "error"];
    const cases: Array<[string, string[]]> = [
      ["fail", ["fail"]],
      ["FAIL", ["fail"]],
      ["fail.", ["fail"]],
      ["(fail)", ["fail"]],
      ["fail (reason: gate cannot run)", ["fail"]],
      ["pass, but the protected-path gate is blocked", statusFailures],
      ["blocked - supabase/config.toml is protected", statusFailures],
    ];
    for (const [value, failures] of cases) {
      assert.equal(classifyVerdictValue(value, failures).verdict, "fail", value);
    }
  });

  it("a verdict whose reason lands on continuation lines is still failed", () => {
    const output = "STATUS: fail\nthe migration did not apply\nCHANGES: none\n";
    const parsed = parseOutputKeyValues(output, keysForMidlineRecovery("STATUS:"));
    assert.equal(parsed.status, "fail\nthe migration did not apply");
    const failure = matchOutputFailure(parsed, undefined, output);
    assert.deepEqual(
      { key: failure!.key, value: failure!.value },
      { key: "status", value: "fail" },
    );
  });

  it("single-token verdicts outside the deny-list still advance (STATUS: retry)", () => {
    assert.deepEqual(classifyVerdictValue("retry", ["fail", "blocked", "failed", "error"]), {
      verdict: "pass",
    });
    assert.equal(matchOutputFailure({ status: "retry" }, undefined, "STATUS: retry\n"), null);
  });

  it("edge case: gate and status are the only keys any workflow checks with fail_when", () => {
    const keys = new Set<string>();
    for (const dir of fs.readdirSync(path.join(repoRoot, "workflows"))) {
      const file = path.join(repoRoot, "workflows", dir, "workflow.yml");
      if (!fs.existsSync(file)) continue;
      const spec = YAML.parse(fs.readFileSync(file, "utf-8")) as {
        steps?: Array<{ fail_when?: Record<string, string[]> }>;
      };
      for (const step of spec.steps ?? []) {
        for (const key of Object.keys(step.fail_when ?? {})) keys.add(key.toLowerCase());
      }
    }
    keys.add("status"); // DEFAULT_FAIL_WHEN applies to every step
    assert.deepEqual([...keys].sort(), ["gate", "status"]);
  });
});
