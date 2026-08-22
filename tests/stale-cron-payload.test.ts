import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPollingPrompt } from "../dist/installer/agent-cron.js";

describe("checkStaleCronPayloads helpers", () => {
  it("detects stale payload missing sessions_spawn / step peek", async () => {
    const { checkStaleCronPayloads } = await import("../dist/medic/checks.js");
    const expected = buildPollingPrompt("feature-dev", "developer");
    const findings = await checkStaleCronPayloads([
      {
        id: "job-1",
        name: "antfarm/feature-dev/developer",
        payload: { message: "old prompt without two-phase polling" },
      },
    ]);

    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, "stale_cron_payload");
  });

  it("accepts current buildPollingPrompt payload shape", async () => {
    const { checkStaleCronPayloads } = await import("../dist/medic/checks.js");
    const expected = buildPollingPrompt("feature-dev", "developer");
    const findings = await checkStaleCronPayloads([
      {
        id: "job-1",
        name: "antfarm/feature-dev/developer",
        payload: { message: expected },
      },
    ]);

    assert.equal(findings.length, 0);
  });
});
