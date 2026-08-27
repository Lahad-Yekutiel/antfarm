import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  PROTECTED_PATH_PATTERNS,
  formatProtectedPathPatternsForPrompt,
} from "../src/lib/protected-paths.ts";
import { resolveTemplate } from "../dist/installer/step-ops.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Actual dispatched task text from antfarm run #25 (TASK-037,
 * queue item db00d4dd7230). Roadmap-auto-dispatch: scan-agent
 * title+description only. No inline "Protected — do not modify" list.
 * The planner still produced S2–S9 requiring supabase/migrations/**
 * because it never saw the host-enforced list.
 */
const TASK_037_RUN25_DISPATCHED_TEXT = `REPO: /home/lahad/trials/thecoach-antfarm-trial
BRANCH: feature/thecoach-dev-coordinator-db00d4dd7230

RLS defense-in-depth: column grants + policy-column indexes (TASK-037)

Add additive hardening on top of the existing row-level security policies: (1) column-level grants restricting direct table access to only the columns each role actually needs, and (2) indexes on the columns referenced by RLS policy predicates (policy-column indexes) across the RLS-protected tables (trainers, trainees, exercises, workouts, workout-exercise joins, trainee-assigned instances, form templates/responses, session history, weight history, favorites). This is purely additive — no existing RLS policy logic changes. Route to Claude Code per topics/TOOLING.md's routing rule (touches RLS/grants directly, security-boundary work). Full spec: topics/SECURITY.md decision 1.`;

/** ROADMAP.md:548-553 as cited in the 2026-08-27 handoff. Same shape. */
const TASK_037_ROADMAP_BULLET = `REPO: /home/lahad/trials/thecoach-antfarm-trial
BRANCH: feature/thecoach-dev-coordinator-db00d4dd7230

RLS defense-in-depth: column grants + policy-column indexes (TASK-037, added 2026-08-26): additive hardening on top of the existing row policies — no policy logic changes. Ready to dispatch now (Claude Code — touches RLS/grants directly per topics/TOOLING.md's routing). See topics/SECURITY.md decision 1.`;

function loadThecoachStepInput(stepId: string): string {
  const raw = fs.readFileSync(path.join(repoRoot, "workflows", "thecoach-dev", "workflow.yml"), "utf-8");
  const spec = YAML.parse(raw) as { steps: Array<{ id: string; input: string }> };
  const step = spec.steps.find((s) => s.id === stepId);
  assert.ok(step, `${stepId} step missing from thecoach-dev workflow.yml`);
  assert.equal(typeof step.input, "string");
  return step.input;
}

function resolvePlan(task: string): string {
  return resolveTemplate(loadThecoachStepInput("plan"), {
    task,
    protected_paths: formatProtectedPathPatternsForPrompt(),
  });
}

describe("formatProtectedPathPatternsForPrompt is not a stub", () => {
  it("is derived from PROTECTED_PATH_PATTERNS in source order", () => {
    const formatted = formatProtectedPathPatternsForPrompt();
    assert.equal(
      formatted,
      [...PROTECTED_PATH_PATTERNS].map((p) => `- \`${p}\``).join("\n"),
    );
    assert.ok(PROTECTED_PATH_PATTERNS.includes("supabase/**"));
  });
});

describe("plan step template cannot drift from protected-paths.ts", () => {
  it("references {{protected_paths}} instead of a hand-copied list", () => {
    const input = loadThecoachStepInput("plan");
    assert.ok(input.includes("{{protected_paths}}"), "plan input must template {{protected_paths}}");
    assert.ok(
      input.includes("Host-enforced list"),
      "plan input must tell the planner the host list is unconditional",
    );
    // The pre-fix instruction only checked the task-supplied list.
    assert.equal(
      input.includes('task\'s own "Protected — do not modify" list (if'),
      false,
      "old optional-only instruction must not remain",
    );
  });

  it("verify step also templates {{protected_paths}}", () => {
    const input = loadThecoachStepInput("verify");
    assert.ok(input.includes("{{protected_paths}}"));
    assert.equal(input.includes("- `_SSoT/**` (never writable by a Dev agent)"), false);
  });
});

describe("TASK-037 roadmap-auto shape: no inline list, migrations required", () => {
  for (const [label, task] of [
    ["run-25-dispatched-text", TASK_037_RUN25_DISPATCHED_TEXT],
    ["roadmap-bullet-548-553", TASK_037_ROADMAP_BULLET],
  ] as const) {
    it(`${label} has no inline Protected list and resolved plan prompt includes every host pattern plus STATUS: blocked`, () => {
      assert.equal(
        /protected\s*[—-]\s*do not modify/i.test(task),
        false,
        `${label} must not carry an inline protected list`,
      );
      const resolved = resolvePlan(task);
      assert.equal(resolved.includes("[missing: protected_paths]"), false, resolved.slice(0, 400));
      for (const pattern of PROTECTED_PATH_PATTERNS) {
        assert.ok(resolved.includes(pattern), `${label} missing ${pattern} in resolved plan prompt`);
      }
      assert.ok(resolved.includes("supabase/**"));
      assert.ok(resolved.includes("STATUS: blocked"));
      assert.ok(resolved.includes("TASK-037"));
      assert.ok(resolved.includes(task.split("\n")[0]));
    });
  }

  it("a missing protected_paths context value is visible, not silently omitted", () => {
    const resolved = resolveTemplate(loadThecoachStepInput("plan"), {
      task: TASK_037_RUN25_DISPATCHED_TEXT,
    });
    assert.ok(resolved.includes("[missing: protected_paths]"));
    assert.equal(resolved.includes("supabase/**"), false);
  });
});
