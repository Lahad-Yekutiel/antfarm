import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db.js";
import { resolveAntfarmRoot } from "./paths.js";

/**
 * Resolved at CALL time, never at module load. resolveAntfarmRoot() reads
 * OPENCLAW_STATE_DIR from the environment, and several tests mutate that env
 * var inside before/after hooks (install-overwrite-files, workflow-sync,
 * workflow-drift) — i.e. after this module is imported. A module-level const
 * would freeze the wrong path for those and, worse, send every `npm test`
 * event into the developer's real ~/.openclaw/antfarm/events.jsonl, which is
 * the primary evidence source for run diagnosis.
 */
function eventsDir(): string {
  return resolveAntfarmRoot();
}

function eventsFile(): string {
  return path.join(eventsDir(), "events.jsonl");
}

const MAX_EVENTS_SIZE = 10 * 1024 * 1024; // 10MB

export type EventType =
  | "run.started" | "run.completed" | "run.failed"
  | "step.pending" | "step.running" | "step.done" | "step.skipped" | "step.failed" | "step.timeout"
  | "story.started" | "story.done" | "story.verified" | "story.retry" | "story.failed"
  | "pipeline.advanced";

export interface AntfarmEvent {
  ts: string;
  event: EventType;
  runId: string;
  workflowId?: string;
  /** Human-readable step name (e.g. "plan", "implement"), NOT the internal UUID. */
  stepId?: string;
  agentId?: string;
  storyId?: string;
  storyTitle?: string;
  detail?: string;
  containerId?: string;
  containerCreatedAt?: string;
  evidence?: {
    command?: string;
    exitCode?: number;
    stdoutTail?: string;
  };
}

export function emitEvent(evt: AntfarmEvent): void {
  try {
    const dir = eventsDir();
    const file = eventsFile();
    fs.mkdirSync(dir, { recursive: true });
    // Rotate if too large
    try {
      const stats = fs.statSync(file);
      if (stats.size > MAX_EVENTS_SIZE) {
        const rotated = file + ".1";
        try { fs.unlinkSync(rotated); } catch {}
        fs.renameSync(file, rotated);
      }
    } catch {}
    fs.appendFileSync(file, JSON.stringify(evt) + "\n");
  } catch {
    // best-effort, never throw
  }
  fireWebhook(evt);
}

// In-memory cache: runId -> notify_url | null
const notifyUrlCache = new Map<string, string | null>();

function getNotifyUrl(runId: string): string | null {
  if (notifyUrlCache.has(runId)) return notifyUrlCache.get(runId)!;
  try {
    const db = getDb();
    const row = db.prepare("SELECT notify_url FROM runs WHERE id = ?").get(runId) as { notify_url: string | null } | undefined;
    const url = row?.notify_url ?? null;
    notifyUrlCache.set(runId, url);
    return url;
  } catch {
    return null;
  }
}

function fireWebhook(evt: AntfarmEvent): void {
  const raw = getNotifyUrl(evt.runId);
  if (!raw) return;
  try {
    let url = raw;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const hashIdx = url.indexOf("#auth=");
    if (hashIdx !== -1) {
      headers["Authorization"] = decodeURIComponent(url.slice(hashIdx + 6));
      url = url.slice(0, hashIdx);
    }
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(evt),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch {
    // fire-and-forget
  }
}

// Read recent events (last N)
export function getRecentEvents(limit = 50): AntfarmEvent[] {
  try {
    const content = fs.readFileSync(eventsFile(), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const events: AntfarmEvent[] = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line) as AntfarmEvent); } catch {}
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

// Read events for a specific run (supports prefix match)
export function getRunEvents(runId: string, limit = 200): AntfarmEvent[] {
  try {
    const content = fs.readFileSync(eventsFile(), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const events: AntfarmEvent[] = [];
    for (const line of lines) {
      try {
        const evt = JSON.parse(line) as AntfarmEvent;
        if (evt.runId === runId || evt.runId.startsWith(runId)) events.push(evt);
      } catch {}
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}
