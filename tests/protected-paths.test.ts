import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isProtectedPath,
  findProtectedPaths,
  missingProtectedDiffField,
  matchingProtectedPattern,
} from "../src/lib/protected-paths.ts";
import { getDb } from "../dist/db.js";
import {
  claimStep,
  completeStep,
  listProtectedDiffFiles,
  listProtectedDiffFilesChecked,
  sanitizeCommitShaForGitRef,
} from "../dist/installer/step-ops.js";

describe("isProtectedPath / findProtectedPaths", () => {
  it("still catches _SSoT/**", () => {
    assert.equal(isProtectedPath("_SSoT/CORE.md"), true);
    assert.equal(isProtectedPath("_SSoT/topics/TOOLING.md"), true);
  });

  it("catches supabase/** wholesale, including config.toml and seed.sql", () => {
    assert.equal(isProtectedPath("supabase/config.toml"), true);
    assert.equal(isProtectedPath("supabase/seed.sql"), true);
    assert.equal(isProtectedPath("supabase/migrations/001_init.sql"), true);
  });

  it("catches the whole of .github/** and .gitignore", () => {
    assert.equal(isProtectedPath(".github/workflows/ci.yml"), true);
    assert.equal(isProtectedPath(".github/workflows/anything.yml"), true);
    assert.equal(isProtectedPath(".gitignore"), true);
  });

  // Widened 2026-08-29: `.github/workflows/**` left a composite action, the
  // dependabot config and CODEOWNERS unguarded while every agent's gh token
  // carries `workflow` scope.
  it("closes the .github gaps the workflows-only pattern left open", () => {
    assert.equal(isProtectedPath(".github/actions/build/action.yml"), true);
    assert.equal(isProtectedPath(".github/dependabot.yml"), true);
    assert.equal(isProtectedPath(".github/CODEOWNERS"), true);
    assert.equal(isProtectedPath(".github/ISSUE_TEMPLATE/bug.md"), true);
    assert.equal(matchingProtectedPattern(".github/dependabot.yml"), ".github/**");
  });

  it("catches the agent self-modification surface: CLAUDE.md and .claude/**", () => {
    assert.equal(isProtectedPath("CLAUDE.md"), true);
    assert.equal(isProtectedPath("apps/web/CLAUDE.md"), true);
    assert.equal(isProtectedPath(".claude/settings.json"), true);
    assert.equal(isProtectedPath(".claude/agents/dev.md"), true);
    assert.equal(matchingProtectedPattern(".claude/settings.json"), ".claude/**");
    assert.equal(matchingProtectedPattern("CLAUDE.md"), "CLAUDE.md");
    // Not a false positive on ordinary docs that merely mention Claude
    assert.equal(isProtectedPath("docs/claude-notes.md"), false);
    assert.equal(isProtectedPath("apps/web/lib/claude.ts"), false);
  });

  it("does not catch ordinary application files", () => {
    assert.equal(isProtectedPath("apps/web/src/app/page.tsx"), false);
    assert.equal(isProtectedPath("README.md"), false);
    assert.deepEqual(
      findProtectedPaths(["apps/web/src/app/page.tsx", "supabase/config.toml", ".gitignore"]),
      ["supabase/config.toml", ".gitignore"],
    );
  });
});

