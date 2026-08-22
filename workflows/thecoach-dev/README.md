# thecoach-dev — custom Antfarm workflow

Built 2026-08-13, session 2 of the OpenClaw/Antfarm trial. Replaces the
stock `feature-dev` bundle for any future TheCoach-pointed run. See
`local/cursor_loop/OPENCLAW_ANTFARM_NEXT_STEPS.md` and
`OPENCLAW_ANTFARM_LEARNINGS.md` for the full background — this file is
just install/use instructions.

## What this is not yet

**Not installed. Not smoke-tested.** This is a design deliverable, written
by reading Antfarm's source directly (no live run was used to build it).
Per the project's own non-negotiable rule, do not point this at
`feature/phase4-core-web` or any real TheCoach branch until it's proven
clean on a disposable repo first (see NEXT_STEPS.md step 5/6).

## How to install it

Antfarm's `workflow install <name>` only ever looks inside its own
bundled `workflows/` directory — there is no `--path` flag or equivalent
for an arbitrary custom workflow directory (confirmed from
`src/installer/workflow-fetch.ts`). So this folder has to be copied into
that location first:

```bash
cp -r thecoach-dev ~/.openclaw/workspace/antfarm/workflows/thecoach-dev
cd ~/.openclaw/workspace/antfarm
npm run build   # if antfarm reads workflows from a built dist path — verify which
antfarm workflow install thecoach-dev
antfarm workflow list   # confirm it shows up alongside bug-fix/feature-dev/security-audit
```

(Whether a rebuild is actually required, or the CLI reads `workflows/`
directly from source, wasn't verified this session — check
`antfarm workflow list` after copying, before assuming a build step is
needed.)

## How to invoke it — REPO must be explicit, always

This workflow's entire fix for the target-repo bug depends on **never**
letting `antfarm workflow run` infer the repo. Always prefix the task
string with explicit `REPO:` and `BRANCH:` lines as the first two lines,
e.g.:

```bash
antfarm workflow run thecoach-dev "REPO: /home/lahad/trials/thecoach-antfarm-trial
BRANCH: feature/add-contributing-md

Add a CONTRIBUTING.md file with basic setup instructions."
```

If you paste a full TheCoach task file's contents (per
`_SSoT/tasks/TEMPLATE_TASK.md`) as the rest of the task string after those
two lines, the planner will have the full task context (Objective,
Requirements, QA checklist, Protected paths, etc.) available to work from
— this is the intended way to feed a real TheCoach task in, once this
workflow is validated.

## Design notes / open items for the developer

- **No automated Specialist-tier escalation — removed 2026-08-13 after the
  smoke test.** The original design put a `specialist-fix` step in the
  array and pointed `on_fail.on_exhausted.escalate_to` at it. Both parts
  were wrong: Antfarm's `advancePipeline()` is strictly linear by
  `step_index` (no conditional branching at all), so a listed step runs
  *every time*, not just on failure — confirmed empirically, `specialist-fix`
  ran unconditionally on the very first smoke-test run despite `implement`
  succeeding cleanly. Separately, `on_exhausted.escalate_to` is a
  notification-only side channel (sends a chat message via
  `sendSessionMessage`, does not redirect execution), and only resolves
  for `"main"`/`"human"`/an `"agent:..."` reference — a bare step id
  silently does nothing. Current behavior: `implement`'s retries exhausting
  sends a real chat notification (`escalate_to: main`) and the run is left
  for human triage — same as `cursor_loop`'s own `blocked` state, no
  automated stronger-model retry. A real Specialist tier would need either
  a different approach on the developer step's own retry attempts (not
  investigated), or a human/Architect manually swapping the model and
  running `antfarm workflow resume <run-id>` — worth a real design pass
  before this matters for actual use, not a blocker for further smoke
  testing.
- **Reply-format labels are unique per step across the whole workflow**
  (`STATUS` meanings differ intentionally per step but every step's full
  label set is otherwise non-overlapping) — this is the direct fix for the
  stock bundle's `TESTS:`/`RESULTS:` mislabeling bug. Antfarm has no
  structured/JSON output support at the framework level (confirmed from
  `src/installer/step-ops.ts` — `parseOutputKeyValues` only ever parses
  free-text `KEY: value` lines); strict, non-overlapping labels are the
  only mitigation available, not a partial workaround for a better option
  that exists.
- **The protected-path gate runs inside the `verify` step**, not as a
  separate deterministic step — Antfarm has no non-LLM step type, so
  "deterministic" here means "an LLM agent given an unambiguous shell
  command and an unconditional instruction to run it first," same trust
  model as `cursor_loop`'s own Architect-side gate.
- **Every model is pinned explicitly** (`anthropic/claude-sonnet-5` for
  every step, `polling.model` also pinned) — confirmed necessary from the
  trial's `model: "default"` → silent `openai/default` failure.
- **`agent-browser` is a real, TheCoach-authored skill** (not a generic
  community one) — see `local/cursor_loop/agent-browser-skill/SKILL.md`,
  installed at `~/.openclaw/skills/agent-browser/`. `browser-qa` and
  `reviewer` both use `role: testing` specifically because `role: analysis`
  denies `group:ui` (no browser/canvas) — confirmed from
  `src/installer/install.ts`'s `ROLE_POLICIES`, not assumed.
