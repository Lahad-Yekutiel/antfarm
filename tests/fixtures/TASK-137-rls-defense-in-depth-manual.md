# TASK-137: RLS defense-in-depth — column-level grants and policy-column indexes

## Dispatch
manual

## Status
Ready

## Objective
Every trainer/trainee-scoped table gets two additive hardening passes
on top of its existing, unchanged RLS policies: (1) column-level grants
so a user can only ever write the columns they're supposed to, even if
a row-level policy would otherwise have allowed the write, and (2) a
btree index on every column an RLS policy filters by, so policy
evaluation stays fast as the trainer base grows. No policy logic
changes.

## Why this task exists
Researched 2026-08-26 (see `topics/SECURITY.md` decision 1) against
current Supabase RLS guidance: a row-level UPDATE policy that allows
"a trainee can update their own trainee row" is correct at the row
level but, without column grants, also lets that trainee overwrite
*any* column on that row — including `trainer_id`, which would let a
trainee reassign themselves to a different trainer, or fields that are
supposed to be trainer-locked per `topics/PERMISSIONS_MODEL.md`. Row
policies and column grants are different layers; this project has only
ever built the first. The same research flags unindexed policy columns
as the most common RLS performance mistake — cheap to fix now,
expensive to discover later at scale (relevant given
`OPEN_QUESTIONS.md` OQ-15's 1,000-trainer growth trigger).

## Context
- 14 migrations under `supabase/migrations/`. Policy definitions live
  mainly in `20260801120400_rls_policies.sql`, with related grant/view
  work in `20260801130000_fix_view_grants_default_privs.sql`.
- `topics/PERMISSIONS_MODEL.md` is the authority on which fields a
  trainee is allowed to edit on their *own assigned instance* data
  (weight always editable, others per the trainer's permission
  profile) — that logic is enforced today by the existing permission
  trigger (`20260801120500_permission_trigger.sql`), not by column
  grants. This task does not touch or replace that trigger; it adds a
  second, independent layer against columns nobody's permission model
  ever intended to be trainee-writable at all (ownership/foreign-key
  columns, internal flags), which the trigger was never scoped to
  cover.
- TASK-029 (RLS isolation test suite) may land before or after this. If
  TASK-029 is already merged, extend it with cases proving the new
  column grants; if not, still write and report manual verification
  (see Test/verification requirements) so this isn't unverified.

## Read first
- `_SSoT/topics/SECURITY.md` (new — decision 1)
- `_SSoT/topics/PERMISSIONS_MODEL.md` in full
- `supabase/migrations/20260801120400_rls_policies.sql`
- `supabase/migrations/20260801120500_permission_trigger.sql`
- `supabase/migrations/20260801130000_fix_view_grants_default_privs.sql`
- If it exists on this branch: `supabase/tests/rls/` (TASK-029's suite)

## Decisions already made (fixed — do not change)
- **No row-level policy changes.** This task adds column grants and
  indexes only. If a row policy itself looks wrong while doing this,
  report it as a finding — do not fix it here.
- **No changes to the permission trigger's logic.** Column grants are a
  hard floor beneath it, not a replacement for it.
- Pattern: `REVOKE ALL ON <table> FROM <role>; GRANT SELECT, INSERT,
  UPDATE (<explicit column list>) ON <table> TO <role>;` per the
  researched pattern — grant back exactly the columns that role should
  ever be able to write, nothing implied.
- New migration file(s), not edits to existing ones (this project's
  migrations are append-only, per the existing 14-file history — never
  edit a migration that's already landed).

## In scope
- Identify every trainer/trainee-scoped table with an UPDATE or INSERT
  RLS policy (start from `20260801120400_rls_policies.sql`).
- For each, determine the columns that role should never be able to
  write directly (ownership/foreign-key columns like `trainer_id`,
  `owner_trainer_id`; any system-managed column like `created_at`,
  `id`) versus the columns it legitimately edits, cross-checked against
  `topics/PERMISSIONS_MODEL.md` for trainee-side fields specifically.
- New migration(s) applying `REVOKE`/`GRANT (columns)` per table/role.
- New migration adding a btree index on every foreign-key/ownership
  column an RLS policy's `USING`/`WITH CHECK` clause filters on
  (`trainer_id`, `trainee_id`-style columns) that doesn't already have
  one — check existing migrations first, don't duplicate an index that
  exists.
- A short written list, in the handoff, of every table/role/column
  decision made — this is the kind of decision a future reviewer needs
  to be able to audit without re-deriving it.

## Out of scope
- Row-level policy logic changes
- The permission trigger's logic
- Any application code change (the app should keep working unchanged —
  if it doesn't, that reveals the app was relying on write access it
  shouldn't have had, which is itself a finding to report, not silently
  work around by granting more than intended)
- New tables or schema changes beyond grants/indexes

## Expected files

### Likely created
- `supabase/migrations/<timestamp>_column_grants_hardening.sql`
- `supabase/migrations/<timestamp>_rls_policy_indexes.sql`

### Protected — do not modify without flagging an Open Question
- `_SSoT/**`
- All 14 existing migration files — read-only, never edited in place
- All `apps/**` application code (report, don't fix, if the app breaks)

## Requirements
1. Every RLS-policy-bearing table has explicit column grants for
   `authenticated` (and any other relevant role) — no table relies on
   the pre-existing implicit "all columns" grant.
2. Every FK/ownership column referenced in a `USING`/`WITH CHECK`
   clause has a btree index (verified by `\d <table>` or the JS
   client's equivalent — real output, not assumed).
3. The app's existing functionality is unchanged: run through
   Exercises/Workouts/Trainees CRUD, favorites, and (if it exists on
   this branch) TASK-029's suite, and confirm nothing that used to work
   now fails.
4. At least one deliberate negative check per table: attempt to update
   a column that was NOT granted back (e.g. try to change a trainee's
   `trainer_id` as that trainee) and confirm it's now rejected where it
   previously would have succeeded — proving the hardening actually
   changed something, not just that migrations ran.

## Edge cases
- A column intentionally writable by more than one role (e.g. both
  trainer and trainee can write `weight` on a trainee-level override,
  per `PERMISSIONS_MODEL.md`) needs to appear in both roles' grant
  lists, not just one.
- Views built over these tables (see `20260801130000_...`) inherit
  grants differently than base tables — check whether `security_invoker`
  is already set (PG 15+) so views actually respect the underlying
  table's RLS/grants rather than silently bypassing them; report if
  not, as a separate finding, without changing it unasked.
- A column with no explicit grant is now fully inaccessible for writes
  by that role — confirm every column the app's UI actually needs to
  write is on some role's grant list before calling this done; a column
  missed here breaks a real feature.

## Config/values involved
None — pure SQL migrations, no secrets or config keys.

## Test/verification requirements
- Real `\d <table>` (or Supabase Studio's table inspector) output
  showing grants, before and after, for at least 2–3 representative
  tables in the handoff.
- Real query-plan (`EXPLAIN`) showing index usage for at least one
  policy-filtered query, before and after.
- The negative-check results from Requirement 4, pasted real.
- Full manual click-through of the app confirming no regression, or
  TASK-029's suite passing if it's already on this branch.

## QA checklist (developer)
[ ] 1. Use the app as a trainer — everything (Trainees/Workouts/Exercises CRUD, favorites) works exactly as before
[ ] 2. Use the app as a trainee — edit an unlocked field, confirm it still saves; confirm a locked field is still rejected, same as before
[ ] 3. Read the handoff's negative-check section → it shows a write that used to silently succeed now being rejected

## Acceptance criteria
- [ ] Column grants applied per table/role, documented per table
- [ ] Indexes added on every policy-filtered FK column
- [ ] No app regression, verified live
- [ ] At least one real negative check per table proving the hardening works
- [ ] No row policy or trigger logic changed
- [ ] No secrets, no `_SSoT/**` changes

## Branch
`feature/rls-defense-in-depth` — cut from `staging`, merged back into
`staging`. Never `main`.

## Tool/model
`Claude Code` — per `topics/TOOLING.md`'s two-tier model, this touches
RLS/grants directly, which that file names explicitly as a
Claude-Code-routed case ("touching RLS policies").
