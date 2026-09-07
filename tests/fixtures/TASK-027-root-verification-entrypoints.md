# TASK-027: Add root-level verification entrypoints (`test`, `verify`) - `build` deferred to TASK-045

## Status
Ready

## Objective
From the repo root, `npm test` and `npm run verify` each do the
obvious thing across every workspace, so that "did I break anything?"
is one command instead of tribal knowledge about which workspace to cd
into. No product/UI behavior changes. (A root `npm run build` is the
same idea and worth having, but is deferred to TASK-045 - see Out of
scope.)

## Why this task exists
Root `package.json` currently declares exactly three scripts:

```json
"dev:web":    "npm run dev --workspace=apps/web",
"dev:mobile": "npm run start --workspace=apps/mobile",
"typecheck":  "npm run typecheck --workspaces --if-present"
```

There is no root `test` script. `npm test` at the repo root today
does nothing useful, even though `apps/web` has a real `test` script
wired to `node --test` with this repo's custom resolve loader
(`apps/web/scripts/register-loader.mjs`). That matters more than it
looks:

- `_SSoT/topics/TESTING_PROCESS.md` Layer 1 rule 2 says an available
  automated check "must be run, not just written." A check nobody can
  invoke from a predictable place gets skipped.
- Every Dev agent (Cursor, Claude Code) and the antfarm workflow's
  tester step land in the repo root, not in `apps/web`. A root-level
  canonical command is what they will actually reach for.
- `typecheck` already proves the `--workspaces --if-present` pattern
  works here; `test` is the same one-line pattern, just never added.

## Context
- npm workspaces monorepo: `apps/*` and `packages/*`. Members are
  `@thecoach/web`, `@thecoach/mobile`, `@thecoach/shared`.
- `apps/web` has `test`, `build`, `typecheck`. `apps/mobile` has
  `typecheck` only (Expo; no meaningful headless build). `packages/
  shared` has `typecheck` only.
- `--if-present` is what makes this safe across workspaces that have no
  such script - reuse it, do not add stub scripts to workspaces that
  genuinely have nothing to run.
- **Note on `apps/web`'s own `test` script:** it currently names a
  single file
  (`node --import ./scripts/register-loader.mjs --test app/api/health/route.test.ts`).
  Antfarm run #17 was going to change that to auto-discovery, but that
  run failed on 2026-08-25 before the change landed, so the script is
  still the single-file form. This task must **not** edit it either
  way - only the root aggregation. Making it auto-discover is worth
  doing, but as its own task, not smuggled into this one.
- `next build` currently fails on this repo (OQ-09 / TASK-024, the
  `/404` prerender React-version split). That failure is **expected**
  and is TASK-024's job, not this one. Adding a root `build` script
  that surfaces the existing failure is correct behavior; do not try to
  fix or paper over it here, and do not let it block this task.

## Read first
- root `package.json`
- `apps/web/package.json`, `apps/mobile/package.json`,
  `packages/shared/package.json`
- `apps/web/CONTRIBUTING.md` - the existing documented dev/build
  workflow this must stay consistent with
- `_SSoT/topics/TESTING_PROCESS.md` - Layer 1 and Layer 1.5

## Decisions already made (fixed - do not change)
- Stay on npm workspaces. Do not introduce turbo/nx/pnpm/lerna or any
  other task runner - this is a three-line scripts change, not a
  monorepo tooling migration.
- No new test framework. `node --test` is the runner.
- Do not add placeholder `"test": "echo no tests"` scripts to
  workspaces that have no tests; `--if-present` handles that.

## In scope
- Add to root `package.json`:
  - `"verify": "npm run typecheck && npm test"` (the one command a Dev
    agent or the developer runs before handing work off)
- Document `verify` in `apps/web/CONTRIBUTING.md` (or a root
  `CONTRIBUTING.md` if the Dev agent judges root is the better home for
  repo-wide commands - one location, and link from the other if both
  end up existing).
