import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const content = readFileSync(
  resolve(import.meta.dirname, "../workflows/thecoach-dev/agents/verifier/AGENTS.md"),
  "utf-8",
);

describe("thecoach-dev verifier AGENTS.md output contract", () => {
  it("requires GATE: and STATUS: pass|fail, not the implement STATUS: done format", () => {
    assert.ok(content.includes("GATE: pass | fail"));
    assert.ok(content.includes("STATUS: pass | fail"));
    assert.ok(content.includes("Do not start with"));
    assert.ok(content.includes("STATUS: done"));
    assert.ok(content.includes("CHANGES: GATE: pass"));
    assert.ok(content.includes("missing_required_keys: gate"));
  });
});
