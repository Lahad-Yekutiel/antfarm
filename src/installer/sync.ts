import fs from "node:fs/promises";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fetchWorkflow } from "./workflow-fetch.js";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { provisionAgents } from "./agent-provision.js";
import { checkWorkflowDrift } from "./drift.js";
import { getDb } from "../db.js";
import { resolveOpenClawStateDir } from "./paths.js";

const execFileAsync = promisify(execFile);

const RECREATE_TIMEOUT_MS = 3 * 60 * 1000;
const DOCKER_POLL_INTERVAL_MS = 2000;
const STABLE_ABSENT_POLLS = 3;

export type WaitForContainerChangeOpts = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  getContainerId?: (agentId: string) => string | null;
  sleepFn?: (ms: number) => Promise<void>;
};

export class SyncWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncWorkflowError";
  }
}

function countRunningRuns(workflowId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM runs WHERE workflow_id = ? AND status = 'running'",
  ).get(workflowId) as { cnt: number };
  return row.cnt;
}

async function findOpenclawBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["openclaw"]);
    const bin = stdout.trim();
    if (bin) return bin;
  } catch {
    // fall through
  }
  return "openclaw";
}

function getDockerContainerId(agentId: string): string | null {
  try {
    const stdout = execFileSync(
      "docker",
      [
        "ps",
        "--filter",
        `name=openclaw-sbx-agent-${agentId}-`,
        "--format",
        "{{.ID}}",
      ],
      { encoding: "utf-8", timeout: 2000 },
    ).trim();
    const first = stdout.split("\n").find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForContainerChange(
  agentId: string,
  previousId: string | null,
  opts: WaitForContainerChangeOpts = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? RECREATE_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DOCKER_POLL_INTERVAL_MS;
  const getId = opts.getContainerId ?? getDockerContainerId;
  const sleepFn = opts.sleepFn ?? sleep;
  const deadline = Date.now() + timeoutMs;
  let stableAbsentPolls = 0;

  while (Date.now() < deadline) {
    const current = getId(agentId);

    if (previousId === null) {
      if (current !== null) return current;
      stableAbsentPolls++;
      if (stableAbsentPolls >= STABLE_ABSENT_POLLS) return null;
    } else if (current && current !== previousId) {
      // Require a real replacement id. A destroyed container (current === null)
      // is not a successful change — keep polling until a new id appears or we timeout.
      return current;
    }

    await sleepFn(pollIntervalMs);
  }

  const finalId = getId(agentId);
  if (previousId === null && finalId === null) return null;

  throw new SyncWorkflowError(
    `Timed out after ${timeoutMs / 1000}s waiting for docker container to change for agent "${agentId}"`,
  );
}

async function deleteAgentScratchDirs(workflowId: string): Promise<string[]> {
  const sandboxesRoot = path.join(resolveOpenClawStateDir(), "sandboxes");
  const prefix = `agent-${workflowId}_`;
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(sandboxesRoot);
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const fullPath = path.join(sandboxesRoot, entry);
    await fs.rm(fullPath, { recursive: true, force: true });
    removed.push(fullPath);
  }
  return removed;
}

async function recreateAgentSandbox(agentId: string): Promise<{ previousId: string | null; newId: string | null }> {
  const previousId = getDockerContainerId(agentId);
  const openclawBin = await findOpenclawBinary();

  try {
    await execFileAsync(openclawBin, ["sandbox", "recreate", "--agent", agentId, "--force"], {
      timeout: RECREATE_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SyncWorkflowError(`openclaw sandbox recreate failed for "${agentId}": ${message}`);
  }

  const newId = await waitForContainerChange(agentId, previousId);
  return { previousId, newId };
}

export type SyncWorkflowResult = {
  workflowId: string;
  removedScratchDirs: string[];
  recreatedAgents: Array<{ agentId: string; previousContainerId: string | null; newContainerId: string | null }>;
  driftClean: boolean;
};

/**
 * Sync a workflow's files from bundled source to installed + live workspace copies,
 * reset agent scratch sandboxes, and recreate docker sandboxes.
 */
export async function syncWorkflow(workflowId: string): Promise<SyncWorkflowResult> {
  const activeRuns = countRunningRuns(workflowId);
  if (activeRuns > 0) {
    throw new SyncWorkflowError(
      `Refusing to sync workflow "${workflowId}": ${activeRuns} run(s) currently have status='running'. ` +
        "Stop or wait for active runs before syncing (scratch deletion and sandbox recreate would kill in-flight steps).",
    );
  }

  const { workflowDir, bundledSourceDir } = await fetchWorkflow(workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);
  await provisionAgents({
    workflow,
    workflowDir,
    bundledSourceDir,
    overwriteFiles: true,
  });

  const removedScratchDirs = await deleteAgentScratchDirs(workflowId);

  const recreatedAgents: SyncWorkflowResult["recreatedAgents"] = [];
  for (const agent of workflow.agents) {
    const fullAgentId = `${workflow.id}_${agent.id}`;
    const result = await recreateAgentSandbox(fullAgentId);
    recreatedAgents.push({
      agentId: fullAgentId,
      previousContainerId: result.previousId,
      newContainerId: result.newId,
    });
  }

  const drift = await checkWorkflowDrift(workflowId);
  if (drift.hasDrift) {
    throw new SyncWorkflowError(
      `Sync completed file copy and sandbox recreate for "${workflowId}", but check-drift still reports mismatches.`,
    );
  }

  return {
    workflowId,
    removedScratchDirs,
    recreatedAgents,
    driftClean: true,
  };
}
