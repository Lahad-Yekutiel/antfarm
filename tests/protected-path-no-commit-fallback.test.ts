import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDb } from "../dist/db.js";
import { completeStep } from "../dist/installer/step-ops.js";
import { findProtectedPaths, isNoCommitSentinel } from "../dist/lib/protected-paths.js";

/**
 * D1 + C1 — the protected-path story gate must not die on a story that
 * legitimately produces no commit.
 *
 * TASK-027 story S2 ("demonstrate verify fails fast on a broken type, then
 * revert cleanly") ends with a clean tree and nothing to commit. Run #38
 * reported `COMMIT_SHA: none - no new commit was created for this step (...)`,
 * the gate could not turn that into a git ref, and the step died with
 * `ENGINE_ERROR: protected_path_gate_missing_context: commit_sha` even though
 * its own verdict was `GATE: pass / STATUS: pass`. Retrying reproduced it
 * exactly, so no story of that shape could ever complete.
 *
 * D1 falls back to the branch-level diff (base...branch) that already gates
 * pr/merge. That diff is a strict SUPERSET of the story's own commit, so this
 * is a fallback and never a skip: a real protected-path hit anywhere on the
 * branch is still caught, which is what the negative-control test below pins.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function makeRepo(branchFiles: string[]): { repo: string; sha: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-d1-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8", env: GIT_ENV });
  git(["init", "-q", "-b", "staging"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-qb", "feat-x"]);
  for (const rel of branchFiles) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x\n");
  }
  git(["add", "-A"]);
  git(["commit", "-qm", "story"]);
  return { repo, sha: git(["rev-parse", "HEAD"]).trim() };
}

/** The verbatim shape run #38 wrote into runs.context.commit_sha. */
const RUN_38_COMMIT_SHA =
  "none - no new commit was created for this step (working tree has zero diff " +
  "after the demonstration+revert; HEAD remains " +
  "2ec95a055b49f5d9ee02495c60abe3a97e9d0734 from the prior S1 story commit)";

const VERIFY_PASS_OUTPUT = "GATE: pass\nSTATUS: pass\nSTATUS_REASON: n/a";

