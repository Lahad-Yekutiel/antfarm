import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function provisionWorkspaceFromInstalled(workflowId: string, stateDir: string): Promise<void> {
  const installedDir = path.join(stateDir, "antfarm", "workflows", workflowId);
  const bundledDir = path.join(repoRoot, "workflows", workflowId);
  const raw = await fs.readFile(path.join(installedDir, "workflow.yml"), "utf-8");
  const spec = YAML.parse(raw) as {
    agents: Array<{ id: string; workspace: { baseDir?: string; files: Record<string, string> } }>;
  };

  for (const agent of spec.agents) {
    const baseDir = agent.workspace.baseDir?.trim() || agent.id;
    const workspaceDir = path.join(stateDir, "workspaces", "workflows", workflowId, baseDir);
    await fs.mkdir(workspaceDir, { recursive: true });
    for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
      let source = path.resolve(installedDir, relativePath);
      try {
        await fs.access(source);
      } catch {
        source = path.resolve(bundledDir, relativePath);
      }
      await fs.copyFile(source, path.join(workspaceDir, fileName));
    }
  }
}

describe("workflow drift check", () => {
  let tempStateDir: string;
  let previousStateDir: string | undefined;

  before(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-drift-test-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const bundledSrc = path.join(repoRoot, "workflows", "feature-dev");
    const installedDst = path.join(tempStateDir, "antfarm", "workflows", "feature-dev");
    await fs.mkdir(path.dirname(installedDst), { recursive: true });
    await fs.cp(bundledSrc, installedDst, { recursive: true });
    await provisionWorkspaceFromInstalled("feature-dev", tempStateDir);

    const plannerWorkspace = path.join(
      tempStateDir,
      "workspaces",
      "workflows",
      "feature-dev",
      "agents",
      "planner",
      "AGENTS.md",
    );
    await fs.appendFile(plannerWorkspace, "\n# drift marker for test\n");
  });

  after(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(tempStateDir, { recursive: true, force: true });
  });

  it("detects drift between bundled, installed, and workspace copies", async () => {
    const { checkWorkflowDrift } = await import("../dist/installer/drift.js");
    const result = await checkWorkflowDrift("feature-dev");

    assert.equal(result.workflowId, "feature-dev");
    assert.ok(result.hasDrift, "expected drift when workspace copy differs");

    const planner = result.agents.find((a) => a.agentId === "planner");
    assert.ok(planner, "planner agent should be present");
    assert.ok(planner!.drifted, "planner should be drifted");

    const workspace = planner!.copies.find((c) => c.copy === "workspace");
    const bundled = planner!.copies.find((c) => c.copy === "bundled");
    const installed = planner!.copies.find((c) => c.copy === "installed");
    assert.ok(workspace && bundled && installed);
    assert.notEqual(workspace!.hash, bundled!.hash);
    assert.equal(bundled!.hash, installed!.hash, "bundled and installed should match in test setup");
  });

  it("reports clean when all three copies match", async () => {
    const plannerWorkspace = path.join(
      tempStateDir,
      "workspaces",
      "workflows",
      "feature-dev",
      "agents",
      "planner",
      "AGENTS.md",
    );
    const plannerBundled = path.join(repoRoot, "workflows", "feature-dev", "agents", "planner", "AGENTS.md");
    await fs.copyFile(plannerBundled, plannerWorkspace);

    const { checkWorkflowDrift } = await import("../dist/installer/drift.js");
    const result = await checkWorkflowDrift("feature-dev");

    assert.equal(result.hasDrift, false);
    const planner = result.agents.find((a) => a.agentId === "planner");
    assert.ok(planner);
    assert.equal(planner!.drifted, false);
  });
});
