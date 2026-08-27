/**
 * Host-side dispatch gates derived from a TASK-NNN markdown file.
 * Pattern matching always goes through protected-paths.ts — never a copy.
 */
import {
  findProtectedExpectedMatches,
  type ProtectedPathMatch,
} from "./protected-paths.js";

export type DispatchMode = "auto" | "manual";

export const SCOPE_GATE_SKIPPED_LOG = "scope-gate: skipped (no expected-files)";

const TASK_ID_RE = /TASK-(\d+)/i;
const OPEN_CHECKBOX_LINE_RE = /^\s*-\s*\[\s*\]/;

function firstNonEmptyLine(text: string): string {
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function extractMarkdownSection(markdown: string, headingRe: RegExp): string | null {
  const lines = String(markdown || "").split(/\r?\n/);
  let start = -1;
  let headingLine = "";
  for (let i = 0; i < lines.length; i += 1) {
    if (headingRe.test(lines[i])) {
      start = i + 1;
      headingLine = lines[i];
      break;
    }
  }
  if (start < 0) return null;
  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const restOfHeading = headingLine.replace(/^##\s+Dispatch\b/i, "").replace(/^[:\s-]+/, "").trim();
  if (restOfHeading && headingRe.source.includes("Dispatch")) {
    return [restOfHeading, ...body].join("\n").trim();
  }
  return body.join("\n").trim();
}

function extractHashSubSection(section: string, headingRe: RegExp): string {
  const lines = String(section || "").split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^###\s+/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

export function parseDispatchHeader(sectionText: string | null | undefined): {
  dispatch: DispatchMode;
  defaulted: boolean;
  unknown: boolean;
  value?: string;
} {
  if (sectionText == null || !String(sectionText).trim()) {
    return { dispatch: "auto", defaulted: true, unknown: false };
  }
  const first = firstNonEmptyLine(String(sectionText)).replace(/[`*_]/g, " ").replace(/\s+/g, " ").trim();
  const token = (first.split(/\s+/)[0] || "").toLowerCase().replace(/[^a-z]/g, "");
  if (token === "auto") return { dispatch: "auto", defaulted: false, unknown: false, value: first };
  if (token === "manual") return { dispatch: "manual", defaulted: false, unknown: false, value: first };
  return { dispatch: "manual", defaulted: false, unknown: true, value: first.slice(0, 80) };
}

export function parseDispatchFromMarkdown(markdown: string): {
  dispatch: DispatchMode;
  defaulted: boolean;
  unknown: boolean;
  value?: string;
} {
  const heading = String(markdown || "").split(/\r?\n/).find((line) => /^##\s+Dispatch\b/i.test(line));
  if (!heading) return parseDispatchHeader(null);
  return parseDispatchHeader(extractMarkdownSection(markdown, /^##\s+Dispatch\b/i));
}

function looksLikePath(s: string): boolean {
  if (!s || /\s/.test(s)) return false;
  if (s.includes("/")) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(s)) return true;
  return false;
}

function splitBullets(body: string): string[] {
  const lines = String(body || "").split(/\r?\n/);
  const bullets: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) bullets.push(current.join("\n"));
    current = [];
  };
  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      flush();
      current.push(line.replace(/^\s*-\s+/, ""));
    } else if (current.length) {
      current.push(line);
    }
  }
  flush();
  return bullets;
}

function extractPathsFromExpectedBody(body: string): string[] {
  if (!body.trim()) return [];
  const paths: string[] = [];
  for (const bullet of splitBullets(body)) {
    const ticks = [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    const pathLike = ticks.filter(looksLikePath);
    const workflowDir = pathLike.find((p) => p.startsWith(".github/workflows/"));
    for (const p of pathLike) {
      if (!p.includes("/") && /\.(ya?ml)$/i.test(p) && workflowDir) {
        paths.push(`.github/workflows/${p}`);
      } else {
        paths.push(p);
      }
    }
  }
  return paths;
}

export function parseExpectedFilePaths(markdown: string): { present: boolean; paths: string[] } {
  const section = extractMarkdownSection(markdown, /^##\s+Expected files\b/i);
  if (section == null) return { present: false, paths: [] };
  const created = extractHashSubSection(section, /^###\s+Likely created\b/i);
  const modified = extractHashSubSection(section, /^###\s+Likely modified\b/i);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const p of [...extractPathsFromExpectedBody(created), ...extractPathsFromExpectedBody(modified)]) {
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }
  return { present: true, paths };
}

export function evaluateTaskScopeGate(markdown: string): {
  skipped: boolean;
  skipReason?: string;
  matches: ProtectedPathMatch[];
} {
  const parsed = parseExpectedFilePaths(markdown);
  if (!parsed.present) {
    return { skipped: true, skipReason: "no expected-files", matches: [] };
  }
  return { skipped: false, matches: findProtectedExpectedMatches(parsed.paths) };
}

function extractFirstTaskId(text: string): string | null {
  const m = String(text || "").match(TASK_ID_RE);
  if (!m) return null;
  return `TASK-${m[1].padStart(3, "0")}`;
}

/**
 * Rewrite open ROADMAP checkboxes whose task file is `## Dispatch: manual`
 * to `[x]`, so the scan agent never sees them as candidates.
 */
export function maskManualDispatchRoadmap(
  roadmap: string,
  dispatchForTaskId: (taskId: string) => DispatchMode,
): string {
  const lines = String(roadmap || "").split("\n");
  const out = lines.slice();
  let i = 0;
  while (i < lines.length) {
    if (!OPEN_CHECKBOX_LINE_RE.test(lines[i])) {
      i += 1;
      continue;
    }
    const start = i;
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*-\s*\[/.test(line)) break;
      if (/^#{1,6}\s/.test(line)) break;
      if (line.trim() === "") break;
      i += 1;
    }
    const itemText = lines.slice(start, i).join("\n");
    const taskId = extractFirstTaskId(itemText);
    if (taskId && dispatchForTaskId(taskId) === "manual") {
      out[start] = lines[start].replace(/^(\s*-\s*)\[\s*\]/, "$1[x]");
    }
  }
  return out.join("\n");
}
