import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// TASK-050 / OQ-19. A sandbox rw bind detaches when the host recreates the
// bound directory under a running container; every write then returns EROFS
// while `docker inspect` still reports rw=true. These cases pin the guard that
// probes for it before dispatch.
describe("sandbox rw-mount guard", () => {
  const result = spawnSync(
    process.execPath,
    ["local-tools/coordinator-trigger.mjs", "--self-test-sandbox-mount-guard"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, COORDINATOR_TOKEN: "x" },
      encoding: "utf-8",
    },
  );

  it("self-test harness runs clean", () => {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  const parsed = result.status === 0 ? JSON.parse(result.stdout) : { failures: [], cases: [] };
  const byCase = Object.fromEntries(parsed.cases.map((c) => [c.case, c]));

  it("reports no failures", () => {
    assert.deepEqual(parsed.failures, []);
  });

  it("leaves a healthy sandbox alone", () => {
    assert.equal(byCase["healthy-ok"].ok, true);
    assert.equal(byCase["healthy-no-removal"].ok, true);
    assert.equal(byCase["healthy-probed-both"].ok, true);
  });

  // The regression that cost three investigations: inspect says rw, the write
  // says EROFS. Only the probe can tell, and the container cannot be repaired.
  it("removes a container whose rw mount has gone stale", () => {
    assert.equal(byCase["stale-removed"].ok, true);
    assert.equal(byCase["stale-reason-names-target"].ok, true);
    assert.equal(byCase["stale-ok-true"].ok, true);
  });

  it("removes a container it cannot exec into", () => {
    assert.equal(byCase["stopped-removed"].ok, true);
    assert.equal(byCase["stopped-no-probe"].ok, true);
  });

  // OQ-22(a). OpenClaw's ensureSandboxContainer() runs `docker start` on a
  // container that exists but is not running, with no rebuild fallback, and
  // that start is exactly what fails after a host reboot: Docker Desktop
  // stages the single-file binds (.git-credentials, .gitconfig) at create
  // time and the staging does not survive a stop. So the guard removing the
  // stopped container BEFORE startRun is the whole reason a reboot costs a
  // rebuild instead of every dispatch. The case above pins the removal; this
  // pins the order, which is the half that makes it safe.
  it("removes a stopped container before startRun, then dispatches normally", () => {
    assert.equal(byCase["reboot-removed-before-startRun"].ok, true);
    assert.equal(byCase["reboot-dispatched"].ok, true);
    assert.equal(byCase["reboot-item-dispatched"].ok, true);
  });

  it("does not treat file binds as this failure's class", () => {
    assert.equal(byCase["filebind-no-removal"].ok, true);
    assert.equal(byCase["filebind-marked-skipped"].ok, true);
  });

  // Fail open on a missing docker: the run fails loudly seconds later anyway,
  // and parking the whole queue on a transient hiccup is the worse failure.
  it("fails open when docker is unavailable, and says so", () => {
    assert.equal(byCase["nodocker-ok"].ok, true);
    assert.equal(byCase["nodocker-checked-false"].ok, true);
    assert.equal(byCase["nodocker-reason"].ok, true);
  });

  it("refuses when a poisoned container cannot be removed", () => {
    assert.equal(byCase["removefail-not-ok"].ok, true);
    assert.equal(byCase["removefail-reason"].ok, true);
    assert.equal(byCase["removefail-names-container"].ok, true);
  });

  it("stops the dispatch before startRun and leaves the item pending", () => {
    assert.equal(byCase["callsite-not-dispatched"].ok, true);
    assert.equal(byCase["callsite-startRun-never"].ok, true);
    assert.equal(byCase["callsite-item-stays-pending"].ok, true);
    assert.equal(byCase["callsite-reason"].ok, true);
  });

  it("does not disturb a normal dispatch", () => {
    assert.equal(byCase["healthy-callsite-dispatched"].ok, true);
    assert.equal(byCase["healthy-callsite-startRun-once"].ok, true);
  });
});
