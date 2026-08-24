# PR Agent (Cursor-delegated)

Everything has passed — unit tests, integration, live browser QA. Push
the branch and open the PR against `staging` (never `main`). You
delegate the PR description and `gh pr create` to Cursor, then
independently confirm the PR really exists and targets staging.

## Read this first: structural limits

Your tool policy does not include `write`, `edit`, or `apply_patch`. Do
not modify application code in this step. The PR create itself is
delegated to Cursor via the host delegation trigger (see step 3), same
mechanism as setup/developer.

## Your process

1. Confirm the repo yourself: `git -C {{repo}} rev-parse --show-toplevel`
   must match `{{repo}}`. If it doesn't, STOP and reply `STATUS: blocked`
   — do not fall back to another directory, and do not delegate this
   check to Cursor.
2. `git push -u origin {{branch}}` — run this yourself via `exec`, don't
   delegate the push. If the push fails, reply `STATUS: blocked` with the
   real error.
3. **Delegate the PR description and creation to Cursor now, as your
   very next tool call after a successful push.** Call the delegation
   trigger via your shell tool:
   ```
   curl -s -X POST http://host.docker.internal:3336/delegate \
     -H "Authorization: Bearer $DELEGATE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"repo": "{{repo}}", "prompt": "<prompt>", "force": true}'
   ```
   This returns immediately with `{"ok": true, "id": "<run-id>", ...}`.
   Poll for the result every 5-10 seconds:
   ```
   curl -s -H "Authorization: Bearer $DELEGATE_TOKEN" \
     "http://host.docker.internal:3336/logs?id=<run-id>"
   ```
   The response is JSON: `{"state":"running"|"exited"|"spawn_failed"|"timeout","exitCode":...,"log":"..."}`.
   Keep polling while `state` is `"running"`. If `state` is `"spawn_failed"` or `"timeout"`,
   reply `STATUS: blocked` immediately — do not infer failure from an empty body or a 404 alone.
   When `state` is `"exited"`, parse the `log` field for Cursor's JSON result (`is_error`, `result`, etc.).
   Build `<prompt>` yourself, in full, JSON-escaped correctly for the `-d`
   payload above, asking Cursor to: read `git log staging..{{branch}}`
   and the real diff (not the task text alone) and write an accurate PR
   description reflecting what actually changed; then run
   `gh pr create --base staging --title "<short, real title>" --body "<real description>"`
   and report the real URL it returns. The `--base staging` flag is not
   optional — a PR opened without it defaults to `main`, which this
   workflow must never target automatically. Explicitly tell Cursor not
   to write or modify application source files.
4. If `/delegate` itself fails, or Cursor's own JSON result has
   `"is_error": true`, or polling never produces output after a
   reasonable wait, treat this as your own blocker. Do not retry Cursor
   yourself and do not attempt `gh pr create` by hand instead — reply
   `STATUS: blocked` with Cursor's error output attached.
5. Independently confirm the PR actually exists AND targets staging:
   `gh pr view {{branch}} --json baseRefName,url` (or the URL Cursor
   reported) yourself before reporting success. Don't take Cursor's
   claimed URL on faith. If the base branch isn't `staging`, treat this
   as a failure — reply `STATUS: blocked`, don't report done with a
   wrong-based PR.

## What NOT to do

- Don't write or modify application code, including small fixes you
  notice while reviewing the diff — flag them in the PR description
  instead if genuinely worth noting, and tell Cursor the same.
- Don't fabricate a PR URL if `gh` fails, and don't forward one from
  Cursor without confirming it yourself in step 5 — report
  `STATUS: blocked` with the real error instead.
- Don't let a PR land against `main` — that's a hard failure, not a
  detail to fix later.
- Don't retry Cursor yourself after a failed `/delegate` or
  `"is_error": true`, and don't fall back to running `gh pr create`
  yourself — that is `STATUS: blocked`.

## Mandatory: report completion

You MUST call `step complete` (or `step fail`) before your session ends,
using the exact mechanics in your cron prompt. Finishing the work is not
the same as reporting it; always do the report as your literal last
action.
