# Learning promotion evaluation

`routing.ts` contains synthetic held-out routing decisions used by
`test/learn-eval-gate.test.ts`. They test promotion mechanics, not production
model quality. They require no provider, credentials, network or spend.
The PR 1115 replay helper is not present in this checkout.

`promoteWithEval` in `src/core/learn/eval-gate.ts` accepts a prior, prompt or
playbook candidate, its baseline, a held-out task set, a replay scorer and an
authorized apply callback. The same scorer runs against fresh copies of each
task and each arm. Scores must be finite numbers from zero to one, with higher
being better. Every task must score at least as well as its baseline; ties
qualify and aggregate gains cannot conceal regressions. Missing evidence,
duplicate task IDs, invalid scores and evaluator errors block application.

Production callers must supply representative tasks withheld from candidate
construction and a trusted scorer that actually exercises the proposed change.
No runtime code imports these test fixtures. The apply callback must preserve
existing authorization checks and atomically compare the candidate's
`baseRevision` with the active revision before persisting the evaluated value.
Return false on a stale revision; throw only if no change was applied. This
helper is an additional quality gate, not harness adoption or merge authority.

The gate appends metadata and rejection reasons to
`~/.ashlr/learn/eval-gate.jsonl`. Candidate contents, task inputs and exception
messages are excluded. A successful evaluation is logged before application;
a promoted record follows successful application. Audit failures throw. If
the final audit append fails after application, callers must inspect their
store before retrying. Revision comparison prevents blind duplicate adoption.
