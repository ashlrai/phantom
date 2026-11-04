# Dispatcher route hysteresis

A ready.tsv pool change is a route proposal. The dispatcher keeps the first observed
pool for 60 minutes after each accepted decision. Only explicit `auth_failed: true`
(including the dispatcher's repeated-auth-failure hold) or numeric `quota: 0` in the
current lane's slots.json entry permits an early move. Congestion, rate limits,
missing telemetry and manual holds do not. A launch receipt locks the pool forever,
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
auto-router is absent from this checkout: here, pool proposals are external
ready.tsv changes and are reconciled before admission. Security must confirm the
live routing writer uses this reconciliation boundary; raw live history is still
needed for production replay. No live file, sandbox, wrapper or pin is changed.

A dry-run preview after review is `contrib/mac/install.sh --dry-run --json`.
