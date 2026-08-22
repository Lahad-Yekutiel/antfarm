import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb } from "../dist/db.js";
import { runWorkflow } from "../dist/installer/run.js";

describe("runWorkflow repo isolation", () => {
  const testRunIds: string[] = [];

  afterEach(() => {
    const db = getDb();
    for (const runId of testRunIds) {
      db.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
      db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    }
    testRunIds.length = 0;
  });

  it("refuses a second running run against the same REPO", async () => {
    const db = getDb();
    const existingId = randomUUID();
    const now = new Date().toISOString();
    const repo = "/tmp/antfarm-isolation-test-repo";
    const task = `REPO: ${repo}\nBRANCH: feature/test\nDo something`;

    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES (?, 'thecoach-dev', ?, 'running', ?, ?, ?)`,
    ).run(existingId, task, JSON.stringify({ repo }), now, now);
    testRunIds.push(existingId);

    await assert.rejects(
      () => runWorkflow({ workflowId: "thecoach-dev", taskTitle: task }),
      /already 'running' against repo/,
    );
  });
});
