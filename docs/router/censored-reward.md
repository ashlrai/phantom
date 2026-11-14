# Censored reward for the dispatch-log learner

## What happens today

The log-based learner (`src/core/routing/outcome-learning.ts`) is what `phm fleet outcomes`
and `phm select` read. The contextual bandit in `src/core/routing/bandit.ts` is a separate
store: `recordOutcome` (`bandit.ts:281`) has no caller in this tree, and
`outcome-learning.ts` only borrows the samplers from it (`outcome-learning.ts:15`). The
`impact / allowanceSpent` reward (`bandit.ts:237-249`) is therefore not what steers fleet
routing today. The learner's own score is
`meanSuccess x meanCheapness` (`outcome-learning.ts:537-571`), and the Thompson draw uses
`Beta(1 + goodMerges, 1 + attempts - goodMerges)` (`outcome-learning.ts:574`).

How each PR state moves that posterior:

| State | Effect | Where |
| --- | --- | --- |
| merged | `attempts + 1`, `goodMerges + 1` unless it broke main | `fold`, `case 'merged'` |
| closed unmerged | `attempts + 1`, no success: a failure | `fold`, `case 'closed'` |
| dirty | `attempts + 1`, no success, counted in `dirty` | `fold`, `case 'dirty'` |
| open, no outcome event | nothing. The assignment sits in the `open` map and is never read again | `fold`, `open.set` / `open.get` |

So closed and DIRTY PRs are already failures, if the dispatcher writes an `OUTCOME` line
for them. The hole is the last row. A PR that is opened and then rots (conflicting, never
reviewed, never closed) produces an `ASSIGN` and no `OUTCOME`. Its lane keeps a cold or
flattering posterior: with no cell at all, the lane draws from the uninformative prior and
is explored again. Open-but-never-merged work is missing data, not a failure.

In the bandit store the same hole exists one level up: nothing records an outcome until a
caller does, so an unresolved arm is simply never updated.

## The rule

An assignment is **pending** until it resolves. Fix a horizon `H`.

- Resolved before `H` (merged, closed, dirty, fix-up): scored exactly as today.
- Unresolved and older than `H`: **censored**. It counts as one attempt with no success
  and a spent allowance.
- Unresolved and younger than `H`: stays pending, invisible, as today.

In plain English: a PR that has had more time than any normal merge needs, and has not
merged, is a miss. A PR that is still within normal merge time is not judged yet.

The censored attempt adds one to the failure side of the Beta posterior, which lowers the
lane's mean success from `(1 + g) / (2 + a)` to `(1 + g) / (2 + a + k)` for `k` censored
attempts. It does not touch `goodMerges`, `merges`, time to merge, or any merged PR's
score.

### Allowance spent

The allowance a stranded PR consumed is unknown. Charging it zero would make a lane that
produces rotting PRs look cheap, and `meanCheapness` would reward it. Instead each censored
attempt is charged the mean usage of its cell's finished attempts, or the fleet mean when
the cell has none. That leaves the cell's mean usage unchanged and gives the failure a real
cost denominator.

### Horizon

`H = max(24 h, 2 x p95 minutes-to-merge of merged jobs in the log)`, nearest rank. Merge
latency is a property of the queue, so `H` follows it: a slow queue gets a longer horizon.
Twice the 95th percentile means a PR has had twice as long as nearly every merge took.
The 24 h floor covers a young or empty log.

The merge-latency distribution from GitHub could not be pulled while writing this (the
`gh` CLI could not read its config in the sandbox), so the 24 h floor is a conservative
starting point, not a measured value. The task evidence says 89 of the newest 117 open PRs
are conflicting, which is consistent with any horizon from a day up. Check the value
against `phm fleet outcomes` once the flag is on, or pin it with `censorHorizonHours`.

### Late resolution

Censoring is recomputed from the log on every read. If a censored PR later merges, its
`OUTCOME` line arrives, the assignment is no longer open, and it is scored as a normal
merge. Nothing is stored, so there is nothing to undo.

## Config

Off by default, so existing routing is unchanged:

```json
{ "router": { "censorUnmerged": true, "censorHorizonHours": 48 } }
```

- `router.censorUnmerged`: must be exactly `true`.
- `router.censorHorizonHours`: optional, positive. Absent or invalid uses the derived `H`.

`phm fleet outcomes` and `phm select` read the config read-only. The cell view gains a
`censored` count (included in `attempts`), and the sentence for a cell mentions it when
nonzero.

## Not covered

- `bandit.ts` itself is unchanged. When a caller starts recording arm outcomes, a PR past
  `H` should be recorded with `recordOutcome(..., { merged: false, allowanceSpent })`, which
  is already reward 0 with the allowance charged.
- The log has no event for a PR that closed unmerged without an `OUTCOME` line. Those are
  censored once they pass `H`, the same as any other stranded assignment.
