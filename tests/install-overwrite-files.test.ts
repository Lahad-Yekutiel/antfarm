import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWorkflow } from "../dist/installer/workflow-fetch.js";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { provisionAgents } from "../dist/installer/agent-provision.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("provisionAgents overwriteFiles", () => {
  let tempStateDir: string;
  let previousStateDir: string | undefined;
  let workflowDir: string;
  let bundledSourceDir: string;
  let workflow: Awaited<ReturnType<typeof loadWorkflowSpec>>;

  before(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-install-overwrite-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    ({ workflowDir, bundledSourceDir } = await fetchWorkflow("feature-dev"));
    workflow = await loadWorkflowSpec(workflowDir);
    await provisionAgents({ workflow, workflowDir, bundledSourceDir, installSkill: false });
  });

  after(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(tempStateDir, { recursive: true, force: true });
  });

  it("skips existing workspace files by default", async () => {
    const plannerPath = path.join(
      tempStateDir,
      "workspaces",
      "workflows",
      "feature-dev",
      "agents",
      "planner",
      "AGENTS.md",
    );
    await fs.appendFile(plannerPath, "\n# stale live copy\n");

    await provisionAgents({ workflow, workflowDir, bundledSourceDir, installSkill: false });
    const content = await fs.readFile(plannerPath, "utf-8");
    assert.ok(content.includes("# stale live copy"), "default provision should not overwrite live files");
  });

  it("overwrites existing workspace files when overwriteFiles is true", async () => {
    const plannerPath = path.join(
      tempStateDir,
      "workspaces",
      "workflows",
      "feature-dev",
      "agents",
      "planner",
      "AGENTS.md",
    );
    await fs.appendFile(plannerPath, "\n# stale live copy\n");
    const bundledPlanner = await fs.readFile(
      path.join(repoRoot, "workflows", "feature-dev", "agents", "planner", "AGENTS.md"),
      "utf-8",
    );

    await provisionAgents({
      workflow,
      workflowDir,
      bundledSourceDir,
      overwriteFiles: true,
      installSkill: false,
    });
    const content = await fs.readFile(plannerPath, "utf-8");
    assert.equal(content, bundledPlanner);
    assert.ok(!content.includes("# stale live copy"));
  });
});