describe("listProtectedDiffFiles + completeStep host-side gate", () => {
  const testRunIds: string[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    const db = getDb();
    for (const runId of testRunIds) {
      db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
    testRunIds.length = 0;
    for (const dir of dirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  }

  function makeRepoWithFile(relPath: string): { repo: string; sha: string } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-protected-"));
    dirs.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["checkout", "-b", "staging"]);
    fs.writeFileSync(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["checkout", "-b", "feat"]);
    const abs = path.join(repo, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "touched\n");
    git(repo, ["add", relPath]);
    git(repo, ["commit", "-m", "touch protected"]);
    return { repo, sha: git(repo, ["rev-parse", "HEAD"]) };
  }

  function insertVerifyRun(repo: string, sha: string): string {
    const db = getDb();
    const runId = randomUUID();
    const stepId = randomUUID();
    const now = new Date().toISOString();
    testRunIds.push(runId);
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'test task', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify({ repo, branch: "feat", commit_sha: sha }), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'verify', ?, 'thecoach-dev_verifier', 0, 'test', 'GATE: STATUS:', 'running', 1, ?, ?, 'single')`,
    ).run(stepId, runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'test', ?, 'thecoach-dev_tester', 1, 'test', 'STATUS:', 'waiting', 2, ?, ?, 'single')`,
    ).run(randomUUID(), runId, now, now);
    return stepId;
  }

  function insertImplementThenVerify(repo: string, verifierAgent: string): { runId: string; implementId: string } {
    const db = getDb();
    const runId = randomUUID();
    const implementId = randomUUID();
    const verifyId = randomUUID();
    const now = new Date().toISOString();
    testRunIds.push(runId);
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'test task', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify({ repo, branch: "feat" }), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'implement', ?, 'thecoach-dev_implementer', 0, 'test', 'STATUS: COMMIT_SHA:', 'running', 1, ?, ?, 'single')`,
    ).run(implementId, runId, now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'verify', ?, ?, 1, ?, 'GATE: STATUS:', 'waiting', 1, ?, ?, 'single')`,
    ).run(
      verifyId,
      runId,
      verifierAgent,
      "COMMIT: {{commit_sha}}\nRun: git -C {{repo}} diff --stat staging...{{commit_sha}}",
      now,
      now,
    );
    return { runId, implementId };
  }

  for (const rel of ["supabase/config.toml", ".github/workflows/anything.yml", ".gitignore", "_SSoT/CORE.md"]) {
    it(`host-side gate fails verify when GATE: pass but diff touches ${rel}`, () => {
      const { repo, sha } = makeRepoWithFile(rel);
      assert.deepEqual(listProtectedDiffFiles(repo, sha), [rel]);

      const stepDbId = insertVerifyRun(repo, sha);
      const result = completeStep(stepDbId, "GATE: pass\nSTATUS: pass");
      assert.equal(result.advanced, false);

      const db = getDb();
      const verify = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepDbId) as {
        status: string;
        output: string;
      };
      assert.notEqual(verify.status, "done");
      assert.ok(verify.output.includes(rel), `expected output to name ${rel}, got: ${verify.output}`);
    });
  }

  it("B1: missing repo fails verify with ENGINE_ERROR and ORIGINAL_OUTPUT", () => {
    const db = getDb();
    const runId = randomUUID();
    const stepId = randomUUID();
    const now = new Date().toISOString();
    testRunIds.push(runId);
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'test task', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify({ branch: "feat", commit_sha: "abc123" }), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'verify', ?, 'thecoach-dev_verifier', 0, 'test', 'GATE: STATUS:', 'running', 0, ?, ?, 'single')`,
    ).run(stepId, runId, now, now);
    const agentOutput = "GATE: pass\nSTATUS: pass";
    const result = completeStep(stepId, agentOutput);
    assert.equal(result.advanced, false);
    const verify = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as {
      status: string;
      output: string;
    };
    assert.equal(verify.status, "failed");
    assert.ok(verify.output.includes("ENGINE_ERROR: protected_path_gate_missing_context: repo"));
    assert.ok(verify.output.includes("ORIGINAL_OUTPUT:"));
    assert.ok(verify.output.includes(agentOutput));
    assert.equal(missingProtectedDiffField(undefined, "abc"), "repo");
  });

  it("B1: missing commit_sha fails verify with ENGINE_ERROR and ORIGINAL_OUTPUT", () => {
    const db = getDb();
    const runId = randomUUID();
    const stepId = randomUUID();
    const now = new Date().toISOString();
    testRunIds.push(runId);
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'test task', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify({ repo: "/tmp/does-not-matter", branch: "feat" }), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'verify', ?, 'thecoach-dev_verifier', 0, 'test', 'GATE: STATUS:', 'running', 0, ?, ?, 'single')`,
    ).run(stepId, runId, now, now);
    const agentOutput = "GATE: pass\nSTATUS: pass";
    const result = completeStep(stepId, agentOutput);
    assert.equal(result.advanced, false);
    const verify = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepId) as {
      status: string;
      output: string;
    };
    assert.equal(verify.status, "failed");
    assert.ok(verify.output.includes("ENGINE_ERROR: protected_path_gate_missing_context: commit_sha"));
    assert.ok(verify.output.includes("ORIGINAL_OUTPUT:"));
    assert.ok(verify.output.includes(agentOutput));
    assert.equal(missingProtectedDiffField("/tmp/repo", ""), "commit_sha");
  });

  // Until 2026-08-29 this returned a bare [] when both base refs failed,
  // which every caller read as "no violations" — a missing staging/main ref
  // or an unavailable git silently PASSED the story-level gate while the
  // branch-level twin failed closed on the same condition.
  it("B0: a diff that never ran is not 'no violations' — the gate fails closed", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-nodiff-"));
    dirs.push(repo);
    // A directory that is not a git repo at all: both `staging...` and
    // `main...` invocations throw.
    const checked = listProtectedDiffFilesChecked(repo, "deadbeef");
    assert.equal(checked.ran, false);
    assert.deepEqual(checked.hits, []);
    assert.ok(checked.ran === false && checked.error.length > 0, JSON.stringify(checked));
    // The legacy hits-only wrapper still returns [] — that is exactly why
    // gate paths must use the checked variant.
    assert.deepEqual(listProtectedDiffFiles(repo, "deadbeef"), []);
  });

  it("B0b: a real repo with a clean diff reports ran:true and no hits", () => {
    const { repo, sha } = makeRepoWithFile("apps/web/page.tsx");
    const checked = listProtectedDiffFilesChecked(repo, sha);
    assert.equal(checked.ran, true);
    assert.deepEqual(checked.hits, []);
  });

  // TASK-025 #34: implementer wrote commentary after the SHA. Exact fixture
  // from the Failure Checks 2026-08-30 diagnosis.
  const TASK025_COMMIT_SHA_FIXTURE =
    "c511270 (with parent 02c1b86 also part of this story's changes; both commits on branch feature/promote-design-preview implement Story S1 in full)";

  it("sanitizes the TASK-025 COMMIT_SHA fixture to the leading bare SHA", () => {
    const resolved = sanitizeCommitShaForGitRef(TASK025_COMMIT_SHA_FIXTURE);
    assert.equal(resolved.sha, "c511270");
    assert.equal(resolved.truncated, true);
    assert.deepEqual(sanitizeCommitShaForGitRef("c511270"), { sha: "c511270", truncated: false });
    assert.deepEqual(sanitizeCommitShaForGitRef("not a sha at all"), { sha: null, truncated: false });
    assert.deepEqual(sanitizeCommitShaForGitRef(""), { sha: null, truncated: false });
    assert.deepEqual(sanitizeCommitShaForGitRef("HEAD"), { sha: null, truncated: false });
    assert.deepEqual(sanitizeCommitShaForGitRef("deadbeef-tag"), { sha: null, truncated: false });
    assert.deepEqual(sanitizeCommitShaForGitRef("deadbeef/x"), { sha: null, truncated: false });
    assert.deepEqual(sanitizeCommitShaForGitRef("deadbeef_x"), { sha: null, truncated: false });
    assert.deepEqual(sanitizeCommitShaForGitRef("a".repeat(41)), { sha: null, truncated: false });
    assert.deepEqual(sanitizeCommitShaForGitRef("a" + "b".repeat(43)), { sha: null, truncated: false });
    assert.equal(sanitizeCommitShaForGitRef("c511270, plus 02c1b86").sha, "c511270");
    assert.equal(sanitizeCommitShaForGitRef("c511270. see also").sha, "c511270");
    assert.equal(sanitizeCommitShaForGitRef("c511270)").sha, "c511270");
    assert.equal(sanitizeCommitShaForGitRef("c511270(with parent)").sha, "c511270");
    assert.equal(sanitizeCommitShaForGitRef("c511270; note").sha, "c511270");
  });

  it("TASK-025: trailing commentary on COMMIT_SHA still lets the protected-path gate run (no git_failed)", () => {
    const { repo, sha } = makeRepoWithFile("apps/web/page.tsx");
    const commentary = TASK025_COMMIT_SHA_FIXTURE.slice("c511270".length);
    const dirty = `${sha}${commentary}`;
    const checked = listProtectedDiffFilesChecked(repo, dirty);
    assert.equal(checked.ran, true, JSON.stringify(checked));
    assert.deepEqual(checked.hits, []);

    const stepDbId = insertVerifyRun(repo, dirty);
    const result = completeStep(stepDbId, "GATE: pass\nSTATUS: pass");
    assert.equal(result.advanced, true);
    const db = getDb();
    const verify = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepDbId) as {
      status: string;
      output: string | null;
    };
    assert.equal(verify.status, "done");
    assert.equal((verify.output || "").includes("protected_path_gate_git_failed"), false);
  });

  it("TASK-025: dirty COMMIT_SHA is stored as a bare SHA so the verifier prompt is a valid git ref", () => {
    const { repo, sha } = makeRepoWithFile("apps/web/page.tsx");
    const dirty = `${sha}${TASK025_COMMIT_SHA_FIXTURE.slice("c511270".length)}`;
    const verifierAgent = `thecoach-dev_verifier-${randomUUID().slice(0, 8)}`;
    const { runId, implementId } = insertImplementThenVerify(repo, verifierAgent);

    const result = completeStep(implementId, `STATUS: done\nCOMMIT_SHA: ${dirty}`);
    assert.equal(result.advanced, true);

    const db = getDb();
    const ctx = JSON.parse((db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string }).context) as Record<string, string>;
    assert.equal(ctx.commit_sha, sha.toLowerCase());
    assert.equal(ctx.commit_sha_raw, dirty);
    assert.equal(ctx.commit_sha.includes("with parent"), false);

    const claimed = claimStep(verifierAgent);
    assert.equal(claimed.found, true);
    assert.ok(claimed.resolvedInput?.includes(`COMMIT: ${sha.toLowerCase()}`), claimed.resolvedInput);
    assert.ok(claimed.resolvedInput?.includes(`staging...${sha.toLowerCase()}`), claimed.resolvedInput);
    assert.equal(claimed.resolvedInput?.includes("with parent"), false, claimed.resolvedInput);
  });

  it("a protected-path hit still fires when COMMIT_SHA has trailing commentary", () => {
    const { repo, sha } = makeRepoWithFile("supabase/config.toml");
    const dirty = `${sha}${TASK025_COMMIT_SHA_FIXTURE.slice("c511270".length)}`;
    const stepDbId = insertVerifyRun(repo, dirty);
    const result = completeStep(stepDbId, "GATE: pass\nSTATUS: pass");
    assert.equal(result.advanced, false);
    const db = getDb();
    const verify = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepDbId) as {
      status: string;
      output: string;
    };
    assert.notEqual(verify.status, "done");
    assert.ok(verify.output.includes("Protected-path gate: diff touches supabase/config.toml"), verify.output);
    assert.equal(verify.output.includes("protected_path_gate_git_failed"), false);
  });

  it("a COMMIT_SHA with no hex token is missing context, not git_failed", () => {
    const { repo } = makeRepoWithFile("apps/web/page.tsx");
    const stepDbId = insertVerifyRun(repo, "not a git object name");
    const agentOutput = "GATE: pass\nSTATUS: pass";
    const result = completeStep(stepDbId, agentOutput);
    assert.equal(result.advanced, false);
    const db = getDb();
    const verify = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepDbId) as {
      status: string;
      output: string;
    };
    // insertVerifyRun uses max_retries=1, so the first fail is pending, not terminal failed.
    assert.notEqual(verify.status, "done");
    assert.ok(verify.output.includes("ENGINE_ERROR: protected_path_gate_missing_context: commit_sha"), verify.output);
    assert.equal(verify.output.includes("protected_path_gate_git_failed"), false);
  });

  it("B1: both present and a clean apps-only diff passes verify", () => {
    const { repo, sha } = makeRepoWithFile("apps/web/page.tsx");
    assert.deepEqual(listProtectedDiffFiles(repo, sha), []);
    const stepDbId = insertVerifyRun(repo, sha);
    const result = completeStep(stepDbId, "GATE: pass\nSTATUS: pass");
    assert.equal(result.advanced, true);
    const db = getDb();
    const verify = db.prepare("SELECT status FROM steps WHERE id = ?").get(stepDbId) as { status: string };
    assert.equal(verify.status, "done");
  });

  function makeThreeCommitRepo(): { repo: string; branch: string } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-protected-branch-"));
    dirs.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["checkout", "-b", "staging"]);
    fs.writeFileSync(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["checkout", "-b", "feat"]);
    const protectedFile = path.join(repo, "supabase", "migrations", "001.sql");
    fs.mkdirSync(path.dirname(protectedFile), { recursive: true });
    fs.writeFileSync(protectedFile, "create table t (id int);\n");
    git(repo, ["add", "supabase/migrations/001.sql"]);
    git(repo, ["commit", "-m", "commit 1 protected"]);
    fs.mkdirSync(path.join(repo, "apps", "web"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps", "web", "a.ts"), "a\n");
    git(repo, ["add", "apps/web/a.ts"]);
    git(repo, ["commit", "-m", "commit 2 apps"]);
    fs.writeFileSync(path.join(repo, "apps", "web", "b.ts"), "b\n");
    git(repo, ["add", "apps/web/b.ts"]);
    git(repo, ["commit", "-m", "commit 3 apps"]);
    return { repo, branch: "feat" };
  }

  function insertNamedStep(repo: string, branch: string, stepId: string, status: string, maxRetries: number): string {
    const db = getDb();
    const runId = randomUUID();
    const stepDbId = randomUUID();
    const now = new Date().toISOString();
    testRunIds.push(runId);
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'test task', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify({ repo, branch }), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, ?, ?, ?, 0, 'test', 'STATUS:', ?, ?, ?, ?, 'single')`,
    ).run(stepDbId, stepId, runId, `thecoach-dev_${stepId}`, status, maxRetries, now, now);
    return stepDbId;
  }

  it("B2: a protected file added in commit 1 of 3, untouched after, is caught at pr", () => {
    const { repo, branch } = makeThreeCommitRepo();
    const stepDbId = insertNamedStep(repo, branch, "pr", "running", 0);
    const result = completeStep(stepDbId, "STATUS: done\nPR_URL: https://github.com/o/r/pull/1");
    assert.equal(result.advanced, false);
    const db = getDb();
    const pr = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepDbId) as {
      status: string;
      output: string;
    };
    assert.equal(pr.status, "failed");
    assert.ok(pr.output.includes("supabase/migrations/001.sql"), pr.output);
  });

  it("B2: merge claim fails before the agent receives a prompt (pre-gh-pr-merge)", () => {
    const { repo, branch } = makeThreeCommitRepo();
    const agentId = `thecoach-dev_merge-${randomUUID().slice(0, 8)}`;
    const db = getDb();
    const runId = randomUUID();
    const stepDbId = randomUUID();
    const now = new Date().toISOString();
    testRunIds.push(runId);
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'test task', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify({ repo, branch }), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'merge', ?, ?, 0, 'gh pr merge {{pr_url}}', 'STATUS:', 'pending', 0, ?, ?, 'single')`,
    ).run(stepDbId, runId, agentId, now, now);

    const claimed = claimStep(agentId);
    assert.equal(claimed.found, false, "merge must not be handed to an agent when the branch diff is dirty");
    const merge = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(stepDbId) as {
      status: string;
      output: string;
    };
    assert.equal(merge.status, "failed");
    assert.ok(merge.output.includes("supabase/migrations/001.sql"), merge.output);
  });
});
