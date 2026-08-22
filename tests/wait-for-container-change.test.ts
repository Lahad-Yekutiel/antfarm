import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SyncWorkflowError, waitForContainerChange } from "../dist/installer/sync.js";

describe("waitForContainerChange", () => {
  const shortOpts = {
    timeoutMs: 80,
    pollIntervalMs: 5,
    sleepFn: async () => {},
  };

  it("times out when a prior container is destroyed and nothing replaces it", async () => {
    await assert.rejects(
      () => waitForContainerChange("agent-gone", "oldcontainerid", {
        ...shortOpts,
        getContainerId: () => null,
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
