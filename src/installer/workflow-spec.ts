import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { LoopConfig, PollingConfig, WorkflowAgent, WorkflowSpec, WorkflowStep, WorkflowStepFailWhen } from "./types.js";
import { resolveBundledWorkflowDir, resolveWorkflowDir } from "./paths.js";

export async function loadWorkflowSpec(workflowDir: string): Promise<WorkflowSpec> {
  const filePath = path.join(workflowDir, "workflow.yml");
  const raw = await fsPromises.readFile(filePath, "utf-8");
  const parsed = YAML.parse(raw) as WorkflowSpec;
  if (!parsed?.id) {
    throw new Error(`workflow.yml missing id in ${workflowDir}`);
  }
  if (parsed.id.includes("_")) {
    throw new Error(`workflow.yml id "${parsed.id}" must not contain underscores`);
  }
  if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    throw new Error(`workflow.yml missing agents list in ${workflowDir}`);
  }
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`workflow.yml missing steps list in ${workflowDir}`);
  }
  if (parsed.polling) {
    validatePollingConfig(parsed.polling, workflowDir);
  }
  validateAgents(parsed.agents, workflowDir);
  // Parse type/loop from raw YAML before validation
  for (const step of parsed.steps) {
    const rawStep = step as any;
    if (rawStep.type) {
      step.type = rawStep.type;
    }
    if (rawStep.loop) {
      step.loop = parseLoopConfig(rawStep.loop);
    }
  }
  validateSteps(parsed.steps, workflowDir);
  return parsed;
}

function validatePollingConfig(polling: PollingConfig, workflowDir: string) {
  if (polling.timeoutSeconds !== undefined && polling.timeoutSeconds <= 0) {
    throw new Error(`workflow.yml polling.timeoutSeconds must be positive in ${workflowDir}`);
  }
}

function validateAgents(agents: WorkflowAgent[], workflowDir: string) {
  const ids = new Set<string>();
  for (const agent of agents) {
    if (!agent.id?.trim()) {
      throw new Error(`workflow.yml missing agent id in ${workflowDir}`);
    }
    if (agent.id.includes("_")) {
      throw new Error(`workflow.yml agent "${agent.id}" must not contain underscores (reserved as namespace separator)`);
    }
    if (ids.has(agent.id)) {
      throw new Error(`workflow.yml has duplicate agent id "${agent.id}" in ${workflowDir}`);
    }
    ids.add(agent.id);
    if (!agent.workspace?.baseDir?.trim()) {
      throw new Error(`workflow.yml missing workspace.baseDir for agent "${agent.id}"`);
    }
    if (!agent.workspace?.files || Object.keys(agent.workspace.files).length === 0) {
      throw new Error(`workflow.yml missing workspace.files for agent "${agent.id}"`);
    }
    if (agent.workspace.skills && !Array.isArray(agent.workspace.skills)) {
      throw new Error(`workflow.yml workspace.skills must be a list for agent "${agent.id}"`);
    }
    if (agent.timeoutSeconds !== undefined && agent.timeoutSeconds <= 0) {
      throw new Error(`workflow.yml agent "${agent.id}" timeoutSeconds must be positive`);
    }
  }
}

function validateFailWhen(failWhen: WorkflowStepFailWhen, stepId: string, workflowDir: string): void {
  if (!failWhen || typeof failWhen !== "object" || Array.isArray(failWhen)) {
    throw new Error(`workflow.yml step "${stepId}" fail_when must be a map of key -> [values] in ${workflowDir}`);
  }
  for (const [key, values] of Object.entries(failWhen)) {
    if (!key.trim()) {
      throw new Error(`workflow.yml step "${stepId}" fail_when has an empty key in ${workflowDir}`);
    }
    if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string" || !v.trim())) {
      throw new Error(`workflow.yml step "${stepId}" fail_when.${key} must be a non-empty list of strings in ${workflowDir}`);
    }
  }
}

