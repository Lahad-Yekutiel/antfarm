/**
 * Run #45 (TASK-027, 2026-09-01) was parked "structural" on the OQ-09 /404
 * prerender failure — 42 minutes AFTER the fix for it, d88b6fd, had merged to
 * origin/staging. Two independent gaps in the `setup` step let that happen:
 *
 *  1. `setup` said only `git checkout -b {{branch}}`. On a redispatch the
 *     branch already exists, so that fails, and setup accepted the existing
 *     branch as-is. Its own report: "branch fix/root-verification-entrypoints
 *     already existed cleanly, cut from staging ancestor 36cc650" — a base
 *     from 2026-08-30, two days before the fix. The `test` step then hit the
 *     bug d88b6fd had already removed and it looked like the task's fault.
 *
 *  2. Nothing in the workflow ever installed dependencies. d88b6fd is a
 *     dependency-hoisting change ("Hoist React 19 to root so styled-jsx
 *     resolves apps/web's React"), which cannot take effect against a
 *     node_modules tree left over from a previous run.
 *
 * Verified 2026-09-05 in the trial clone, fresh `npm ci` in a detached
 * worktree both times:
 *   origin/staging 1ce4769 (contains d88b6fd) -> `npm run build` exit 0, zero
 *     "exiting the build" signatures.
 *   fix/root-verification-entrypoints 391f811 (stale base) -> exit 1, the
 *     exact "Export encountered an error on /_error: /404" signature.
 *
 * So the collision really is gone on a current base, and really does persist
 * on a stale one. These assertions keep both halves of the fix in the step
 * contract. They check the instructions, which is all the harness can check
 * without running a live workflow.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf-8");

const SETUP_PROMPT_SOURCES = [
  "workflows/thecoach-dev/agents/setup/AGENTS.md",
  "workflows/thecoach-dev/agents/setup/variants/cursor-delegated/AGENTS.md",
  "workflows/thecoach-dev/agents/setup/variants/claude-only/AGENTS.md",
];

function setupStepPrompt(): string {
  const spec = YAML.parse(read("workflows/thecoach-dev/workflow.yml")) as {
    steps: Array<{ id: string; input_template?: string }>;
  };
  const setup = spec.steps.find((s) => s.id === "setup");
  assert.ok(setup, "thecoach-dev workflow has no `setup` step");
  // The template is hard-wrapped, so a phrase can straddle a newline. Collapse
  // all whitespace before matching rather than asserting on the wrapping.
  return Object.values(setup).join("\n").replace(/\s+/g, " ");
}

describe("thecoach-dev setup: a redispatch must not build on a stale base", () => {
  it("workflow.yml's setup step handles an already-existing branch", () => {
    const prompt = setupStepPrompt();
    assert.match(prompt, /already exists/i, "no branch-exists path");
    assert.match(prompt, /git merge\s+--no-edit\s+staging/, "does not merge current staging in");
    assert.ok(
      /never delete or force-recreate the branch/i.test(prompt),
      "must not tell the agent to recreate the branch — prior commits are real work (TASK-048)",
    );
  });

  it("workflow.yml's setup step verifies the base is current before continuing", () => {
    const prompt = setupStepPrompt();
    assert.match(
      prompt,
      /git merge-base --is-ancestor staging \{\{branch\}\}/,
      "no staging-ancestor check on the branch",
    );
    assert.match(prompt, /stale base/i);
  });

  it("workflow.yml's setup step installs dependencies from the lockfile", () => {
    assert.match(setupStepPrompt(), /npm ci/, "no npm ci — a dependency fix on staging cannot take effect");
  });

  for (const source of SETUP_PROMPT_SOURCES) {
    it(`${source} carries the same branch-exists and npm ci contract`, () => {
      const content = read(source);
      assert.match(content, /already exists/i, "no branch-exists path");
      assert.match(content, /git merge\s+--no-edit\s+staging/, "does not merge current staging in");
      assert.match(content, /npm ci/, "no npm ci step");
    });
  }

  it("the two non-delegating sources also make a stale base a blocker", () => {
    // The cursor-delegated variant hands the git work to Cursor and does its
    // own independent verification in the shared AGENTS.md step 3, so the
    // ancestor check lives there, not in the delegation prompt itself.
    for (const source of [
      "workflows/thecoach-dev/agents/setup/AGENTS.md",
      "workflows/thecoach-dev/agents/setup/variants/claude-only/AGENTS.md",
    ]) {
      const content = read(source);
      assert.match(
        content,
        /git merge-base --is-ancestor staging \{\{branch\}\}/,
        `${source}: no staging-ancestor check`,
      );
      assert.match(content, /STATUS: blocked/, `${source}: stale base is not a blocker`);
    }
  });
});
