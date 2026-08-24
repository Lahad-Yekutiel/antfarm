import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProtectedPath, findProtectedPaths } from "../src/lib/protected-paths.ts";
import { getDb } from "../dist/db.js";
import { completeStep, listProtectedDiffFiles } from "../dist/installer/step-ops.js";

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

  it("catches .github/workflows/** and .gitignore", () => {
    assert.equal(isProtectedPath(".github/workflows/ci.yml"), true);
    assert.equal(isProtectedPath(".github/workflows/anything.yml"), true);
    assert.equal(isProtectedPath(".gitignore"), true);
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
});
