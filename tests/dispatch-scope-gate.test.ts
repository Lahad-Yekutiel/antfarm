import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTECTED_PATH_PATTERNS,
  findProtectedExpectedMatches,
} from "../dist/lib/protected-paths.js";
import {
  evaluateTaskScopeGate,
  maskManualDispatchRoadmap,
  parseDispatchFromMarkdown,
  parseExpectedFilePaths,
  SCOPE_GATE_SKIPPED_LOG,
} from "../dist/lib/task-dispatch-gate.js";

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixtureDir, name), "utf-8");
}

describe("dispatch scope gate A2 against real TASK fixtures", () => {
  it("TASK-033 is refused with ci.yml -> .github/**", () => {
    const gate = evaluateTaskScopeGate(readFixture("TASK-033-ci-typecheck-and-tests.md"));
    assert.equal(gate.skipped, false);
    assert.ok(
      gate.matches.some(
        (m) => m.path.includes(".github/workflows/ci.yml") && m.pattern === ".github/**",
      ),
      JSON.stringify(gate.matches),
    );
  });

  it("TASK-037 is refused with supabase migrations -> supabase/**", () => {
    const gate = evaluateTaskScopeGate(readFixture("TASK-037-rls-defense-in-depth.md"));
    assert.equal(gate.skipped, false);
    assert.ok(
      gate.matches.some(
        (m) => m.path.includes("supabase/migrations/") && m.path.includes("<timestamp>") && m.pattern === "supabase/**",
      ),
      JSON.stringify(gate.matches),
    );
  });

  it("TASK-038 is refused with workflows -> .github/**", () => {
    const gate = evaluateTaskScopeGate(readFixture("TASK-038-ci-dependency-secret-scanning.md"));
    assert.equal(gate.skipped, false);
    assert.ok(
      gate.matches.some((m) => m.pattern === ".github/**"),
      JSON.stringify(gate.matches),
    );
    assert.ok(
      gate.matches.some(
        (m) =>
          (m.path.includes(".github/workflows/ci.yml") || m.path.includes(".github/workflows/secret-scan.yml")) &&
          m.pattern === ".github/**",
      ),
      JSON.stringify(gate.matches),
    );
  });

  it("TASK-137 with ## Dispatch: manual parses as manual", () => {
    const parsed = parseDispatchFromMarkdown(readFixture("TASK-137-rls-defense-in-depth-manual.md"));
    assert.equal(parsed.dispatch, "manual");
    assert.equal(parsed.defaulted, false);
    const gate = evaluateTaskScopeGate(readFixture("TASK-137-rls-defense-in-depth-manual.md"));
    assert.equal(gate.skipped, false);
    assert.ok(gate.matches.length > 0);
  });

  it("apps-only expected files pass the gate", () => {
    const gate = evaluateTaskScopeGate(readFixture("TASK-040-apps-only.md"));
    assert.equal(gate.skipped, false);
    assert.deepEqual(gate.matches, []);
  });

  it("no Expected files section skips with the documented log line constant", () => {
    const gate = evaluateTaskScopeGate(readFixture("TASK-041-no-expected-files.md"));
    assert.equal(gate.skipped, true);
    assert.equal(gate.skipReason, "no expected-files");
    assert.equal(SCOPE_GATE_SKIPPED_LOG, "scope-gate: skipped (no expected-files)");
    assert.deepEqual(gate.matches, []);
  });

  it("unknown Dispatch values fail closed into manual", () => {
    const parsed = parseDispatchFromMarkdown("## Dispatch\nwhenever\n");
    assert.equal(parsed.dispatch, "manual");
    assert.equal(parsed.unknown, true);
  });

  it("absent Dispatch header defaults to auto", () => {
    const parsed = parseDispatchFromMarkdown(readFixture("TASK-033-ci-typecheck-and-tests.md"));
    assert.equal(parsed.dispatch, "auto");
    assert.equal(parsed.defaulted, true);
  });
});

describe("scope gate uses the live PROTECTED_PATH_PATTERNS export", () => {
  it("mutating the import changes the gate; a hardcoded copy would not", () => {
    const original = [...PROTECTED_PATH_PATTERNS];
    try {
      assert.deepEqual(findProtectedExpectedMatches(["apps/web/x.ts"]), []);
      const appsOnly = readFixture("TASK-040-apps-only.md");
      assert.deepEqual(evaluateTaskScopeGate(appsOnly).matches, []);

      PROTECTED_PATH_PATTERNS.push("apps/**");
      const hits = findProtectedExpectedMatches(["apps/web/x.ts"]);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].pattern, "apps/**");
      const gated = evaluateTaskScopeGate(appsOnly);
      assert.ok(
        gated.matches.some((m) => m.pattern === "apps/**"),
        JSON.stringify(gated.matches),
      );
    } finally {
      PROTECTED_PATH_PATTERNS.length = 0;
      for (const p of original) PROTECTED_PATH_PATTERNS.push(p);
    }
    assert.deepEqual(PROTECTED_PATH_PATTERNS, original);
  });

  it("coordinator-trigger.mjs does not contain a hand-copied pattern array", () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "local-tools", "coordinator-trigger.mjs"),
      "utf-8",
    );
    assert.equal(src.includes('"_SSoT/**"'), false);
    assert.equal(src.includes('"supabase/**"'), false);
    assert.ok(src.includes("from \"../dist/lib/protected-paths.js\""));
    assert.ok(src.includes("from \"../dist/lib/task-dispatch-gate.js\""));
  });
});

describe("maskManualDispatchRoadmap", () => {
  it("rewrites the open checkbox whose first TASK-NNN is manual", () => {
    const roadmap = [
      "- [ ] **CI (TASK-033)** do the yaml",
      "- [ ] **RLS (TASK-137)** grants",
      "- [ ] **Rate limit (TASK-040)** apps",
    ].join("\n");
    const masked = maskManualDispatchRoadmap(roadmap, (id) => (id === "TASK-137" ? "manual" : "auto"));
    assert.ok(masked.includes("- [ ] **CI (TASK-033)**"));
    assert.ok(masked.includes("- [x] **RLS (TASK-137)**"));
    assert.ok(masked.includes("- [ ] **Rate limit (TASK-040)**"));
  });
});

describe("parseExpectedFilePaths placeholders", () => {
  it("keeps <timestamp> in the declared path", () => {
    const parsed = parseExpectedFilePaths(readFixture("TASK-037-rls-defense-in-depth.md"));
    assert.ok(parsed.present);
    assert.ok(parsed.paths.some((p) => p.includes("<timestamp>") && p.startsWith("supabase/migrations/")));
  });
});
