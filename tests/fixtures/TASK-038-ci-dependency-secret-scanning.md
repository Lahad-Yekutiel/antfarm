# TASK-038: Dependency updates and secret scanning in CI

## Status
Ready

## Objective
Two independent safety nets exist that don't depend on a human
remembering to check: Dependabot opens PRs for outdated/vulnerable
dependencies, and every PR is scanned for accidentally-committed
secrets before it can look "green."

## Why this task exists
Researched 2026-08-26 (`topics/SECURITY.md` decision 4) as a natural
extension of TASK-033's CI work: TASK-033 added typecheck+tests on PRs
into `staging`, closing part of `topics/TESTING_PROCESS.md` Layer 1.5's
"independent check" gap. It didn't cover two other common, low-effort/
high-value classes of risk: dependencies drifting out of date/
vulnerable, and a key or token getting committed by accident (this
project already has an explicit no-API-key rule in `topics/TOOLING.md`
for the Dev-agent environment — this task is the equivalent backstop
for what actually lands in git).

## Context
- `.github/workflows/ci.yml` exists as of TASK-033 (typecheck + tests,
  PR into `staging` only, no secrets, no deploy). This task adds to
  that same CI surface, consistent with its constraints.
- OQ-14 (GitHub plan/branch protection) is unrelated and separately
  tracked in `ROADMAP.md` Phase 14 — this task does not depend on it
  and does not touch branch protection.
- Free-tier GitHub repo, private — Dependabot alerts/version-updates
  are free on all plans; a secret-scanning *action* (e.g. gitleaks) run
  via GitHub Actions is also free and does not require GitHub Advanced
  Security (a paid feature for private repos) — use the Actions-based
  approach, not the paid built-in secret scanning product.

## Read first
- `.github/workflows/ci.yml` (from TASK-033)
- `_SSoT/topics/SECURITY.md` (new — decision 4)
- `_SSoT/topics/TOOLING.md` — "Cost rules" (no API keys ever committed —
  this task is the automated check for that rule)

## Decisions already made (fixed — do not change)
- Dependabot via `.github/dependabot.yml` — version updates for npm
  (root + each workspace if they have independent lockfiles — confirm
  actual structure), weekly cadence, grouped minor/patch updates to
  avoid PR spam. Security-relevant updates are not batched/delayed.
- Secret scanning via a GitHub Actions step (gitleaks or an equivalent
  actively-maintained action) added to the existing CI workflow or a
  new one — not GitHub's paid secret-scanning product.
- No secrets required for either — both run against the repo's own
  content.
- Do not touch TASK-033's typecheck/test job itself; add alongside it.

## In scope
- `.github/dependabot.yml` — npm ecosystem, correct directory/
  directories for this monorepo's actual workspace layout, weekly,
  grouped.
- A secret-scanning step/job in Actions, triggered on the same PRs
  TASK-033 already covers (into `staging`) plus ideally a full-history
  scan run once manually and reported (not scheduled — a one-time check
  that nothing already in git history is a live secret).
- Document both in `apps/web/CONTRIBUTING.md` (or wherever TASK-033/027
  already established root-level docs), matching their existing
  pattern.

## Out of scope
- GitHub Advanced Security / paid secret scanning
- Branch protection (OQ-14, Phase 14 — separate)
- Auto-merging Dependabot PRs — every PR still gets reviewed like any
  other change; this task only makes the PRs appear
- Fixing any secret the one-time history scan finds — if it finds one,
  stop and report it immediately as its own urgent item (see
  Requirements), do not attempt remediation inside this task

## Expected files

### Likely created
- `.github/dependabot.yml`
- `.github/workflows/secret-scan.yml` (or added as a job to the
  existing `ci.yml` — either is fine, document which)

### Likely modified
- `apps/web/CONTRIBUTING.md` (or root, matching TASK-027/033's choice)

### Protected — do not modify without flagging an Open Question
- `_SSoT/**`
- `.github/workflows/ci.yml`'s existing typecheck/test job — additive
  only, do not remove or weaken it

## Requirements
1. Dependabot config validates (GitHub's own UI/PR shows it recognized,
   or `dependabot.yml` schema-validated locally if a validator is
   available).
2. Secret-scan job runs on a real PR and reports pass/fail — demonstrate
   with a scratch PR, same pattern TASK-033 used.
3. **Run the one-time full-history scan and report the real result in
   the handoff — clean or not.** If it finds anything that looks like a
   real secret, stop, do not paste the secret value itself in plain
   text in the handoff (report *that a finding exists and its
   file/line*, not the value), and flag it to the Architect immediately
   as urgent — this could mean the Supabase project's local dev keys
   (already known non-secret per `DEV.md`) or, worse, something real.
4. No lockfile changes, no dependency version bumps as part of this
   task itself — only the scanning infrastructure.

## Edge cases
- The monorepo's actual lockfile layout (single root lockfile vs.
  per-workspace) determines Dependabot's directory config — check
  before writing it, don't assume.
- A false-positive secret match (e.g. a UUID or the known-non-secret
  local Supabase anon key in `.env.example`) should be allow-listed
  explicitly (gitleaks supports this), not cause the job to be
  weakened generally.

## Config/values involved
None new. If the local Supabase anon key appears in `.env.example` and
trips the scanner, allow-list that specific known-non-secret value
explicitly (per `DEV.md`: "Local keys are shared, non-secret
defaults").

## Test/verification requirements
- Real Dependabot PR (or confirmed schema validation) shown in handoff.
- Real scratch-PR CI run showing the secret-scan job passing.
- Real one-time full-history scan output (redacted if anything real is
  found, per Requirement 3).

## QA checklist (developer)
[ ] 1. Check the repo's Insights → Dependabot tab → configuration recognized, alerts/PRs enabled
[ ] 2. Open a scratch PR into `staging` → the secret-scan job runs and shows green
[ ] 3. Read the handoff's full-history scan result → confirms clean, or names an urgent finding to act on immediately

## Acceptance criteria
- [ ] `dependabot.yml` present and valid for this repo's actual layout
- [ ] Secret-scan job runs on every PR into `staging`, demonstrated green on a real PR
- [ ] One-time full-history scan run and result reported
- [ ] TASK-033's existing job unmodified/unweakened
- [ ] Documented in CONTRIBUTING.md

## Branch
`feature/ci-dependency-secret-scanning` — cut from `staging`, merged
back into `staging`. Never `main`.

## Tool/model
`Cursor` — routine CI/config work, no RLS/auth/product logic touched.
