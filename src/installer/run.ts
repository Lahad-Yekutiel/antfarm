import crypto from "node:crypto";
import { loadWorkflowSpec } from "./workflow-spec.js";
import { resolveWorkflowDir } from "./paths.js";
import { getDb, nextRunNumber } from "../db.js";
import { logger } from "../lib/logger.js";
import { ensureWorkflowCrons } from "./agent-cron.js";
import { emitEvent } from "./events.js";

function parseRepoFromTask(task: string): string | null {
  const match = task.match(/^REPO:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function repoFromRunContext(contextJson: string, task: string): string | null {
  try {
    const context = JSON.parse(contextJson) as Record<string, string>;
    if (context.repo?.trim()) return context.repo.trim();
  } catch {
    // fall through
  }
  return parseRepoFromTask(task);
}

function findConflictingRun(workflowId: string, repo: string): { id: string; task: string } | null {
  const db = getDb();
  const running = db.prepare(
    "SELECT id, task, context FROM runs WHERE workflow_id = ? AND status = 'running'",
  ).all(workflowId) as Array<{ id: string; task: string; context: string }>;

  for (const run of running) {
    const existingRepo = repoFromRunContext(run.context, run.task);
    if (existingRepo && existingRepo === repo) return { id: run.id, task: run.task };
  }
  return null;
}

export async function runWorkflow(params: {
  workflowId: string;
  taskTitle: string;
  notifyUrl?: string;
}): Promise<{ id: string; runNumber: number; workflowId: string; task: string; status: string }> {
  const repo = parseRepoFromTask(params.taskTitle);
  if (repo) {
    const conflict = findConflictingRun(params.workflowId, repo);
    if (conflict) {
      throw new Error(
        `Cannot start workflow run: another run (${conflict.id.slice(0, 8)}) is already ` +
          `'running' against repo "${repo}". Wait for it to finish or stop it before starting a second run on the same checkout.`,
      );
    }
  }

  const workflowDir = resolveWorkflowDir(params.workflowId);
  const workflow = await loadWorkflowSpec(workflowDir);
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const runNumber = nextRunNumber();

  const initialContext: Record<string, string> = {
    task: params.taskTitle,
    ...workflow.context,
  };

  db.exec("BEGIN");
  try {
    const notifyUrl = params.notifyUrl ?? workflow.notifications?.url ?? null;
    const insertRun = db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, notify_url, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)"
    );
    insertRun.run(runId, runNumber, workflow.id, params.taskTitle, JSON.stringify(initialContext), notifyUrl, now, now);

    const insertStep = db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];
      const stepUuid = crypto.randomUUID();
      const agentId = `${workflow.id}_${step.agent}`;
      const status = i === 0 ? "pending" : "waiting";
      const maxRetries = step.max_retries ?? step.on_fail?.max_retries ?? 2;
      const stepType = step.type ?? "single";
      const loopConfig = step.loop ? JSON.stringify(step.loop) : null;
      insertStep.run(stepUuid, runId, step.id, agentId, i, step.input, step.expects, status, maxRetries, stepType, loopConfig, now, now);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Start crons for this workflow (no-op if already running from another run)
  try {
    await ensureWorkflowCrons(workflow);
  } catch (err) {
    // Roll back the run since it can't advance without crons
    const db2 = getDb();
    db2.prepare("UPDATE runs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), runId);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot start workflow run: cron setup failed. ${message}`);
  }

  emitEvent({ ts: new Date().toISOString(), event: "run.started", runId, workflowId: workflow.id });

  logger.info(`Run started: "${params.taskTitle}"`, {
    workflowId: workflow.id,
    runId,
    stepId: workflow.steps[0]?.id,
  });

  return { id: runId, runNumber, workflowId: workflow.id, task: params.taskTitle, status: "running" };
}
