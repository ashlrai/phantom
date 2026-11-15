# Spec: one minted attempt identity (RQ-VN-ATTEMPT-ID)

Rank 1 in the [vision-next roadmap](../VISION-NEXT.md#ranked-moves). This is
an implementable specification, not shipped behavior. The canonical job record
is `RQ-VN-ATTEMPT-ID` in the [move manifest](vision-next.json).

## Problem

`~/.ashlr-runs/metrics/jobs.jsonl` is append-only and keyed by job ID. One job
ID can launch many times: retries, recuts and refixes. No row says which launch
it belongs to. Every consumer rebuilds attempt boundaries from row order:

| Consumer | Current inference |
| --- | --- |
| `contrib/mac/dispatchd.py` reap section | A `launch` row resets `_attempts[job]`; MERGED outcomes are matched by PR URL because they may arrive after a later launch |
| `contrib/mac/batcher.py` | Publish detection by `job` plus `url` |
| `src/cli/fleet-wt-reap.ts` | A `launch` row deletes the latest terminal state for that ID |
| `src/cli/fleet-worktree-stale.ts` | A `launch` row starts a new `{ merged, urls }` entry |
| `src/core/fleet/wt-audit.ts` | Its own `launch` handling |

Publish rows also come in two dialects: `{event: "publish", job, url}` and
`{outcome: "PUBLISHED", jobId, prUrl}`. The reconciler in
`contrib/mac/metrics-outcomes` copies the published row into its MERGED or
CLOSED row. About six REAP-series jobs in the last 200 commits each fixed one
edge of this inference: late outcomes, concurrent removal, PR-URL matching and
launch boundaries. More than 120 source files read the ledger, each with its
own field aliases.

## Design

### Identity

At the point where `dispatchd.py` writes its `launch` metric, it mints
`attemptId = "<job>~<UTC yyyymmddThhmmssZ>~<8 hex random>"`. The value:

- is unique without a counter file, so concurrent dispatchers cannot collide;
- sorts by launch time within a job;
- contains no path, host or account data.

The launch row gains `"attemptId"`. The dispatcher exports
`ASHLR_ATTEMPT_ID` into the spawned worker's environment, next to the existing
job variables.

### Propagation

- **finish:** `dispatchd.py` already knows the job it is finishing. It writes
  the attempt ID recorded in that job's run marker
  (`<RUN>/<job>.attempt`, written at launch next to `.dispatched`).
- **publish:** both publish dialects add `attemptId` from
  `ASHLR_ATTEMPT_ID`. The writer that emits the publish row records it when
  present and omits it otherwise; omission is never an error.
- **outcome:** `metrics-outcomes` already copies the published row, so
  reconciled outcomes inherit `attemptId` with no reconciler change. Add one
  test that pins this.

### One fold, two languages

Add `src/core/fleet/run-attempts.ts`:

```ts
export interface RunAttempt {
  job: string;
  attemptId: string;            // minted, or `${job}~inferred~${ordinal}`
  identity: 'minted' | 'inferred';
  launchedAt: string | null;
  finished: boolean;
  prUrls: string[];             // normalized, no trailing slash
  terminal: 'MERGED' | 'CLOSED' | null;
  rows: number;                 // ledger rows attributed to this attempt
}
export interface RunAttemptFold { attempts: RunAttempt[]; dropped: number; unattributed: number }
export function foldRunAttempts(rows: Iterable<unknown>): RunAttemptFold;
export function currentAttempt(fold: RunAttemptFold, job: string): RunAttempt | null;
```

Attribution precedence, applied per row:

1. The row's `attemptId`, when it names a known launch.
2. The PR URL, for outcome rows: the attempt that published that URL. This
   preserves the existing protection against late outcomes.
3. Legacy inference: the most recent `launch` for the job at that row's
   position. The result is marked `identity: 'inferred'`.
4. Otherwise the row counts in `unattributed`, never in an attempt.

Add `contrib/mac/run_attempts.py` with the same fold. Both implementations are
tested against one corpus in `test/fixtures/run-attempts/`. Each case is a
`.jsonl` input with an `.expected.json` canonical fold, so the dispatcher and
the TypeScript readers cannot drift.

### Migration

Move each consumer in the table above to the shared fold, one consumer per
reviewable change. Keep each consumer's existing tests unchanged; they are the
regression oracle. Existing rows are never rewritten. Rows without
`attemptId` keep today's behavior through rule 3.

## Fixture corpus (minimum)

| Case | Expectation |
| --- | --- |
| Single launch, finish, publish, MERGED | One minted attempt, terminal MERGED |
| Relaunch, then a late MERGED for the first PR URL | The first attempt is MERGED; the current attempt is open |
| Two publishes in one attempt (refix) | Both URLs on that attempt |
| Outcome with `attemptId` for an unknown launch | `unattributed` incremented; no attempt changed |
| Legacy rows only (no `attemptId`) | Same boundaries as today; `identity: 'inferred'` |
| Mixed legacy then minted for one job | Inferred attempts precede the minted one; no merge between them |
| Both publish dialects | Same URLs attributed |
| Malformed JSON lines | Counted in `dropped`; fold continues |

## Acceptance

- The fixture corpus folds identically, as canonical JSON, in TypeScript and
  Python.
- `fleet-wt-reap`, `fleet-worktree-stale` and `wt-audit` keep their current
  test suites green after migration, with no test edited to pass.
- A late outcome after a relaunch never completes the newer attempt.
- No ledger row is rewritten, and no consumer treats an inferred identity as
  minted.

## Validation

```bash
npx vitest run test/fleet-run-attempts.test.ts
python3 -m unittest discover -s contrib/mac/tests -p 'test_run_attempts.py'
npx vitest run test/fleet-wt-reap*.test.ts test/fleet-worktree-stale*.test.ts test/fleet-wt-audit*.test.ts
node scripts/verify-changed.mjs
```

## Boundaries

- Host scripts under `contrib/mac` are not live until their Security re-pin
  ([contrib/mac/README.md](../../contrib/mac/README.md)).
- No new authority, spend or ledger location. The attempt ID is not a secret
  and contains no identity data.
- Out of scope: yield accounting (RQ-VN-YIELD) and routing changes
  (RQ-VN-ROUTING). This move only makes attribution exact.
