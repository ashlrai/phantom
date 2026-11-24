# Dispatcher route hysteresis

A ready.tsv pool change is a route proposal. In the shared work market, an
enqueue-time lane is only a hint (`assigned:false`); first runnable assignment
starts residency. Existing receipts without `assigned` remain binding. See
[the work market](QUEUE.md). The dispatcher keeps the first observed
pool for 60 minutes after each accepted decision. Only hard-down evidence in the
current lane's slots.json entry permits an early move: explicit `auth_failed: true`
(including the dispatcher's repeated-auth-failure hold), numeric `quota: 0`, or a
provider backoff hold (`held_by: autobackoff`, or a `credits exhausted` hold). The
backoff holds match the fleet controller's reroute sources (RQ-CONSTRAINT-AUDIT-1).
Congestion, rate limits without a hold, missing telemetry, manual holds and lanes on
the operator HOLD list do not. A launch receipt locks the pool forever,
even after completion. Reuse a new job ID for a new line of work.

Each job may change pools twice in a rolling six hours. Initial assignment is not
a move. The cap also applies during hard-down incidents. Blocked proposals emit
`ROUTE_HOLD <job> <old>-><proposed> reason=move_cap` (or `launched` /
`minimum_residency`). Same-pool proposals do not reset the decision clock.
Receipts persist in queue/route-state.json under ready.lock; do not delete them
while job IDs can recur. On first rollout existing unlaunched lines begin their
60-minute residency when observed; existing launch receipts preserve their pool.

Copy and paste from a source checkout:

```sh
npm run dev -- route explain --json
```

`route-moves-per-hour` is the number of accepted changes in the trailing hour,
reported fleet-wide and per job, using seconds-since-epoch receipts. It excludes
initial decisions and held proposals. Missing/unreadable state reports `available:
false` and a null count, rather than a fabricated zero. `ASHLR_RUNS_DIR` selects
an alternate runs directory for the read-only explanation.

Offline incident-count replay (synthetic alternating proposals with the reported
16/12/11 counts; the private live ledger was inaccessible):

```sh
HOME=$(mktemp -d) python3 -m unittest discover -s contrib/mac/tests -p 'test_route_hysteresis.py'
```

All three jobs make zero healthy-lane moves, or two moves with every lane marked
hard-down, within one hour. These are regression results, not a replay of captured
production events.

## Security pin handoff

The tracked dispatcher is the candidate, not an installed live change. Review
`security-route-hysteresis.diff` against the base revision and re-pin the reviewed
candidate through the sanctioned Security process before installing it. The live
auto-router is absent from this checkout: here, external
ready.tsv proposals are reconciled before admission and market assignments
pass through the same hysteresis at claim time. Every evaluated market decision
is recorded with reason codes in `metrics/work-market.jsonl`. Security must confirm the
live routing writer uses this reconciliation boundary; raw live history is still
needed for production replay. No live file, sandbox, wrapper or pin is changed.

A dry-run preview after review is `contrib/mac/install.sh --dry-run --json`.

## Post-merge quality feedback

The candidate dispatcher probes `phm fleet eval-report --jobs <runs>/metrics/jobs.jsonl
--days 30 --json` in parallel with its other readings, with an eight-second process-group
deadline. The controller waits at most 250 ms for an unfinished probe. A host-supplied
`<runs>/metrics/eval-prs.json` export is included with `--prs` only when its modification
time is at most 15 minutes old. Use the existing eval-report export format:

```sh
gh pr list --repo ashlrai/phantom --state merged --limit 1000 --json url,number,title,mergedAt,mergeCommit,files,statusCheckRollup,commits,body
```

The host observation job must refresh that export atomically. No export producer or
timer is installed by this change. Ledger-only merges retain the eval report's
`unobserved` classification; lack of adverse observations never proves stability.
The report itself must be fresh within 15 minutes and its evidence sources must
not be degraded. Missing evidence, duplicate PRs and fewer than 20 resolved merges
per lane produce a null score and no target influence. Pending and unobserved
merges never count toward that minimum.

The score is stable/resolved, minus 0.1 times the positive difference between
failed-check and clean-check adverse rates. That CI term is measured only with
at least five resolved PRs in each cohort; otherwise it stays null. A score at
or below 0.80 selects a 0.75 preference weight; recovery requires at least 0.90.
Between those thresholds the prior decision holds, and transitions require one
hour since the last accepted decision. Repeated decisions do not reset the clock.
State persists in `queue/fleet-controller.json` across dispatcher restarts.

Quality multiplies the existing effective-target factor even on a healthy host.
The bounded floor, desired target, ceiling, hard cap and Security pin still win;
freeze remains floor-only. Existing holds, KILL, admission and tier checks stay
on their original paths. The existing controller mode controls activation:
shadow computes receipts; enforce with phase B applies effective targets.
Job-level routing residency and move caps remain independent.

Each lane emits a `route.quality.v1` receipt with epoch-second timestamps, resolved
sample count, nullable score/CI delta, old/new weight, reason, baseline/proposed
targets and shadow/enforce mode. The controller ledger retains these receipts;
`phm route explain --json` also exposes the latest as `laneQuality`, independently
of per-job route-state availability. Missing receipts are null. Source dispatcher
and controller changes require Security review and re-pinning before live install.
