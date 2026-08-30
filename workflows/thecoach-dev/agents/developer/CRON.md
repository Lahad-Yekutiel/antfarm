# Developer Step Completion Instructions

This overrides the generic Antfarm cron prompt. Use this exact mechanism after finishing each story.

## Step 1 — Verify you're in the right repo
```bash
git -C {{repo}} rev-parse --show-toplevel
```
Must match `{{repo}}`. If not, stop and reply `STATUS: blocked`.

## Step 2 — Check for pending work
```bash
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js step claim "thecoach-dev_developer"
```

If output is `"NO_WORK"`, stop.

If JSON is returned, it contains: `{"stepId": "...", "runId": "...", "input": "..."}`
**Save the stepId** — you'll need it below.

## Step 3 — Do the work

Implement exactly one story. Follow the instructions in the `input` field carefully.

## Step 4 — Commit your work

Before reporting completion, commit your changes:
```bash
git -C {{repo}} add -A && git -C {{repo}} commit -m "[thecoach-dev] <story-id>: <short description>"
```

## Step 5 — Capture your commit SHA

Get the SHA of the commit you just made:
```bash
COMMIT_SHA=$(git -C {{repo}} rev-parse HEAD)
echo "$COMMIT_SHA"
```

Save this value — it goes in your step completion report.

## Step 6 — MANDATORY: Report completion

Format your complete output with ALL of these fields:

```
STATUS: done | blocked
CHANGES: <description of what you implemented>
TEST_RESULT: <output from running the test suite, verbatim>
COMMIT_SHA: <the commit SHA from step 5>
```

Then pipe it to step complete. Capture the commit SHA **before** creating the heredoc:

```bash
COMMIT_SHA=$(git -C {{repo}} rev-parse HEAD)

cat <<ANTFARM_EOF > /tmp/antfarm-step-output.txt
STATUS: done
CHANGES: <what you actually did>
TEST_RESULT: <real test output>
COMMIT_SHA: $COMMIT_SHA
ANTFARM_EOF

cat /tmp/antfarm-step-output.txt | node ~/.openclaw/workspace/antfarm/dist/cli/cli.js step complete "<stepId>"
```

Replace `<stepId>` with the actual step ID from step 2.

## If the work FAILED

```bash
node ~/.openclaw/workspace/antfarm/dist/cli/cli.js step fail "<stepId>" "description of what went wrong"
```

## CRITICAL RULES

1. **NEVER** end your session without calling `step complete` or `step fail`
2. **ALWAYS** include `COMMIT_SHA:` in your completion output
3. **ALWAYS** include actual test output in `TEST_RESULT:`, not a paraphrase
4. Write output to a file first (`/tmp/antfarm-step-output.txt`), then pipe via stdin — shell escaping breaks direct args
5. The workflow cannot advance until you report completion

Your session ending without reporting = broken pipeline. If you're unsure, call `step fail` with an explanation.
