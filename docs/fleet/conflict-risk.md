# Fleet conflict-risk — proactive conflict predictor

`ashlr fleet conflict-risk [--repo <owner/name>]... [--next <n>] [--limit <n>] [--merged-limit <n>] [--window-hours <n>] [--json]`
predicts which open pull requests will conflict with the next `--next`
predicted merges, and emits a `fleet.conflict-risk.v1` report for the rebase
scheduler: PRs scored `high` carry `rebaseRecommended`, so they can be
rebased before their turn instead of recut after a dirty merge. It is
read-only: the only GitHub calls are two bounded `gh pr list` reads (open and
merged) — it never rebases, merges, queues or writes.

## The heuristic

- **Predicted merges.** The fleet backlog planner's order — green-ready PRs
  first, then `behind` (base moved, clean re-verify), then non-draft pending
  PRs — oldest-waiting inside each tier. The first `--next` of them are the
  merge window. Conflicted, red-required, draft, closed and undescribed PRs
  are never predicted merges.
- **File overlap.** A predicted merge threatens an open PR when they share at
  least one literal repo path. A window member is threatened only by merges
  at earlier positions — a merge after its own turn cannot break it first.
- **Recency.** A shared path the base already rewrote inside the hot window
  (a merged PR touched it there) weighs double: the open PR is already stale
  on that path and another merge is incoming.
- **Score.** Each threatening merge contributes likelihood
  `min(1, (hot*2 + cold) / 4)`; the PR's score is `1 - Π(1 - likelihood)` —
  every predicted merge rolls the dice on it. Bands: `high` ≥ 0.6,
  `medium` ≥ 0.3, `low` > 0, `none` = 0. Only `high` sets
  `rebaseRecommended`.
- **Velocity.** Merges per hour over `--window-hours` (default 6), measured
  on the merged-PR page first (every merge churns the base, fleet or human),
  falling back to the fleet jobs ledger's `MERGED` outcomes. Velocity turns
  the window into a horizon (`horizonHours = next / mergesPerHour`) and sizes
  the hot window; when velocity is unknown the horizon is null and the hot
  window falls back to 24 h.

PRs already conflicting (`mergeable: CONFLICTING` or
`mergeStateStatus: DIRTY`) are listed under `conflicting`, not scored — they
are recut candidates, not rebase candidates.

## Usage

```sh
phm fleet conflict-risk --json                    # predict on ashlrai/phantom
phm fleet conflict-risk --repo org/repo --next 8  # another repo, deeper window
phm fleet conflict-risk --repo a/b --repo c/d     # several repos, one report
```

Defaults: `--repo ashlrai/phantom`, `--next 5` (1–32), `--limit 200` open PRs
(max 1000), `--merged-limit 50` merged PRs (max 200), `--window-hours 6`
(1–168). Exit codes: 0 every repo's reads completed, 1 any failed or
truncated leg, 2 bad usage.

## Report shape (`fleet.conflict-risk.v1`)

    { schema: 'fleet.conflict-risk.v1', v: 1, generatedAt,
      params: { next, limit, mergedLimit, windowHours },
      repos: [{ repo, source: 'ok' | 'open-failed' | 'truncated',
                reason?,                  // fixed token on open-failed
                complete,                 // false when the open page filled
                reads: { open: 'ok' | 'failed',
                         merged: 'ok' | 'failed',
                         ledger: 'ok' | 'unavailable' | 'skipped' },
                velocity: { source: 'merged-page' | 'ledger' | 'unavailable',
                            windowHours, merges, mergesPerHour, truncated },
                horizonHours,             // null when velocity unknown
                hotWindowHours, next,
                nextMerges: [{ number, position, tier: 'ready' | 'behind' | 'pending', files }],
                conflicting: [{ number, headSha }],
                risks: [{ number, title, headSha, position, files,
                          score, band: 'high' | 'medium' | 'low',
                          rebaseRecommended,          // true only on 'high'
                          conflictByPosition,         // earliest threatening merge
                          threats: [{ number, position,
                                      shared,          // ≤ 8 paths
                                      sharedTotal, hot }] }],
                risksOmitted,
                counts: { open, unreadable, predicted, conflicting,
                          high, medium, low, none },
                note }] }

`risks` is sorted by score, then merge position — the scheduler reads it
top-down. `conflictByPosition` is the deadline: the earliest predicted merge
that threatens the PR.

## Evidence honesty

- A failed open read still emits the versioned shape with
  `source: 'open-failed'` and an empty risk list — never a fake-clean report;
  gh's stderr is not echoed.
- A failed merged read (`reads.merged: 'failed'`) drops the hot/recency
  evidence and the merged-page velocity, but overlap scoring still runs —
  every shared path just weighs cold.
- An unreadable jobs ledger (`reads.ledger: 'unavailable'`) only removes the
  velocity fallback.
- `gh pr list` returns at most ~100 files per PR and nothing about diff
  regions: file overlap is a necessary-but-insufficient signal, a heuristic
  ranking for scheduling — not a measured conflict probability.
- Rows gh could not describe are counted in `counts.unreadable`, not dropped;
  a full open page reports `source: 'truncated'`, `complete: false`.

The report grants no rebase, merge or dispatch authority; consumers re-read
the exact head and pass existing gates before acting.
