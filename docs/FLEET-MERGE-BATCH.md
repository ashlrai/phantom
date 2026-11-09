# Merge-batch planner

Run `phm fleet merge-batch --json`. The command plans open-PR merge batches
from a snapshot of the pull-request list — it never calls `gh` itself, never
rebases, and never merges. It is the read-only half of the merge-treadmill
answer: when ~180 open bridge PRs keep invalidating each other as main moves,
this says which can land in any order and which must serialize.

## Input

The snapshot is one `gh pr list --json number,title,url,headRefName,isDraft,mergeable,mergeStateStatus,createdAt,updatedAt,files` page in any of three wire shapes, resolved in this order:

1. `--input <file>` (`--input -` forces stdin)
2. piped standard input (a non-TTY stdin with no `--input`)
3. the state file `<root>/fleet/open-prs.json`, where `<root>` is
   `ASHLR_RUNS_DIR` or `~/.ashlr-runs` (`--root /absolute/path` overrides)

Accepted shapes: the raw `gh pr list` JSON array, a merge-backlog read
(`{v:1, items:[…]}`, the console's Merges-pane payload), and a
`fleet.pr-hygiene.v1` report. A scheduler can therefore snapshot whichever
read it already runs. Rows that do not describe a PR count as `unreadable`;
repeated PR numbers collapse to the first sighting (`duplicates`). A missing,
unreadable or malformed snapshot exits 1 with `input.state` set honestly —
never a fake-empty plan. `--repo <owner/name>` labels the plan when the
snapshot carries no repo; an envelope `repo` wins over the flag.

## What the plan means

Two open PRs conflict only when they share a file, so the file→PR index forms
an overlap graph. Its connected components are the batches:

- `independent` batches hold a single PR touching files nobody else touches —
  they merge in any order, concurrently, with any other batch.
- `serial` batches must serialize: merging one member moves main under every
  member that shares a file with it.

Inside a serial batch, `order` minimizes rebase churn. A PR that merges after
an overlapping one rebases once against the accumulated main, so the fewest
rebase events equals the members minus the largest set that can merge clean.
The clean `wave` is a greedy minimum-degree independent set over PRs that
could merge clean today (not draft, not conflicting, not BEHIND, file data
present); ties keep the largest file sets clean so cheap PRs pay the rebase.
The rebase wave follows, least-ready last. Within each wave the order is
FIFO by creation time, like a merge queue.

Per PR, `rebase` reads `none` (clean wave), `expected` (rebase wave), or
`already-required` (conflicted or BEHIND today — its sync is owed whatever the
order). `counts.expectedRebases` sums the budget across batches.

## Risk

Each serial batch carries `conflictRisk.score` (0..1) and `level`:

```
score = 0.45·(rebasesExpected/members) + 0.25·(conflicted/members)
      + 0.15·(edges/C(members,2))      + 0.15·min(1, topFileFanIn/3)
```

`high` ≥ 0.6, `medium` ≥ 0.3, else `low`. `reasons` are machine tokens
(`rebases:N`, `conflicted:N`, `dense-overlap:N-edges`, `hot-file-fan-in:N`).
`hotFiles` are shared files three or more members touch — tomorrow's
conflicts. Batches sort safest first; `order` at top level flattens the whole
plan into one serial sequence for consumers that do not parallelize.

## Limits

Advisory only — the plan grants no merge, rebase or close authority, and a
stale snapshot plans a stale backlog. A PR with no file data is batched
independently with `evidence: 'no-file-data'`: unmeasured, never
proven-disjoint. When the snapshot envelope's own read failed
(`input.upstream`, e.g. a `gh-failed` merge-backlog read) the command exits 1
— a plan built on a failed read is never a clean-looking answer. Exit codes:
0 plan produced, 1 no usable snapshot, 2 bad usage.
