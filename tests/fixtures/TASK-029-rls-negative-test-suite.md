# TASK-029: RLS isolation test suite, local stack

**This is a fixture, not a real task file.** It exists so the `029-*` cases in
`--self-test-task-contract` can prove the `## Tool/model` gate refuses a
`Claude Code` task, without depending on what TheCoach's live
`_SSoT/tasks/TASK-029-rls-negative-test-suite.md` happens to say on any given
day.

Those cases used to read the live file. On 2026-09-01 that file gained a
`## Dispatch: manual` line (TODO-0013), which refuses the task one gate
*earlier* — `not-dispatchable-manual`, before `## Tool/model` is ever
consulted. The refusal was correct; the cases went red anyway, and stopped
proving anything about the Tool/model gate. Trimmed to the four contract
sections the gate actually reads, and deliberately carries **no `## Dispatch`
section**, so the Tool/model gate is the first one that can fire.

The live task file keeps its `## Dispatch: manual`; that path is covered
separately by `TASK-137-rls-defense-in-depth-manual.md`.

## Status
Ready

## Objective
Prove, against a local Supabase stack, that a signed-in trainer can read only
its own rows: for every policy-bearing table, one positive case (trainer A
sees its own row) and one negative case (trainer A cannot see trainer B's).

## Branch
`feature/rls-isolation-tests` - cut from `staging`, merged back into
`staging`. Never `main`, under any circumstance.

## Tool/model
`Claude Code` - per `topics/TOOLING.md`'s two-tier model this is
security-boundary work spanning RLS policies, auth and triggers, which that
file routes to the Specialist rather than the Lead. It is also the case most
likely to produce a test that passes for the wrong reason, which is exactly
the failure mode the Specialist tier exists to catch.
