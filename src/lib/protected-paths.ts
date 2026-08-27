/**
 * Protected paths the thecoach-dev verify gate must fail on.
 * Injected into plan/verify templates as {{protected_paths}} at claim time
 * (step-ops). Do not hand-copy this list into prompts — that drift is what
 * left the planner blind on TASK-037.
 */
export const PROTECTED_PATH_PATTERNS = [
  "_SSoT/**",
  "supabase/**",
  ".github/workflows/**",
  ".gitignore",
] as const;

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

export function isProtectedPath(file: string): boolean {
  const n = normalizePath(file);
  if (n === ".gitignore" || n.endsWith("/.gitignore")) return true;
  for (const pattern of PROTECTED_PATH_PATTERNS) {
    if (pattern.endsWith("/**") && matchesPrefixGlob(n, pattern)) return true;
  }
  return false;
}

export function findProtectedPaths(files: string[]): string[] {
  return files.filter(isProtectedPath);
}
