import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded via `node --import` so each test-file worker gets its own SQLite
// directory. The npm `test` script also sets OPENCLAW_STATE_DIR, but that
// value is shared across parallel workers and caused SQLITE_BUSY flakes.
process.env.OPENCLAW_STATE_DIR = mkdtempSync(join(tmpdir(), "antfarm-test-"));
