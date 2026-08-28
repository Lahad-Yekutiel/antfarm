/**
 * Per-step skip_unless_diff_matches: skip an agent when the branch diff vs
 * staging matches none of the configured globs. Fail closed = run the agent
 * (key absent, or git/diff errors). A skip is never produced by an error path.
 */
import { execFileSync } from "node:child_process";
import { PROTECTED_PATH_DIFF_DEFAULT_BASE } from "./protected-paths.js";

const GIT_DIFF_TIMEOUT_MS = 10_000;

export const SKIP_UNLESS_DIFF_LOG_PREFIX = "skip_unless_diff_matches:";

export type SkipUnlessDecision = {
  skip: boolean;
  reason: "key_absent" | "git_error" | "matched" | "no_match";
  matchCount: number;
  files: string[];
  matched: string[];
  log: string;
  output?: string;
};

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Prefix-`/**` and exact-path matching — same semantics as protected-path globs. */
export function pathMatchesSkipPattern(file: string, pattern: string): boolean {
  const n = normalizePath(file);
  const p = normalizePath(pattern);
  if (p.endsWith("/**")) {
    const prefix = p.slice(0, -3);
    return n === prefix || n.startsWith(prefix + "/");
  }
  return n === p || n.endsWith("/" + p);
}

export function filesMatchingSkipPatterns(files: string[], patterns: string[]): string[] {
  return files.filter((file) => patterns.some((pattern) => pathMatchesSkipPattern(file, pattern)));
}

export function formatSkipUnlessOutput(files: string[]): string {
  const listed = files.length === 0 ? "<empty>" : files.join(", ");
  return `SKIPPED: no files in branch diff vs staging match skip_unless_diff_matches (diff: ${listed})`;
}

function logLine(rest: string): string {
  return `${SKIP_UNLESS_DIFF_LOG_PREFIX} ${rest}`;
}

/**
 * Pure decision. `patterns` null/undefined/empty → run (key absent).
 * `gitError` set → run. Empty or non-matching diff → skip.
 */
export function decideSkipUnlessDiffMatches(opts: {
  patterns: string[] | null | undefined;
  files?: string[] | null;
  gitError?: string | null;
}): SkipUnlessDecision {
  const patterns = opts.patterns;
  if (!patterns || patterns.length === 0) {
    return {
      skip: false,
      reason: "key_absent",
      matchCount: 0,
      files: [],
      matched: [],
      log: logLine("run (key absent) matchCount=0"),
    };
  }
  if (opts.gitError) {
    return {
      skip: false,
      reason: "git_error",
      matchCount: 0,
      files: [],
      matched: [],
      log: logLine(`run (git error: ${opts.gitError}) matchCount=0`),
    };
  }
  const files = opts.files ?? [];
  const matched = filesMatchingSkipPatterns(files, patterns);
  if (matched.length > 0) {
    return {
      skip: false,
      reason: "matched",
      matchCount: matched.length,
      files,
      matched,
      log: logLine(`run matchCount=${matched.length} files=${files.join(",")}`),
    };
  }
  return {
    skip: true,
    reason: "no_match",
    matchCount: 0,
    files,
    matched: [],
    log: logLine(`skipped matchCount=0 files=${files.length === 0 ? "<empty>" : files.join(",")}`),
    output: formatSkipUnlessOutput(files),
  };
}

export type BranchDiffResult = { files: string[] } | { error: string };

/**
 * `git diff --name-only staging...head` — same three-dot basis as the pr/merge
 * protected-path gate. Errors are returned, never thrown.
 */
export function listBranchDiffNames(
  repo: string,
  head: string,
  base: string = PROTECTED_PATH_DIFF_DEFAULT_BASE,
): BranchDiffResult {
  try {
    const output = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      cwd: repo,
      encoding: "utf-8",
      timeout: GIT_DIFF_TIMEOUT_MS,
    });
    const files = output
      .trim()
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    return { files };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: detail };
  }
}
