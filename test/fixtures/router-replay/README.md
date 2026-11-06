# Offline router replay

Run from the repository root:

```sh
HOME=$(mktemp -d) npx vitest run test/m15.router-replay.test.ts --reporter=verbose --silent=false
```

This is a synthetic, checked-in regression recording, not production telemetry
or evidence of real PR throughput. It requires no credentials, model calls,
provider probes or mutable account state. The harness calls the real
`src/core/routing/router.ts` with frozen inputs and a recorded clock.

`jobs.jsonl` has one decision per unique job ID. `snapshotId` joins to a
snapshot in `status.json`, containing the capacities, policy and route options
at decision time. A lane is the exact seat ID; null means held. Outcomes and
total measured input plus output tokens are recorded separately from the
router input. To replay a sanitized capture, project it into these test-only
interfaces in `test/helpers/router-replay.ts`; these files do not claim to be
the schema of a live queue export. Preserve each decision's original clock,
seat order, policy, capacities and any optional route options.

The test pins free-seat preference, context fit, stable ties, exhausted,
unknown and stale usage holds, and interactive reserve handling. Negative
controls change capacity and require lane mismatches to appear.

Merged-PR-per-token is the number of merged outcomes divided by the sum of
measured tokens across completed merged, closed and failed jobs. Failed work
stays in the denominator. Pending and held jobs are excluded, as are jobs
with unknown tokens. A zero denominator is unknown, never Infinity or zero.
The report includes all actual outcomes, per-actual-lane totals, and the
matched-lane cohort. A changed lane has no observed counterfactual outcome;
the harness never estimates its yield or claims an improvement from excluding
mismatches. The matched-cohort ratio is descriptive, not a policy comparison.
