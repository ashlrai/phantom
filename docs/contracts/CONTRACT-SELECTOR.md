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
  (`learnOutcomes`, the router from #2775), else 30 minutes and 0.3 usage.
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
