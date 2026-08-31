/**
 * Protected paths the thecoach-dev verify/pr/merge gates must fail on.
 * Injected into plan/verify templates as {{protected_paths}} at claim time
 * (step-ops). Do not hand-copy this list into prompts — that drift is what
 * left the planner blind on TASK-037. Dispatch-time scope matching also
 * reads this live export; never snapshot it.
 */
export const PROTECTED_PATH_PATTERNS = [
  "_SSoT/**",
  "supabase/**",
  // Widened from `.github/workflows/**` 2026-08-29: that pattern left
  // `.github/actions/**` (a composite action referenced from a protected
  // ci.yml), `.github/dependabot.yml` and `.github/CODEOWNERS` unguarded,
  // and every agent's gh token carries `workflow` scope. Enumerating the
  // known holes is the failure mode being fixed — the whole directory is
  // one pattern that also covers whatever GitHub adds next.
  ".github/**",
  // Agent self-modification surface: the root CLAUDE.md and .claude/
  // settings govern how agents in this repo behave. An agent editing them
  // rewrites its own rules.
  "CLAUDE.md",
  ".claude/**",
  ".gitignore",
];

/** Default `git diff A...B` base for the pr/merge full-branch check. */
export const PROTECTED_PATH_DIFF_DEFAULT_BASE = "staging";

export type ProtectedPathMatch = { path: string; pattern: string };

/** Prompt bullet list derived from PROTECTED_PATH_PATTERNS — never a second copy. */
export function formatProtectedPathPatternsForPrompt(): string {
  return PROTECTED_PATH_PATTERNS.map((pattern) => `- \`${pattern}\``).join("\n");
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchesPrefixGlob(file: string, glob: string): boolean {
  const prefix = glob.slice(0, -3); // strip /**
  return file === prefix || file.startsWith(prefix + "/");
}

/** `<timestamp>`-style placeholders become a single glob segment. */
export function normalizeExpectedPathPlaceholders(raw: string): string {
  return normalizePath(raw).replace(/<[^>]+>/g, "*");
}

function patternMatchesPath(file: string, pattern: string): boolean {
  const n = normalizePath(file);
  const p = normalizePath(pattern);
  if (p.endsWith("/**")) return matchesPrefixGlob(n, p);
  if (p === ".gitignore") return n === ".gitignore" || n.endsWith("/.gitignore");
  return n === p || n.endsWith("/" + p);
}

/** First matching live pattern, or null. Iterates PROTECTED_PATH_PATTERNS at call time. */
export function matchingProtectedPattern(file: string): string | null {
  const n = normalizeExpectedPathPlaceholders(file);
  for (const pattern of PROTECTED_PATH_PATTERNS) {
    if (patternMatchesPath(n, pattern)) return pattern;
  }
  return null;
}

export function isProtectedPath(file: string): boolean {
  return matchingProtectedPattern(file) !== null;
}

export function findProtectedPaths(files: string[]): string[] {
  return files.filter(isProtectedPath);
}

/**
 * Match declared expected-file paths against the live pattern list.
 * `path` in each hit is the original declared string (placeholders intact).
 */
export function findProtectedExpectedMatches(paths: string[]): ProtectedPathMatch[] {
  const matches: ProtectedPathMatch[] = [];
  for (const raw of paths) {
    const pattern = matchingProtectedPattern(raw);
    if (pattern) matches.push({ path: raw, pattern });
  }
  return matches;
}

/** Which required field is missing for the per-commit verify gate. */
export function missingProtectedDiffField(
  repo: string | undefined,
  commitSha: string | undefined,
): "repo" | "commit_sha" | null {
  if (typeof repo !== "string" || repo.trim() === "") return "repo";
  if (typeof commitSha !== "string" || commitSha.trim() === "") return "commit_sha";
  return null;
}

/**
 * Leading-token sentinels a story uses to say "this story produced no commit".
 *
 * Demonstrate-and-revert stories (TASK-027 S2: break a type, prove verify
 * catches it, `git restore`) legitimately end with nothing to commit, and the
 * developer contract has no other way to say so — run #38 reported
 * `COMMIT_SHA: none - no new commit was created for this step (...)`.
 *
 * LEADING TOKEN ONLY, deliberately mirroring GIT_SHA_LEADING_TOKEN_RE. Do NOT
 * relax this into a scan of the whole string, and do NOT add a companion scan
 * that lifts a hex SHA out of prose: that would let the gate diff a ref the
 * story never produced and report a confident wrong answer instead of a loud
 * failure. The sentinel set is disjoint from hex by construction (`n`, `o`,
 * `s`, `/`, `-` are not hex digits), so this can never shadow a real SHA.
 */
const NO_COMMIT_SENTINEL_RE = /^(none|nil|null|n\/?a|no[\s._-]*commit|no[\s._-]*new[\s._-]*commit)(?![a-z0-9])/i;

/**
 * True when COMMIT_SHA is absent/empty, or explicitly declares "no commit".
 * Callers use this only to tell a legitimate no-commit story apart from a
 * malformed field in logs — both route to the same branch-level fallback.
 */
export function isNoCommitSentinel(raw: string | undefined): boolean {
  if (typeof raw !== "string") return true;
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return NO_COMMIT_SENTINEL_RE.test(trimmed);
}
