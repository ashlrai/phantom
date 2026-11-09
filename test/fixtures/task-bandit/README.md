# Task-aware bandit replay history

Run from the repository root:

```sh
HOME=$(mktemp -d) npx vitest run test/task-bandit.test.ts --reporter=verbose --silent=false
```

This is a synthetic, checked-in fixture for `replayTaskBandit` in
`src/core/routing/task-bandit.ts`, not production telemetry. It requires no
credentials, model calls or mutable account state.

`history.jsonl` is one `phantom-task-bandit-outcome/v1` record per line: a
settled routing decision's evidence — the task context it was classified
under (class, size, risk, repo), the `(engine, model, effort)` arm that
actually ran, the engines seated at decision time, and the measured outcome
(merged, green checks, total input+output tokens).

The logged mixture deliberately favours expensive arms (opus, astra,
swe-2-max) while cheap arms merge at equal rates, so a bandit rewarded on
merged-and-green-per-token demonstrably finds the efficient lane. Edge
records pin the adversarial cases: a risky task logged on a local arm, a
credentialed step, fully-paced pools, one floored pool beside a healthy one,
two records logged on engines the catalog does not know, and a merge-rights
task that must stay frontier-only despite low nominal risk.
