import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../dist/db.js";
import { claimStep } from "../dist/installer/step-ops.js";
import {
  decideSkipUnlessDiffMatches,
  formatSkipUnlessOutput,
  listBranchDiffNames,
  pathMatchesSkipPattern,
  SKIP_UNLESS_DIFF_LOG_PREFIX,
} from "../dist/lib/skip-unless-diff.js";

const WEB_PATTERNS = ["apps/web/**", "package.json", "package-lock.json"];

describe("decideSkipUnlessDiffMatches (pure)", () => {
  it("key absent → agent runs", () => {
    const d = decideSkipUnlessDiffMatches({ patterns: undefined, files: [] });
    assert.equal(d.skip, false);
    assert.equal(d.reason, "key_absent");
    assert.ok(d.log.startsWith(SKIP_UNLESS_DIFF_LOG_PREFIX));
    assert.ok(d.log.includes("key absent"));
  });

  it("empty patterns → agent runs (same as absent)", () => {
    const d = decideSkipUnlessDiffMatches({ patterns: [], files: [] });
    assert.equal(d.skip, false);
    assert.equal(d.reason, "key_absent");
  });

  it("empty diff → skipped", () => {
    const d = decideSkipUnlessDiffMatches({ patterns: WEB_PATTERNS, files: [] });
    assert.equal(d.skip, true);
    assert.equal(d.reason, "no_match");
    assert.equal(d.matchCount, 0);
    assert.equal(d.output, formatSkipUnlessOutput([]));
    assert.ok(d.output?.includes("diff: <empty>"));
    assert.ok(d.log.includes("skipped"));
  });

  it("matching diff → agent runs", () => {
    const d = decideSkipUnlessDiffMatches({
      patterns: WEB_PATTERNS,
      files: ["apps/web/app/page.tsx", "README.md"],
    });
    assert.equal(d.skip, false);
    assert.equal(d.reason, "matched");
    assert.equal(d.matchCount, 1);
    assert.deepEqual(d.matched, ["apps/web/app/page.tsx"]);
    assert.ok(d.log.includes("run matchCount=1"));
  });

  it("package.json at repo root matches", () => {
    const d = decideSkipUnlessDiffMatches({
      patterns: WEB_PATTERNS,
      files: ["package.json"],
    });
    assert.equal(d.skip, false);
    assert.equal(d.reason, "matched");
  });

  it("non-matching non-empty diff → skipped", () => {
    const d = decideSkipUnlessDiffMatches({
      patterns: WEB_PATTERNS,
      files: ["tools/delegate-to-claude.ps1", "README.md"],
    });
    assert.equal(d.skip, true);
    assert.equal(d.reason, "no_match");
    assert.ok(d.output?.includes("tools/delegate-to-claude.ps1"));
  });

  it("git error → agent runs (never skip on error)", () => {
    const d = decideSkipUnlessDiffMatches({
      patterns: WEB_PATTERNS,
      files: [],
      gitError: "spawn git ENOENT",
    });
    assert.equal(d.skip, false);
    assert.equal(d.reason, "git_error");
    assert.ok(d.log.includes("git error"));
  });

  it("pathMatchesSkipPattern covers prefix and exact", () => {
    assert.equal(pathMatchesSkipPattern("apps/web/app/page.tsx", "apps/web/**"), true);
    assert.equal(pathMatchesSkipPattern("apps/web", "apps/web/**"), true);
    assert.equal(pathMatchesSkipPattern("apps/mobile/x.tsx", "apps/web/**"), false);
    assert.equal(pathMatchesSkipPattern("package.json", "package.json"), true);
    assert.equal(pathMatchesSkipPattern("apps/web/package.json", "package.json"), true);
  });
});