describe("D1/C1 protected-path gate: story with no commit", () => {
  const runIds: string[] = [];

  afterEach(() => {
    const db = getDb();
    for (const runId of runIds) {
      db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
    runIds.length = 0;
  });

  function insertVerifyRun(context: Record<string, string>): { runId: string; verifyId: string } {
    const db = getDb();
    const runId = randomUUID();
    const verifyId = randomUUID();
    const now = new Date().toISOString();
    runIds.push(runId);
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'd1 test', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify(context), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type, loop_config, current_story_id)
       VALUES (?, 'verify', ?, 'thecoach-dev_verifier', 0, 'in', 'GATE: STATUS:', 'running', 0, ?, ?, 'single', NULL, NULL)`,
    ).run(verifyId, runId, now, now);
    return { runId, verifyId };
  }

  function verifyStep(verifyId: string): { status: string; output: string } {
    const db = getDb();
    return db
      .prepare("SELECT status, COALESCE(output, '') AS output FROM steps WHERE id = ?")
      .get(verifyId) as { status: string; output: string };
  }

  it("D1: a no-commit story on a CLEAN branch now passes the gate", () => {
    const { repo } = makeRepo(["apps/web/CONTRIBUTING.md", "package.json"]);
    const { verifyId } = insertVerifyRun({
      repo,
      branch: "feat-x",
      commit_sha: RUN_38_COMMIT_SHA,
    });

    completeStep(verifyId, VERIFY_PASS_OUTPUT);

    const step = verifyStep(verifyId);
    assert.ok(
      !step.output.includes("protected_path_gate_missing_context"),
      `still died on missing context: ${step.output}`,
    );
    assert.ok(
      !step.output.includes("Protected-path gate: diff touches"),
      `clean branch reported a hit: ${step.output}`,
    );
    assert.notEqual(step.status, "failed");
  });

  it("D1 negative control: a no-commit story whose BRANCH touches a protected path still fails closed", () => {
    const { repo } = makeRepo(["supabase/migrations/fake.sql", "apps/web/ok.ts"]);
    const { verifyId } = insertVerifyRun({
      repo,
      branch: "feat-x",
      commit_sha: RUN_38_COMMIT_SHA,
    });

    completeStep(verifyId, VERIFY_PASS_OUTPUT);

    const step = verifyStep(verifyId);
    assert.equal(step.status, "failed");
    assert.ok(
      step.output.includes("Protected-path gate: diff touches supabase/migrations/fake.sql"),
      `expected a real hit, got: ${step.output}`,
    );
    // Reported as a HIT, not as the old missing-context error: the coordinator
    // classifies those differently and the operator message differs.
    assert.ok(!step.output.includes("protected_path_gate_missing_context"));
  });

  it("D1 fails CLOSED when there is no usable commit AND no branch — nothing to diff", () => {
    const { repo } = makeRepo(["apps/web/ok.ts"]);
    const { verifyId } = insertVerifyRun({ repo, commit_sha: RUN_38_COMMIT_SHA });

    completeStep(verifyId, VERIFY_PASS_OUTPUT);

    const step = verifyStep(verifyId);
    assert.equal(step.status, "failed");
    assert.ok(step.output.includes("ENGINE_ERROR: protected_path_gate_missing_context: commit_sha"));
  });

  it("D1 does not weaken the repo requirement", () => {
    const { verifyId } = insertVerifyRun({ branch: "feat-x", commit_sha: RUN_38_COMMIT_SHA });

    completeStep(verifyId, VERIFY_PASS_OUTPUT);

    const step = verifyStep(verifyId);
    assert.equal(step.status, "failed");
    assert.ok(step.output.includes("ENGINE_ERROR: protected_path_gate_missing_context: repo"));
  });

  it("regression: a real SHA still takes the per-commit path and still passes", () => {
    const { repo, sha } = makeRepo(["apps/web/ok.ts"]);
    const { verifyId } = insertVerifyRun({ repo, branch: "feat-x", commit_sha: sha });

    completeStep(verifyId, VERIFY_PASS_OUTPUT);

    const step = verifyStep(verifyId);
    assert.notEqual(step.status, "failed");
    assert.ok(!step.output.includes("ENGINE_ERROR"));
  });

  it("regression: a real SHA whose own commit touches a protected path still fails", () => {
    const { repo, sha } = makeRepo(["_SSoT/fake.md"]);
    const { verifyId } = insertVerifyRun({ repo, branch: "feat-x", commit_sha: sha });

    completeStep(verifyId, VERIFY_PASS_OUTPUT);

    const step = verifyStep(verifyId);
    assert.equal(step.status, "failed");
    assert.ok(step.output.includes("Protected-path gate: diff touches _SSoT/fake.md"));
  });
});

describe("C1 no-commit sentinels (leading token only)", () => {
  it("recognises the shapes a story actually writes", () => {
    for (const raw of [
      undefined,
      "",
      "   ",
      "none",
      "None",
      "NONE",
      "n/a",
      "N/A",
      "na",
      "nil",
      "null",
      "no commit",
      "no-commit",
      "no new commit",
      RUN_38_COMMIT_SHA,
    ]) {
      assert.equal(isNoCommitSentinel(raw), true, `expected sentinel: ${String(raw)}`);
    }
  });

  it("never claims a real SHA is a sentinel", () => {
    for (const raw of [
      "2ec95a055b49f5d9ee02495c60abe3a97e9d0734",
      "c511270",
      "c511270 (with parent abc1234)",
      "deadbeef",
      "abc1234,",
    ]) {
      assert.equal(isNoCommitSentinel(raw), false, `wrongly treated as sentinel: ${raw}`);
    }
  });

  it("does not fire on a word that merely starts with a sentinel", () => {
    for (const raw of ["nonexistent", "nonetheless", "nullify", "nilpotent"]) {
      assert.equal(isNoCommitSentinel(raw), false, `over-matched: ${raw}`);
    }
  });

  it("is disjoint from hex by construction — no sentinel can shadow a real ref", () => {
    for (const raw of ["none", "nil", "null", "n/a", "no commit"]) {
      assert.equal(/^[0-9a-f]{7,40}$/i.test(raw.replace(/\s/g, "")), false, raw);
    }
  });
});

describe("positive/negative control on the live protected-path matcher", () => {
  it("run #38's real branch diff has no protected-path hits", () => {
    assert.deepEqual(findProtectedPaths(["apps/web/CONTRIBUTING.md", "package.json"]), []);
  });

  it("a diff that touches protected paths is still caught", () => {
    assert.deepEqual(
      findProtectedPaths([
        "apps/web/CONTRIBUTING.md",
        "supabase/migrations/fake.sql",
        "_SSoT/fake.md",
        ".github/workflows/ci.yml",
        "CLAUDE.md",
        ".gitignore",
      ]),
      [
        "supabase/migrations/fake.sql",
        "_SSoT/fake.md",
        ".github/workflows/ci.yml",
        "CLAUDE.md",
        ".gitignore",
      ],
    );
  });
});
