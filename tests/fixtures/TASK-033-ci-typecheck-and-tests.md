# TASK-033: Add a GitHub Actions CI workflow (typecheck + tests on PRs into `staging`)

## Status
Ready

## Objective
Every pull request targeting `staging` runs typecheck and tests automatically, so "does
this break anything?" is answered by something other than the same agent that wrote the
change. Workflow file only. No deploy, no secrets, no product code.

## Why this task exists
`_SSoT/topics/TESTING_PROCESS.md` Layer 1.5 asks for a check that runs independently of a
Dev agent's own say-so. Today there is none: `ls .github/workflows` returns no such
directory, and OQ-14 records that real server-side branch protection is unavailable on
the current free plan (403 on the branch-protection API for both `main` and `staging`).
So the antfarm workflow's own client-side gates are the only safety net, self-reported by
the agent doing the work. A minimal CI job is the independent layer.

Approved by the developer on 2026-08-25 (was TODO-0005; the reservation was that it
spends Actions minutes on a private free-tier repo — accepted).

## Read first
- root `package.json` — has `typecheck`; `test`/`build`/`verify` are TASK-027's job
- `apps/web/package.json` — the only workspace with a real test script
- `_SSoT/topics/TESTING_PROCESS.md` — Layer 1 and Layer 1.5
- `_SSoT/OPEN_QUESTIONS.md` — OQ-14

## Decisions already made (fixed - do not change)
- GitHub Actions. No other CI provider.
- Triggers on `pull_request` targeting `staging` only. Not on push, not on `main`.
- No secrets, no deploy step, no hosted database, no Supabase credentials.
- Node version pinned to the repo's existing local version. Do not upgrade Node here.

## In scope
- `.github/workflows/ci.yml`: checkout, setup-node with npm cache, `npm ci`,
  `npm run typecheck`, then tests.
- A line in `apps/web/CONTRIBUTING.md` (or root CONTRIBUTING.md if TASK-027 created one)
  saying what CI runs and when.

## Out of scope
- Build (`next build` fails today on OQ-09 / TASK-024 — do not add a build step until
  that is fixed, and do not try to fix it here)
- Deploy, release, publish, coverage upload, lint tooling
- Branch protection rules (OQ-14 — unavailable on this plan)
- Any change to workspace `package.json` scripts (TASK-027 owns root scripts)
- Any app, migration or asset code

## Ordering note
If TASK-027 has already landed, invoke the root `npm test`. If it has not, invoke the web
tests directly via `npm test --workspace=apps/web`. Do **not** add root scripts here —
that is TASK-027's task, and doing it in both places will conflict.

## Expected files

### Likely created
- `.github/workflows/ci.yml`

### Likely modified
- `apps/web/CONTRIBUTING.md` (or root `CONTRIBUTING.md`)

### Protected - do not modify without flagging an Open Question
- `_SSoT/**` (never writable by Dev agent)
- root and workspace `package.json`
- `package-lock.json` — a workflow-only change must not alter the lockfile
- All application, migration and asset code

## Requirements
1. A PR into `staging` triggers the workflow; a PR into any other base does not.
2. The job fails when typecheck fails and when a test fails — proven, not assumed.
3. The job requires no repository secrets.
4. `npm ci` succeeds from a clean checkout.
5. No lockfile change.

## Edge cases
- A workspace with no test script must be skipped, not fail the job (`--if-present`).
- The job must not depend on `next build` succeeding.
- Actions minutes: keep it to one job on one OS, with npm caching on.

## Test/verification requirements
- Open a scratch PR into `staging` and paste the real run result (green).
- Push one commit that deliberately breaks a type; paste the red run; revert it.
- Paste the workflow YAML and confirm `git status` is clean apart from intended changes.

## QA checklist (developer)
[ ] 1. Open a PR into `staging` -> CI runs and passes
[ ] 2. Break a type on that PR -> CI goes red
[ ] 3. No secrets requested anywhere in the workflow
[ ] 4. A PR into a non-`staging` base does not trigger it

## Acceptance criteria
- [ ] `.github/workflows/ci.yml` exists, PR-into-`staging` only
- [ ] Green run and red run both demonstrated with real output
- [ ] No secrets, no deploy, no build step
- [ ] `package-lock.json` unchanged, no workspace `package.json` modified
- [ ] Documented in one place

## Branch
`feat/ci-typecheck-and-tests` - cut from `staging`, merged back into `staging`. Never
`main`, under any circumstance.

## Tool/model
Cursor
