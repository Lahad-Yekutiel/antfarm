import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadWorkflowSpec } from "./workflow-spec.js";
import {
  resolveBundledWorkflowDir,
  resolveWorkflowDir,
  resolveWorkflowWorkspaceDir,
} from "./paths.js";
import type { WorkflowAgent } from "./types.js";

export type DriftCopy = "bundled" | "installed" | "workspace";

export type AgentCopyHash = {
  copy: DriftCopy;
  hash: string;
  hashPrefix: string;
  missingFiles: string[];
};

export type AgentDriftResult = {
  agentId: string;
  copies: AgentCopyHash[];
  drifted: boolean;
};

export type DriftCheckResult = {
  workflowId: string;
  agents: AgentDriftResult[];
  hasDrift: boolean;
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function resolveSourceFile(params: {
  sourceRoot: string;
  bundledRoot: string;
  relativePath: string;
}): Promise<string | null> {
  const candidates = [
    path.resolve(params.sourceRoot, params.relativePath),
    path.resolve(params.bundledRoot, params.relativePath),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Compute a deterministic composite hash over all workspace.files for an agent copy.
 * Files are sorted by destination filename; missing files are recorded separately.
 */
export async function hashAgentCopy(params: {
  agent: WorkflowAgent;
  sourceRoot: string;
  bundledRoot: string;
  workspaceRoot?: string;
}): Promise<{ hash: string; missingFiles: string[] }> {
  const entries = Object.entries(params.agent.workspace.files).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const parts: string[] = [];
  const missingFiles: string[] = [];

  for (const [fileName, relativePath] of entries) {
    let filePath: string | null;
    if (params.workspaceRoot) {
      filePath = path.join(params.workspaceRoot, fileName);
      if (!(await fileExists(filePath))) filePath = null;
    } else {
      filePath = await resolveSourceFile({
        sourceRoot: params.sourceRoot,
        bundledRoot: params.bundledRoot,
        relativePath,
      });
    }

    if (!filePath) {
      missingFiles.push(fileName);
      parts.push(`${fileName}:MISSING`);
      continue;
    }

    const fileHash = await sha256File(filePath);
    parts.push(`${fileName}:${fileHash}`);
  }

  const composite = crypto.createHash("sha256").update(parts.join("\n")).digest("hex");
  return { hash: composite, missingFiles };
}

function toCopyHash(copy: DriftCopy, result: { hash: string; missingFiles: string[] }): AgentCopyHash {
  return {
    copy,
    hash: result.hash,
    hashPrefix: result.hash.slice(0, 12),
    missingFiles: result.missingFiles,
  };
}

/**
 * Compare bundled, installed (~/.openclaw/antfarm/workflows), and live workspace copies.
 */
export async function checkWorkflowDrift(workflowId: string): Promise<DriftCheckResult> {
  const bundledDir = resolveBundledWorkflowDir(workflowId);
  const installedDir = resolveWorkflowDir(workflowId);
  const workflow = await loadWorkflowSpec(installedDir);
  const workspaceWorkflowDir = resolveWorkflowWorkspaceDir(workflowId);

  const agents: AgentDriftResult[] = [];

  for (const agent of workflow.agents) {
    const baseDir = agent.workspace.baseDir?.trim() || agent.id;
    const agentWorkspaceRoot = path.join(workspaceWorkflowDir, baseDir);

    const bundled = await hashAgentCopy({ agent, sourceRoot: bundledDir, bundledRoot: bundledDir });
    const installed = await hashAgentCopy({ agent, sourceRoot: installedDir, bundledRoot: bundledDir });
    const workspace = await hashAgentCopy({
      agent,
      sourceRoot: installedDir,
      bundledRoot: bundledDir,
      workspaceRoot: agentWorkspaceRoot,
    });

    const copies = [
      toCopyHash("bundled", bundled),
      toCopyHash("installed", installed),
      toCopyHash("workspace", workspace),
    ];

    const uniqueHashes = new Set(copies.map((c) => c.hash));
    const hasMissing = copies.some((c) => c.missingFiles.length > 0);
    agents.push({
      agentId: agent.id,
      copies,
      drifted: uniqueHashes.size > 1 || hasMissing,
    });
  }

  return {
    workflowId,
    agents,
    hasDrift: agents.some((a) => a.drifted),
  };
}

export function formatDriftTable(result: DriftCheckResult): string {
  const lines: string[] = [];
  lines.push(`Workflow drift check: ${result.workflowId}`);
  lines.push("");
  lines.push(
    ["AGENT", "COPY", "HASH (prefix)", "STATUS"].map((h) => h.padEnd(14)).join("  "),
  );
  lines.push("-".repeat(60));

  for (const agent of result.agents) {
    for (const copy of agent.copies) {
      const status = agent.drifted ? (copy.missingFiles.length ? "MISSING" : "DRIFT") : "OK";
      lines.push(
        [
          agent.agentId.padEnd(14),
          copy.copy.padEnd(14),
          copy.hashPrefix.padEnd(14),
          status,
        ].join("  "),
      );
    }
  }

  lines.push("");
  lines.push(result.hasDrift ? "DRIFT DETECTED — copies are out of sync." : "All copies in sync.");
  return lines.join("\n");
}
