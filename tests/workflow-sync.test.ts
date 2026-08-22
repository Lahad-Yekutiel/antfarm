import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../dist/db.js";

describe("syncWorkflow safety guard", () => {
  let tempStateDir: string;
  let previousStateDir: string | undefined;
  const runId = randomUUID();

  before(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-sync-test-"));
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'feature-dev', 'active task', 'running', '{}', ?, ?)`,
    ).run(runId, now, now);
  });

  after(async () => {
    const db = getDb();
    db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(tempStateDir, { recursive: true, force: true });
  });

  it("refuses to sync when a run is active for the workflow", async () => {
    const { syncWorkflow, SyncWorkflowError } = await import("../dist/installer/sync.js");
    await assert.rejects(
      () => syncWorkflow("feature-dev"),
      (err: unknown) => {
        assert.ok(err instanceof SyncWorkflowError);
        assert.match((err as SyncWorkflowError).message, /status='running'/);
        return true;
      },
    );
  });
});