describe("claimStep skip_unless_diff_matches", () => {
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

  function makeRepo(changedRel: string | null): { repo: string; branch: string } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-skip-diff-"));
    dirs.push(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["checkout", "-b", "staging"]);
    fs.writeFileSync(path.join(repo, "README.md"), "base\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "base"]);
    git(repo, ["checkout", "-b", "feat"]);
    if (changedRel) {
      const abs = path.join(repo, changedRel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "touched\n");
      git(repo, ["add", changedRel]);
      git(repo, ["commit", "-m", "change"]);
    } else {
      git(repo, ["commit", "--allow-empty", "-m", "empty vs staging"]);
    }
    return { repo, branch: "feat" };
  }

  function insertBrowserQaRun(
    context: Record<string, string>,
    opts: { stepId?: string; agentId?: string } = {},
  ): { runId: string; qaId: string; prId: string } {
    const db = getDb();
    const runId = randomUUID();
    const qaId = randomUUID();
    const prId = randomUUID();
    const now = new Date().toISOString();
    testRunIds.push(runId);
    const stepId = opts.stepId ?? "browser-qa";
    const agentId = opts.agentId ?? "thecoach-dev_browser-qa";
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', 'test task', 'running', ?, ?, ?)`,
    ).run(runId, JSON.stringify(context), now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, ?, ?, ?, 0, 'QA {{repo}}', 'STATUS:', 'pending', 1, ?, ?, 'single')`,
    ).run(qaId, stepId, runId, agentId, now, now);
    db.prepare(
      `INSERT INTO steps (id, step_id, run_id, agent_id, step_index, input_template, expects, status, max_retries, created_at, updated_at, type)
       VALUES (?, 'pr', ?, 'thecoach-dev_pr', 1, 'open pr', 'STATUS:', 'waiting', 2, ?, ?, 'single')`,
    ).run(prId, runId, now, now);
    return { runId, qaId, prId };
  }

  it("empty diff → skipped, pr becomes pending, agent not invoked", () => {
    const { repo, branch } = makeRepo(null);
    const listed = listBranchDiffNames(repo, branch);
    assert.ok("files" in listed);
    assert.deepEqual(listed.files, []);

    const { qaId, prId } = insertBrowserQaRun({ repo, branch });
    const claimed = claimStep("thecoach-dev_browser-qa");
    assert.equal(claimed.found, false);

    const db = getDb();
    const qa = db.prepare("SELECT status, output, failure_cause FROM steps WHERE id = ?").get(qaId) as {
      status: string;
      output: string;
      failure_cause: string | null;
    };
    assert.equal(qa.status, "skipped");
    assert.equal(qa.failure_cause, null);
    assert.ok(qa.output.includes("SKIPPED:"));
    assert.ok(qa.output.includes("diff: <empty>"));

    const pr = db.prepare("SELECT status FROM steps WHERE id = ?").get(prId) as { status: string };
    assert.equal(pr.status, "pending");
  });

  it("matching diff → agent runs", () => {
    const { repo, branch } = makeRepo("apps/web/app/page.tsx");
    const { qaId, prId } = insertBrowserQaRun({ repo, branch });
    const claimed = claimStep("thecoach-dev_browser-qa");
    assert.equal(claimed.found, true);
    assert.ok(claimed.resolvedInput?.includes(repo));

    const db = getDb();
    const qa = db.prepare("SELECT status FROM steps WHERE id = ?").get(qaId) as { status: string };
    assert.equal(qa.status, "running");
    const pr = db.prepare("SELECT status FROM steps WHERE id = ?").get(prId) as { status: string };
    assert.equal(pr.status, "waiting");
  });

  it("non-matching non-empty diff → skipped", () => {
    const { repo, branch } = makeRepo("tools/delegate-to-claude.ps1");
    const { qaId } = insertBrowserQaRun({ repo, branch });
    const claimed = claimStep("thecoach-dev_browser-qa");
    assert.equal(claimed.found, false);
    const db = getDb();
    const qa = db.prepare("SELECT status, output FROM steps WHERE id = ?").get(qaId) as {
      status: string;
      output: string;
    };
    assert.equal(qa.status, "skipped");
    assert.ok(qa.output.includes("tools/delegate-to-claude.ps1"));
  });

  it("git error → agent runs", () => {
    const { qaId } = insertBrowserQaRun({ repo: "/nonexistent/antfarm-skip-repo", branch: "feat" });
    const claimed = claimStep("thecoach-dev_browser-qa");
    assert.equal(claimed.found, true);
    const db = getDb();
    const qa = db.prepare("SELECT status FROM steps WHERE id = ?").get(qaId) as { status: string };
    assert.equal(qa.status, "running");
  });

  it("key absent → agent runs even on empty diff", () => {
    const { repo, branch } = makeRepo(null);
    const { qaId } = insertBrowserQaRun(
      { repo, branch },
      { stepId: "test", agentId: "thecoach-dev_tester" },
    );
    const claimed = claimStep("thecoach-dev_tester");
    assert.equal(claimed.found, true);
    const db = getDb();
    const qa = db.prepare("SELECT status FROM steps WHERE id = ?").get(qaId) as { status: string };
    assert.equal(qa.status, "running");
  });
});
