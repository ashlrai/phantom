# Offline router replay: task-aware arms

Run from the repository root:

```sh
HOME=$(mktemp -d) npx vitest run test/router-arms-replay.test.ts --reporter=verbose --silent=false
```

A synthetic, checked-in regression recording like `fixtures/router-replay`,
this time with `policy.taskArms` set. It requires no credentials, model calls,
provider probes or mutable account state. The harness calls the real
`src/core/routing/router.ts` with frozen inputs and a recorded clock.

The same join grammar as `router-replay` applies; `snapshotId` joins to a
snapshot in `status.json`, which additionally carries the stored `taskArms`
flag and the caller-supplied `options.armStats` evidence (keyed by arm key
`engine|model|effort`, or the arm's `id`). Per arm the stats hold merged green
PRs, measured tokens on completed work and the pacing window's spend.

What this fixture pins:

- `armed`: the armed router steers `code` work to `claude` because its arm
  measures the higher merged-PR-per-token, while the baseline order would
  have picked the free local seat. A `review` job on the same snapshot has no
  armed class and keeps the baseline pick, and an interactive request is
  never steered even when its class is armed.
- `paced`: the claude arm is ahead of its token pacing ceiling (300k spent
  against a ~62k allowed cumulative pace), so it stays inadmissible and the
  local arm takes the job.
- `off`: `taskArms.enabled` is false, so the same inputs route exactly like
  the baseline.
- `bogus`: the only configured arm names an unknown engine. It can never
  match a seat and never produces a candidate, so the baseline pick stands.
- `held`: the class's only valid arm names an engine with no seat, so no
  seat can serve the class and the decision is a hold.

Merged-PR-per-token is computed by the shared replay harness from recorded
outcomes; failed work stays in the denominator, pending and held jobs are
excluded, and a changed lane claims no counterfactual outcome.