function validateSkipUnlessDiffMatches(patterns: string[], stepId: string, workflowDir: string): void {
  if (!Array.isArray(patterns) || patterns.length === 0 || patterns.some((p) => typeof p !== "string" || !p.trim())) {
    throw new Error(
      `workflow.yml step "${stepId}" skip_unless_diff_matches must be a non-empty list of glob strings in ${workflowDir}`,
    );
  }
}

function readWorkflowStep(workflowId: string, stepId: string): WorkflowStep | undefined {
  const dirs = [resolveBundledWorkflowDir(workflowId), resolveWorkflowDir(workflowId)];
  for (const dir of dirs) {
    try {
      const raw = fs.readFileSync(path.join(dir, "workflow.yml"), "utf-8");
      const parsed = YAML.parse(raw) as WorkflowSpec;
      const step = parsed.steps?.find((s) => s.id === stepId);
      if (!step) continue;
      return step;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Look up a step's fail_when from workflow.yml. Prefers the bundled (git)
 * copy so host-side completeStep sees new declarations before `workflow sync`
 * copies files into agent workspaces. Falls back to the installed copy.
 */
export function getStepFailWhen(workflowId: string, stepId: string): WorkflowStepFailWhen | undefined {
  return readWorkflowStep(workflowId, stepId)?.fail_when;
}

/**
 * Look up skip_unless_diff_matches. Same bundled-then-installed preference
 * as fail_when. Undefined = key absent = always run the agent.
 */
export function getStepSkipUnlessDiffMatches(workflowId: string, stepId: string): string[] | undefined {
  const patterns = readWorkflowStep(workflowId, stepId)?.skip_unless_diff_matches;
  if (!Array.isArray(patterns) || patterns.length === 0) return undefined;
  return patterns.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseLoopConfig(raw: any): LoopConfig {
  return {
    over: raw.over,
    completion: raw.completion,
    freshSession: raw.fresh_session ?? raw.freshSession,
    verifyEach: raw.verify_each ?? raw.verifyEach,
    verifyStep: raw.verify_step ?? raw.verifyStep,
  };
}

function validateSteps(steps: WorkflowStep[], workflowDir: string) {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id?.trim()) {
      throw new Error(`workflow.yml missing step id in ${workflowDir}`);
    }
    if (ids.has(step.id)) {
      throw new Error(`workflow.yml has duplicate step id "${step.id}" in ${workflowDir}`);
    }
    ids.add(step.id);
    if (!step.agent?.trim()) {
      throw new Error(`workflow.yml missing step.agent for step "${step.id}"`);
    }
    if (!step.input?.trim()) {
      throw new Error(`workflow.yml missing step.input for step "${step.id}"`);
    }
    if (!step.expects?.trim()) {
      throw new Error(`workflow.yml missing step.expects for step "${step.id}"`);
    }
    if (step.fail_when !== undefined) {
      validateFailWhen(step.fail_when, step.id, workflowDir);
    }
    if (step.skip_unless_diff_matches !== undefined) {
      validateSkipUnlessDiffMatches(step.skip_unless_diff_matches, step.id, workflowDir);
    }
  }

  // Validate loop config references
  for (const step of steps) {
    if (step.type === "loop") {
      if (!step.loop) {
        throw new Error(`workflow.yml step "${step.id}" has type=loop but no loop config`);
      }
      if (step.loop.over !== "stories") {
        throw new Error(`workflow.yml step "${step.id}" loop.over must be "stories"`);
      }
      if (step.loop.completion !== "all_done") {
        throw new Error(`workflow.yml step "${step.id}" loop.completion must be "all_done"`);
      }
      if (step.loop.verifyEach && step.loop.verifyStep) {
        if (!ids.has(step.loop.verifyStep)) {
          throw new Error(`workflow.yml step "${step.id}" loop.verify_step references unknown step "${step.loop.verifyStep}"`);
        }
      }
    }
  }
}
