import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MedicFinding } from "./checks.js";

export type DiagnosticPredicate = {
  type: "sql" | "json_path" | "cmd" | "substring";
  query: string;
  expect?: string;
  notes?: string;
};

export type KnownFailureMode = {
  id: string;
  summary: string;
  diagnostic_check: string;
  diagnostic_predicate?: DiagnosticPredicate;
  anti_markers?: string[];
  medic_check?: string;
  documentation_only?: boolean;
};

export type KnownFailureModesFile = {
  modes: KnownFailureMode[];
};

export function loadKnownFailureModes(): KnownFailureModesFile {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const filePath = path.join(repoRoot, "KNOWN_FAILURE_MODES.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as KnownFailureModesFile;
}

/**
 * Evaluate SQL predicates from KNOWN_FAILURE_MODES.json that are not already
 * covered by dedicated medic checks (stuck_steps, dead_runs, orphaned_crons).
 */
export function checkKnownFailureSqlModes(db: {
  prepare: (sql: string) => { get: () => unknown };
}): MedicFinding[] {
  const catalog = loadKnownFailureModes();
  const findings: MedicFinding[] = [];
  const skipIds = new Set(["stuck-steps-abandoned", "zombie-runs", "orphaned-crons"]);

  for (const mode of catalog.modes) {
    if (mode.documentation_only || skipIds.has(mode.id)) continue;
    const pred = mode.diagnostic_predicate;
    if (!pred || pred.type !== "sql") continue;

    try {
      const row = db.prepare(pred.query).get() as { cnt?: number } | undefined;
      const count = Number(row?.cnt ?? 0);
      if (count > 0) {
        findings.push({
          check: `known_failure:${mode.id}`,
          severity: "warning",
          message: `${mode.summary} (${mode.id}): ${mode.diagnostic_check} — matched ${count} row(s)`,
          action: "none",
          remediated: false,
        });
      }
    } catch {
      // Invalid SQL in catalog — skip
    }
  }

  return findings;
}
