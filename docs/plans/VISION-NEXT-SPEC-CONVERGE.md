# Spec: backlog convergence (RQ-VN-CONVERGE)

Rank 3 in the [vision-next roadmap](../VISION-NEXT.md#ranked-moves). This is
an implementable specification, not shipped behavior. The canonical job record
is `RQ-VN-CONVERGE` in the [move manifest](vision-next.json). It depends on
[attempt identity](VISION-NEXT-SPEC-ATTEMPT-ID.md) and
[landed intent](VISION-NEXT-SPEC-LANDED-INTENT.md).

## Problem

Two admission controls exist, and neither shrinks the backlog:

- **The daemon path:** `src/core/fleet/backpressure.ts` caps open fleet PRs at
  3 per repo and pauses production while the verifier is behind.
- **The bridge path:** `contrib/mac/restock.py` parks Phantom rows as
  `PARKED-MERGERATE.<lane>` while 150 or more PRs are open, and recovers parked
  rows as capacity frees.

About ten successive jobs (MERGEQUEUE, MERGEAGE, MERGEPARK, MERGEWAKE,
PARKWAKE, PARKLATENCY, PARKROOT8, PARKRECOVER and others) refined that gate's
wake, probe, reservation and ordering rules. The backlog stayed above the
threshold anyway:

- The [triage](https://github.com/ashlrai/phantom/blob/master/.bridge-evidence/RQ-SWE3-PRTRIAGE-1-report.md)
  classed 170 of 236 open PRs as needing a rebase, 40 as mergeable after an
  update, 16 as superseded and 10 as needing the owner.
- Drain and recut waves add PRs while they work through the backlog.

The gate throttles on a count that the fleet's own repair work inflates. The
planners that know each PR's next step are each partial:

| Planner | What it does | Limit |
| --- | --- | --- |
| `pr-hygiene` | Flags stale, conflicted, overlapping and superseded PRs | Read-only |
| `rebase-plan` | Writes rebase jobs | Writes `ready.tsv` rows only |
| `merge-batch` | Groups mergeable PRs | Plans only |
| `superseded-close` | Closes PRs whose recut merged | Covers one proof type |

## Design

### One disposition per PR

Add `src/core/fleet/converge.ts`, a pure planner with no I/O:

```ts
export type Disposition =
  | { kind: 'merge'; pr: number; batch: string }
  | { kind: 'update'; pr: number }
  | { kind: 'rebase'; pr: number; job: string }
  | { kind: 'close-landed'; pr: number; receipt: LandedReceipt }
  | { kind: 'close-superseded'; pr: number; supersededBy: number }
  | { kind: 'owner'; pr: number; reason: string }
  | { kind: 'wait'; pr: number; reason: string };
export interface ConvergePlan {
  schema: 'fleet.converge.v1';
  dispositions: Disposition[];
  admission: Admission;
  unknown: number;
}
export function planConvergence(input: ConvergeInput): ConvergePlan;
```

`ConvergeInput` carries:

- the `pr-hygiene` items;
- the `merge-batch` and `rebase-plan` outputs;
- the superseded evidence;
- the landed receipts;
- the attempt fold;
- the hold list;
- a clock.

Rules, first match wins:

1. Hold-listed, draft or security-adjacent PRs get `owner`.
2. A PR with a current `landed` receipt gets `close-landed`. The receipt's
   head must equal the PR head and its base must be an ancestor of the current
   base tip.
3. A PR with a merged recut naming it gets `close-superseded`, the existing
   `superseded-close` proof.
4. A clean PR that is mergeable once updated gets `update`, then `merge` in
   its `merge-batch` group.
5. A conflicted PR with no rework attempt open gets `rebase`, using one
   `rebase-plan` job. The attempt fold proves no rework attempt is open.
6. A conflicted PR whose rebase attempt failed and that is older than
   `maxAgeHours` (default 48) gets `owner`, with reason
   `rebase-exhausted`. It is not closed without proof.
7. Anything with incomplete inputs gets `wait` and counts in `unknown`.

Every PR receives exactly one disposition. Close dispositions exist only with
a proof object. No rule merges a PR that has not passed its gate; `merge` means
enqueueing for the existing merge path, which applies the gates.

### Flow-based admission

Replace the fixed count threshold with measured flow over a window `W`
(default 6 hours), computed from the attempt fold and outcome rows:

```text
inflow  = PRs published in W
outflow = PRs merged or closed in W
admit producer work  iff  open <= softCap
                      or (outflow >= inflow and open <= hardCap)
```

- Repair work (rebase, update, close) is always admitted. Only new producer
  work is gated, matching the daemon backpressure principle that verification
  and landing keep going.
- Unknown or stale flow, meaning a ledger older than 10 minutes as today,
  closes admission for producers.
- `softCap` and `hardCap` start at today's operational values: 150, and an
  explicit higher ceiling set in config. Config can only tighten them.

### Apply path

Add `phm fleet converge [--json] [--apply]`, a thin handler over the core:

- **Dry run** is the default. It prints the plan.
- **`--apply`** executes dispositions one at a time through existing ledgered
  paths:
  - `superseded-close` for both close kinds, extended to accept a landed
    receipt as its proof;
  - the existing update and merge path for `update` and `merge`;
  - a `ready.tsv` append under the queue lock for `rebase`;
  - a Needs-you item for `owner`.
- Apply stops at the first failure. Each attempt is appended to
  `<runs>/queue/converge.jsonl`, matching the `superseded-close` ledger
  convention.
- The restocker reads the admission verdict from the latest `converge` plan
  instead of computing the count gate itself.

## Acceptance

- **One disposition each:** on the fixture backlog, every PR gets exactly one
  disposition, and no close disposition lacks a proof object.
- **Convergence:** a deterministic simulation replays 200 fixture PRs with
  fixture inflow and per-tick outflow. The backlog falls below `softCap`
  within a bounded number of ticks. Zero proofless closes are recorded, and
  producer admission reopens only after outflow meets inflow.
- **Stale proofs:** if the PR head moved or the base was rewritten after the
  receipt, the planner yields `wait`, not a close.
- **Unknown flow:** missing or stale flow closes producer admission and never
  blocks repair work.
- **Regressions:** the existing `pr-hygiene`, `superseded-close`,
  `rebase-plan`, `merge-batch` and backpressure suites stay green unchanged.

## Validation

```bash
npx vitest run test/fleet-converge.test.ts test/fleet-converge-simulation.test.ts
npx vitest run test/fleet-pr-hygiene.test.ts test/fleet-superseded-close.test.ts test/fleet-rebase-plan.test.ts test/backpressure-310b.test.ts
python3 -m unittest discover -s contrib/mac/tests -p 'test_restock.py'
node scripts/verify-changed.mjs
npm run check:docs
```

## Owner review

- **Owner review required.** This move changes how the live restocker admits
  work and closes PRs. Host installation needs the Security re-pin that
  `contrib/mac/README.md` requires, and the owner's review of the new
  admission rule.
- **Prohibited actions.** No force-push, ruleset bypass, branch deletion or
  gate bypass. A merge always goes through the gates.
- **Expected effect.** It should show up as fewer open PRs older than 48
  hours and fewer closed-unmerged PRs per day in the yield report. It is not a
  claim made in advance.
