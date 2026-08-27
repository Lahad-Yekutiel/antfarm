/**
 * Expected-failure baseline declared by setup and consumed by the test step.
 *
 * Setup records a known/expected command failure (e.g. OQ-09 `next build`
 * /404 prerender) as EXPECTED_FAILURES. That value is injected into the
 * test prompt as {{expected_failures}} at claim time and evaluated by
 * completeStep so a matching build failure is non-blocking.
 *
 * Do not hand-copy this shape into prompts — parse + format here so the
 * prompt the tester sees and the host-side matcher cannot drift.
 */

export type ExpectedFailure = {
  command: string;
  signature: string;
};

/** Sentinel setup/test agents write when there is no baseline. */
export const EXPECTED_FAILURES_NONE = "none";

const COMMAND_SIGNATURE_SEP = "::";

function stripWrappingQuotes(value: string): string {
  let out = value.trim();
  out = out.replace(/^[`'"]/, "");
  out = out.replace(/[`'"]$/, "");
  return out.trim();
}

function stripLeadingBullet(line: string): string {
  return line.replace(/^\s*-\s*/, "").trim();
}

/**
 * Parse setup's EXPECTED_FAILURES value into structured entries.
 * `none` / empty / missing → [].
 *
 * Accepted line shape (one per failure):
 *   - `npm run build` :: `Cannot read properties of null (reading 'useContext')`
 */
export function parseExpectedFailures(raw: string | undefined | null): ExpectedFailure[] {
  if (raw == null) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (new RegExp(`^${EXPECTED_FAILURES_NONE}\\b`, "i").test(trimmed)) return [];

  const items: ExpectedFailure[] = [];
  for (const line of trimmed.split("\n")) {
    const body = stripLeadingBullet(line);
    if (!body) continue;
    if (new RegExp(`^${EXPECTED_FAILURES_NONE}\\b`, "i").test(body)) continue;
    const sepAt = body.indexOf(COMMAND_SIGNATURE_SEP);
    if (sepAt < 0) continue;
    const command = stripWrappingQuotes(body.slice(0, sepAt).replace(/^command:\s*/i, ""));
    const signature = stripWrappingQuotes(
      body.slice(sepAt + COMMAND_SIGNATURE_SEP.length).replace(/^signature:\s*/i, ""),
    );
    if (command && signature) items.push({ command, signature });
  }
  return items;
}

/** Prompt / round-trip form derived from parseExpectedFailures — never a second copy. */
export function formatExpectedFailuresForPrompt(failures: ExpectedFailure[]): string {
  if (failures.length === 0) return EXPECTED_FAILURES_NONE;
  return failures
    .map((failure) => `- \`${failure.command}\` ${COMMAND_SIGNATURE_SEP} \`${failure.signature}\``)
    .join("\n");
}

function commandCovers(declared: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const a = declared.trim().toLowerCase();
  const b = candidate.trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Failures text that describes the test suite failing — not "test suite passes". */
const UNDECLARED_TEST_FAILURE =
  /\b(?:npm\s+test\b.{0,80}\b(?:fail(?:ed|s|ing)?|error|exit(?:ed)?\s+[1-9])|(?:test suite|tests?)\s+fail(?:ed|s|ing)?)\b/i;

export type ExpectedFailureMatch = {
  matched: boolean;
  reason: string;
};

/**
 * Host-side test-step evaluation: a STATUS: fail is expected/non-blocking
 * only when every declared signature is still present in FAILURES, and the
 * text does not also describe an undeclared extra failure (different error,
 * undeclared command, or a declared failure that changed shape).
 *
 * An empty expected list is never a match — the test step stays strict by
 * default. A previously-expected command that now succeeds is not this
 * function's job (tester would report STATUS: pass).
 */
export function matchesExpectedFailureBaseline(opts: {
  expected: ExpectedFailure[];
  failuresText: string;
  testCmd?: string;
  buildCmd?: string;
}): ExpectedFailureMatch {
  const { expected, failuresText, testCmd, buildCmd } = opts;
  if (expected.length === 0) {
    return { matched: false, reason: "no expected-failure baseline declared" };
  }
  if (!failuresText.trim()) {
    return { matched: false, reason: "STATUS: fail with empty FAILURES" };
  }

  for (const item of expected) {
    if (!failuresText.includes(item.signature)) {
      return {
        matched: false,
        reason: `expected signature not found (shape changed): ${item.signature}`,
      };
    }
  }

  const testCovered = expected.some((item) => commandCovers(item.command, testCmd));
  if (!testCovered && UNDECLARED_TEST_FAILURE.test(failuresText)) {
    return { matched: false, reason: "undeclared test-suite failure" };
  }

  const buildCovered = expected.some((item) => commandCovers(item.command, buildCmd));
  if (
    buildCmd &&
    !buildCovered &&
    /build (?:fail(?:ed|s|ing)?|error)/i.test(failuresText) &&
    commandCovers(buildCmd, failuresText)
  ) {
    return { matched: false, reason: "undeclared build failure" };
  }

  return { matched: true, reason: "all declared expected-failure signatures present" };
}
