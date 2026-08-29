import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionsSendCliArgs,
  interpretSessionsSendCliResult,
} from "../dist/installer/gateway-api.js";

describe("sessions.send CLI fallback", () => {
  it("uses gateway call sessions.send, not the nonexistent tool subcommand", () => {
    const args = buildSessionsSendCliArgs("agent:main:main", "hello");
    assert.deepEqual(args.slice(0, 4), ["gateway", "call", "sessions.send", "--json"]);
    assert.equal(args.includes("tool"), false);
    const params = JSON.parse(args[args.indexOf("--params") + 1]) as { key: string; message: string };
    assert.equal(params.key, "agent:main:main");
    assert.equal(params.message, "hello");
  });

  it("treats sessions.send {runId,status:started} as success", () => {
    const result = interpretSessionsSendCliResult(
      JSON.stringify({ runId: "abc", status: "started", messageSeq: 1 }),
    );
    assert.equal(result.ok, true);
  });

  it("treats ok:false and error payloads as failure, even if the CLI exited 0", () => {
    const result = interpretSessionsSendCliResult(
      JSON.stringify({ ok: false, error: { message: "Tool not available: sessions_send" } }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Tool not available/);
  });
});