- **Root `test` no longer needs adding here** - it already exists
  (`"test": "npm run test:web && npm run test:tools"`, landed in PR #37,
  reset step 3, 2026-09-02). It covers `apps/web` + `tools/` - the only
  two places with tests today (`apps/mobile`/`packages/shared` have no
  test scripts), so nothing is lost versus the `--workspaces` form this
  task originally specified. Use it, don't re-add it.
- Report the real output of the new `verify` command in the handoff.

## Out of scope
- **Adding a root `build` script - deferred to TASK-045.** Two real
  attempts at this task (runs #19 and #23) both hit the pipeline's
  generic `test` step, which has no task context and treats any
  non-zero exit as a hard failure. The first attempt got past `verify`
  cleanly and then died at `test` on the pre-existing, out-of-scope
  OQ-09 `next build` /404-prerender failure this task's own spec
  already declares acceptable - a guaranteed collision, not a flake,
  because the `test` step cannot see that carve-out. Wiring a root
  `build` aggregator into that same generic step while OQ-09 stands
  makes every future attempt fail the same way. TASK-045 picks this up
  once TASK-011 (react-hoisting) and TASK-024 (OQ-09) have actually
  landed, at which point `next build` should exit 0 and the collision
  disappears on its own. Do not smuggle a `build` script back into this
  task before then.
- Any change to `apps/web`'s own `test` script (see the concurrent-work
  note above)
- Fixing the `next build` / OQ-09 failure - that is TASK-024
- Adding CI / GitHub Actions
- Adding lint tooling (none exists in this repo today; introducing it
  is a separate decision, not part of this task)
- Any app/UI/product code

## Expected files

### Likely modified
- root `package.json`
- `apps/web/CONTRIBUTING.md`

### Likely created
- possibly root `CONTRIBUTING.md` (only if the Dev agent moves the
  repo-wide command docs there)

### Protected - do not modify without flagging an Open Question
- `_SSoT/**` (never writable by Dev agent)
- `apps/web/package.json`, `apps/mobile/package.json`,
  `packages/shared/package.json` - workspace scripts stay as they are
- `package-lock.json` - a scripts-only change must not alter the
  lockfile; if it does, something else was changed too
- All application, migration and asset code

## Requirements
1. `npm test` from the repo root runs `apps/web`'s tests and reports
   their real result.
2. `npm run verify` from the repo root runs typecheck across all
   workspaces and then the tests, and fails fast if typecheck fails.
3. `npm run typecheck`, `npm run dev:web`, `npm run dev:mobile` behave
   exactly as before.
4. `package-lock.json` is unchanged.
5. No root `build` script is added - that is TASK-045, deliberately
   deferred (see Out of scope).

## Edge cases
- A workspace with no `test`/`build` script must be skipped silently by
  `--if-present`, not fail the run.
- `npm run verify` must fail (non-zero) if either stage fails - verify
  this by deliberately breaking a type in a scratch edit, confirming
  non-zero exit, then reverting.
- Running from a subdirectory is not required to work; document that
  these are root commands.

## Config/values involved
None.

## Test/verification requirements
- Run each of `npm test`, `npm run verify`,
  `npm run typecheck` from the repo root and paste the real output
  (truncated is fine, but real) in the handoff.
- Demonstrate `verify`'s non-zero exit on a deliberately broken type,
  then confirm the scratch edit is reverted and `git status` is clean
  apart from the intended changes.

## QA checklist (developer)
[ ] 1. From the repo root run `npm test` -> the web app's tests run and report pass/fail
[ ] 2. From the repo root run `npm run verify` -> typecheck runs, then tests run
[ ] 3. `npm run dev:web` still starts the app as before

## Acceptance criteria
- [ ] Root `test` and `verify` scripts exist and behave as described
- [ ] No root `build` script added (deferred to TASK-045)
- [ ] Real output of each reported in the handoff
- [ ] `verify` demonstrably fails on a broken typecheck
- [ ] No workspace `package.json` modified
- [ ] `package-lock.json` unchanged
- [ ] Commands documented in one clear place
- [ ] No unrelated files changed

## Branch
`fix/root-verification-entrypoints` - cut from `staging`, merged back
into `staging`. Never `main`, under any circumstance.

## Tool/model
Cursor
