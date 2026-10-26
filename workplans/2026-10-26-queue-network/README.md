# RQ-PLAN-QUEUE: fleet queueing-network child jobs

Reviewable backlog for the queueing-network model, based on Phantom `a6f3c323`.
[model.md](model.md) is the design contract: job classes, nodes, routing
matrix, parameters, metrics, emitters, estimator, controller, LP/bandit feed
and desktop graph. [children.json](children.json) is the canonical
machine-readable manifest: 12 children with dependencies, scope, acceptance
and test files. Nothing has been enqueued, launched, published or marked
complete in the live router.

## Evidence and dispatch gate

The checkout contains no authoritative router queue. The parent's text is the
router task itself (repo `phantom`, P0, tier `frontier`, pool `codex-cmp`);
every child below is **proposed** under those defaults and requires queue
reconciliation before dispatch. The manifest records stable handoff IDs
(`RQ-QN-01..12`); they are proposed identifiers, not confirmed router jobs.

This plan describes an advisory measurement and control layer. It does not
replace the dispatch router, backpressure brakes, budget policy, merge gates
or authority checks; those keep precedence, and the model's output is
inert until the shadow integration job and the flag-rollout gate.

## Requested components → children

| Named component | Children |
| --- | --- |
| schema | RQ-QN-01 (qnet.v1 schema + contract), RQ-QN-02 (live projection) |
| emitters | RQ-QN-03 (bounded queue-event ledger + call-site helpers) |
| estimator | RQ-QN-04 (λ/μ/p/availability estimation), RQ-QN-05 (analytic metrics engine) |
| controller | RQ-QN-06 (advisory admission/slot recommendations) |
| LP/bandit feed | RQ-QN-07 (reward vector + constraint matrix + offline LP harness) |
| desktop graph | RQ-QN-09 (console queue-network graph, behind query flag) |
| tests | RQ-QN-10 (discrete-event replay simulator), RQ-QN-11 (privacy/fail-closed conformance) |
| surfaces + integration | RQ-QN-08 (`phm queue status` + FleetStatus), RQ-QN-12 (shadow wiring, owner lane) |

## Dependency order

| Stage | Children | Gate |
| --- | --- | --- |
| 1. Contract | RQ-QN-01 | queue-reconciliation |
| 2. Observation | RQ-QN-02, RQ-QN-03 | after 01; independent of each other |
| 3. Estimation | RQ-QN-04 | after 01+03; feeds 05, 07, 10 |
| 4. Model | RQ-QN-05 | after 01+04 |
| 5. Advisory layer | RQ-QN-06, RQ-QN-07, RQ-QN-08 | after model/projection; 08 feeds 09 |
| 6. Surfaces | RQ-QN-09, RQ-QN-10 | after 08 and 04+05 respectively |
| 7. Conformance | RQ-QN-11 | after 03, 06, 07 |
| 8. Integration | RQ-QN-12 | every other child; owner-lane + flag-rollout |

After the schema lands, projection (02) and emitters (03) can proceed in
parallel; the estimator (04) needs the event definitions; the model (05)
needs the estimator. Controller, LP feed and status are independent once 05
exists. The desktop graph waits for a status surface. Conformance waits for
the telemetry, controller and feed so it can adversarially exercise all
three. Integration waits for everything.

Use isolated worktrees for every child; RQ-QN-08 and RQ-QN-12 both touch
`src/core/fleet/status.ts` — serialize those edits through the integration
job. `src/cli/index.ts` registration in 08 is a thin dispatcher per the repo
convention; keep it thin.

## Current source boundaries

- `src/core/fleet/dispatch-router.ts`, `src/core/fleet/backpressure.ts` and
  the daemon tick are the decision points the model observes and advises.
  This plan adds no edits to them except inside RQ-QN-12, which is gated on
  owner authorization.
- `src/core/routing/work-estimates.ts`, `src/core/routing/headroom.ts` and
  `src/core/routing/scheduling.ts` already compute service percentiles and
  capacity windows; children reuse their semantics and readers rather than
  reimplementing percentile or window logic.
- `src/core/fleet/dispatch-production-ledger.ts` and
  `src/core/fleet/agent-action-ledger.ts` define the append-only,
  metadata-only, never-throw ledger discipline the event emitter copies.
- `src/core/fleet/status.ts` is the established FleetStatus projection
  surface; the qnet field follows its fail-soft sourceState conventions.
- `src/web-ui/routes/verse/fleet/` holds the console fleet views the desktop
  app embeds; the queue graph follows the existing flag-gated graph pattern.

No dead code was removed in this planning scope.

## Authority, privacy and honesty

The stream, projection, estimates, metrics, advice, LP feed and status are
all metadata-only: allowlisted ids, enums, counts and timestamps. No prompt
text, diffs, paths, argv, stdout, stderr, environment or secret material.
Unknown stays `null`; degraded sources degrade only their dependents. The
controller recommends and never acts; precedence is kill-switch/holds >
backpressure > budget policy > qnet advice. Live routing changes require the
flag-rollout gate after shadow evidence, and only the established publisher
may push after a separately authorized handoff.

## Verify this planning artifact

```sh
verification_home=$(mktemp -d)
HOME="$verification_home" npx vitest run test/queue-network-plan.test.ts
npm run typecheck
npm run lint
npm run check:docs
```

The suite checks component coverage, unique IDs, a closed acyclic dependency
graph, concrete scope/acceptance/test targets, owner-lane gating on
protected paths, the integration job's full-coverage dependency, and that
shared acceptance carries the verification and security rules into every
child. It validates the planning artifact only — not future implementations.
