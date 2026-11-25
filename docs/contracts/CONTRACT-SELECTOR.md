# Selector

Status: source-complete. A standing ranker above the job queue. It reads
candidates, scores them with what the dispatch log has learned, and funds the
top few as `READY` lines. Source: `src/core/routing/selector.ts`; CLI:
`src/cli/select.ts`.

## Score

`score = value x leverage / (minutes + usage x 60)`

- `value` and `leverage` come from the candidate. `leverage` defaults to 1.
- `minutes` and `usage` come from the candidate (`estMinutes`, `estUsage`), else
  from the outcome-learning cells for the same repo and job type
  (`learnFleetOutcomes` over the dispatch log and the jobs ledger —
  `<runs-dir>/queue/dispatch-events.log` and `<runs-dir>/metrics/jobs.jsonl`,
  `--events`/`--ledger` override — the same fold `phm fleet outcomes` reads),
  else 30 minutes and 0.3 usage.
  The usage prior pools only measured allowance-unit readings
  (`usageAllowance`/`usageAllowanceKnown`): jobs-ledger `tokens_total` is a
  different unit and never enters the `estUsage`-calibrated denominator, so a
  ledger-only fleet falls back to the default usage rather than a token count.
  Each pick reports which one it used as `basis`.
- `predictedValue = value x leverage x merge rate`, where merge rate is the
  smoothed good-merge rate of the same cells (prior 0.5, weight 2). It is what
  funding the pick is expected to return, and is what the picks log records so
  a later run can compare it with the real outcome.

Ties break by id. There is no tuning setting.

## Candidates

`<runs-dir>/selector/candidates.jsonl`, one object per line: `id` (`RQ-*`),
`scope`, `repo`, `value` (> 0), and optional `acceptance`, `jobType` (default
`work`), `pool` (default `claude`), `tier` (default `work`), `priority`
(`P0`..`P3`, default `P2`), `leverage`, `estMinutes`, `estUsage`. A malformed or
duplicate row is counted as `rejected`, never fatal. Scope and acceptance are
untrusted text: control characters and parentheses are removed so a candidate
cannot add fields, jobs, or dependencies to the line it produces.

A candidate row may also carry `friction_id` (a ledger id): the READY line
names `friction_id=<id>` in its attr group and the picks log records
`frictionId`. `--friction` points at the ledger (default
`~/.ashlr/friction-ledger.jsonl`): its top open items join the pool as
`RQ-FRICTION-<sha256-24>` candidates after each run absorbs PSEL-4 noop
churn from `<runs-dir>/queue/noop-streak.json`. A closed item is reopened
by nothing automatic; only the pick grader's 7d grade closes it.

## Grading

Every non-dry `phm select` pass ends by grading funded picks against
`<runs-dir>/metrics/jobs.jsonl` (`src/core/fleet/pick-grade-sync.ts` calling
`src/core/fleet/pick-grader.ts`). Each pick is graded 24h and 7d after its
`at`: `merged` is a held MERGED verdict — a MERGED-resolved row whose
mergedAt-preferring stamp lands inside `[at, at + window]` with no newer
positive revert evidence — and `used` is in-window publish/PR-url evidence;
a held merge implies used. `stars`/`installs` have no per-pick channel in
the jobs ledger, so they stay unmeasured and the realized blend
renormalizes over merged+used. The grader's only feature is `mergeRate`,
the recorded smoothed merge prior — the sole calibrated [0,1] probability
the picks log stores; `score`/`predictedValue` are unbounded value-scale
products and `minutes`/`usage` unsigned estimates, so they stay out of the
weight model. Grades append to `~/.ashlr/picks/grades.jsonl`, the SGD weight
step to `~/.ashlr/picks/weights.json` (advisory; nothing routes on it yet),
and a 7d grade with realized >= 0.5 closes the pick's `friction_id` ledger
item with reason `grader-7d` — the only automatic close. A pick whose
window starts before the retained jobs tail's first dated row defers rather
than scoring a partial window as a miss, so picks older than the tail's
coverage stay ungraded. `--json` reports `grading` (`state`, `picks`,
`newGrades`, `frictionClosed`, `line`); text mode prints the accuracy line
on stderr. `--dry-run` grades nothing.

## Funding

`phm select` takes the top `--top` (default 5) candidates that are not already
in `picks.jsonl`, prints each as a `READY` line the queue importer reads
(`docs/QUEUE.md`), appends `{at, rank, id, repo, jobType, score, predictedValue,
mergeRate, minutes, usage, basis}` to `<runs-dir>/selector/picks.jsonl`, and posts
a `selector.picks` envelope (`from: selector`, `to: planner`, P2, one hour TTL)
to the local bus inbox. `--dry-run` writes and posts nothing. `--json` prints the
whole result including `bus` (the post status) and each pick's `ready` line.
The selector does not enqueue, claim, spend, or merge; a planner appends the
lines to the queue.

## Hourly on the Mac

`phm select schedule` previews the launchd agent `ai.ashlr.phm.selector`
(`StartInterval` 3600, runs `phm select --json`); `--write` installs the plist
and prints the `launchctl bootstrap` command. It does not load it.
