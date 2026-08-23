import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SyncWorkflowError, formatSyncSandboxReport, waitForContainerChange } from "../dist/installer/sync.js";

describe("waitForContainerChange", () => {
  const shortOpts = {
    timeoutMs: 80,
    pollIntervalMs: 5,
    sleepFn: async () => {},
  };

  it("treats destroy-without-replacement as success (lazy recreate)", async () => {
    const result = await waitForContainerChange("agent-gone", "oldcontainerid", {
      ...shortOpts,
      getContainerId: () => null,
    });
    assert.equal(result, null);
  });

  it("times out when the prior container is never removed", async () => {
    await assert.rejects(
      () => waitForContainerChange("agent-stuck", "oldcontainerid", {
        ...shortOpts,
        getContainerId: () => "oldcontainerid",
      }),
      (err: unknown) => {
        assert.ok(err instanceof SyncWorkflowError);
        assert.match((err as SyncWorkflowError).message, /Timed out/);
        return true;
      },
    );
  });

  it("returns the new id when a prior container is replaced", async () => {
    const result = await waitForContainerChange("agent-replaced", "oldcontainerid", {
      ...shortOpts,
      getContainerId: () => "newcontainerid",
    });
    assert.equal(result, "newcontainerid");
  });

  it("treats stable absence as success when there was no prior container", async () => {
    const result = await waitForContainerChange("agent-never-had-one", null, {
      ...shortOpts,
      getContainerId: () => null,
    });
    assert.equal(result, null);
  });
});

describe("formatSyncSandboxReport", () => {
  it("does not say Recreated when no container was confirmed", () => {
    const lines = formatSyncSandboxReport("thecoach-dev", [
      { agentId: "thecoach-dev_setup", previousContainerId: "abc", newContainerId: null },
      { agentId: "thecoach-dev_developer", previousContainerId: null, newContainerId: null },
    ]);
    const text = lines.join("\n");
    assert.equal(lines.length, 1);
    assert.match(text, /Removed 2 sandbox runtime\(s\) for thecoach-dev agent\(s\)/);
    assert.match(text, /next time each agent runs/);
    assert.doesNotMatch(text, /Recreated/);
  });

  it("reports confirmed containers separately from the destroy-only path", () => {
    const lines = formatSyncSandboxReport("thecoach-dev", [
      { agentId: "thecoach-dev_setup", previousContainerId: "old", newContainerId: null },
      { agentId: "thecoach-dev_developer", previousContainerId: "old2", newContainerId: "new2" },
    ]);
    const text = lines.join("\n");
    assert.match(text, /Removed 1 sandbox runtime\(s\)/);
    assert.match(text, /Confirmed 1 agent sandbox container\(s\) present after sync/);
    assert.doesNotMatch(text, /Recreated/);
  });
});
