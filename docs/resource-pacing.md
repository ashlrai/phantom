# Resource pacing core

[Source](../src/core/resources/pacing.ts) implements a pure advisory planner for
one pool's current reset window. It performs no file, network, provider,
dispatch or merge operations. It is not wired into worker drain or the fleet
router. Eligibility, reading freshness, shared-pool accounting, metered opt-in,
Stop and all existing authority checks remain the caller's responsibility.

This is the independent pacing slice of
[PR #938](https://github.com/ashlrai/phantom/pull/938). It does not require that
PR's #933 base, CLI changes, account defaults, learning pipeline or HiGHS
dependency. The optional LP adapter is supplied explicitly by the caller.

## Planning a window

`paceWindow({ poolId, used, windowStartMs, nowMs, resetAtMs, knobs, stamp? })`
returns periods, fractional spends, a first-period allowance, and a derived
pace series. Times are explicit safe-integer epoch milliseconds; usage is a
finite fraction from 0 to 1. Invalid inputs throw `RangeError`. At or after
reset, the allowance is zero: the caller must supply a new window and usage
reading before planning another cycle.

The even plan follows the reset window's pace line. A pool ahead of that line
waits. Remaining quota is placed into later periods subject to cumulative
ceilings, targeting full utilization at reset. Unused allowance remains in the
next plan's remainder. The caller must include all consumers' usage and
outstanding reservations in its budget and must not independently spend several
plans for the same shared pool.

`HorizonKnobs` supplies:

- `periodMs` and `maxPeriods`: tick length and horizon size (1 to 256 periods).
  Long horizons coarsen the periods to stay bounded.
- `bufferFraction`, `reserveFraction`, `bufferWindowMs`: safety and optional
  consumer reserve fractions, each held until the final buffer window and then
  released linearly. Their sum must be at most 1.
- `flex`: pace slack, from 1 to 100, relative to the original tick.
- `deviationWeight`, `flexPenalty`, `landingWeight`: nonnegative LP penalties
  for deviation from the even plan, spending above the natural flex amount,
  and unspent quota at reset.

Only the first period may inform the next tick. Its allowance also respects
the hold in force **now**. Future spends assume future hold release and are
projections, not immediately available quota. Multiple consumer plans (such as
an orchestration plan and a cloud plan with a reserve) must share a single total
budget at admission.

## Optional LP

`planHorizon` takes the same input plus optional `values`, `solver` and
`solverBudgetMs` (default 100; valid range 1 to 60,000). Varying per-period
values produce a maximization LP with cumulative quota constraints, absolute
deviation and flex penalties, and a terminal landing constraint. Missing
trailing values repeat the last supplied value. Flat values or an absent
adapter use the even plan without invoking a solver.

The `PaceSolver` callback receives the LP string and its budget. It returns a
status and a map of primal variables, with every `s0` through `sN` present for
an optimal solution. Returned spends must be finite, nonnegative, within every
cumulative ceiling and within 1e-8 of full utilization. Tiny numerical
overshoots are removed before returning a plan. Malformed, infeasible, failed,
timed-out or materially incomplete solutions fall back to the even plan.

An asynchronous deadline bounds waiting for an adapter. A blocking synchronous
solver must enforce its own budget or run in a worker; JavaScript cannot
preempt it. The adapter owns cancellation and cleanup of its underlying solve.
The core installs no solver dependency and claims no HiGHS runtime acceptance.

## Reading provenance

Every series has `projection: 'derived'` and `isReading: false`. An optional
`stamp` carries `source` (manual or config), `atMs`, exact `ageMs`, `stale`, and
`uncertainty`. Actual points retain their reading timestamp; projected current
and future points are not readings. Without a stamp the actual value and source
are unknown, uncertainty is 1, and the series is marked stale.

Staleness is preserved, not refreshed by planning. A stale series can still be
used for an advisory simulation; it does not establish dispatch eligibility.
The caller must apply its existing freshness and reset-provenance gates.

Run focused verification with an isolated home:

```sh
HOME=$(mktemp -d) npx vitest run test/resource-pacing.test.ts
```
