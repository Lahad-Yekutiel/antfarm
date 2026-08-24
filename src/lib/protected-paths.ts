/**
 * Protected paths the thecoach-dev verify gate must fail on.
 * Keep this list in sync with workflows/thecoach-dev/workflow.yml's verify step.
 */
export const PROTECTED_PATH_PATTERNS = [
  "_SSoT/**",
  "supabase/**",
  ".github/workflows/**",
  ".gitignore",
] as const;

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
