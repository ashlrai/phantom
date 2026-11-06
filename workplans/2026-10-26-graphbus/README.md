# RQ-PLAN-GRAPHBUS: graph and bus child jobs

This is a reviewable backlog for all eight requested parents, based on Phantom
`a6f3c323`. [children.json](children.json) is the canonical job manifest. It contains
16 children with dependencies, scope, acceptance and test files. Nothing has been
enqueued, launched, published or marked complete in the live router.

## Evidence and dispatch gate

The checkout contains none of the parent queue definitions or graph.v1/bus adapter
implementations. Read-only local handoffs in `/private/tmp` supplied the Graph 1
and Bus 1 parent text and eight existing child descriptions. Their basenames and
recovered requirements are preserved in the manifest; those transient files are
not required to read or test this plan. Handoffs are historical evidence, not a
current queue status or proof that their implementations landed.

The original Graph 2 and Bus 2 definitions remain unavailable. Their A children
recover the contract; their B children are explicitly blocked placeholders, not
invented implementation assignments. The other child-derived parents also need
comparison against the original parent before claiming complete acceptance
coverage. All children are **proposed**, and all require queue reconciliation
before dispatch. Existing recovered IDs must be matched to their current jobs or
PRs; do not enqueue a second copy. A missing source cannot be waived by a timeout.

Recovered child handoffs used `codex-cmp`, tier `work`. This proposal uses the
current assignment's `codex-personal`, tier `frontier`; that is a planning default,
not a mutation of those existing jobs or authorization to spend money.

## Dependency order

| Parent | Children | Deliverable and dependencies |
| --- | --- | --- |
| RQ-GRAPH-1 | RQ-GRAPH-1A, RQ-GRAPH-1B | Typed registry, then seeded read-only CLI |
| RQ-GRAPH-2 | RQ-GRAPH-2A, RQ-GRAPH-2B | Recover parent; blocked implementation after recovery and graph status |
| RQ-BUS-1 | RQ-BUS-1A, RQ-BUS-1B, RQ-BUS-1C | Durable inbox after schema; wake/log after inbox; CLI after both |
| RQ-BUS-2 | RQ-BUS-2A, RQ-BUS-2B | Recover parent and adapter contract; blocked implementation after recovery and inbox |
| RQ-BUS-3 | RQ-BUS-3A, RQ-BUS-3B | Devin and Grok after inbox and shared adapter contract |
| RQ-BUS-4 | RQ-BUS-4A | Loopback oMLX after inbox and adapter contract |
| RQ-BUS-5 | RQ-BUS-5A | Spool-first hop telemetry after wake/log contract |
| RQ-GRAPH-ROUTE | RQ-GRAPH-ROUTE-A, RQ-GRAPH-ROUTE-B, RQ-GRAPH-ROUTE-C | Picker after graph status and hop events; pool bounds after picker; final offline integration after all branches |

Start source reconciliation and schema work first. After the schema lands,
registry projection and durable inbox work can proceed independently. Adapters
can proceed independently once their common contract and inbox are stable.
Serialize Graph 1B and Bus 1C edits to `src/cli/index.ts`; use isolated worktrees
for every child. Routing is the owner-lane critical path. Final integration waits
for both missing parent contracts as well as all recovered adapter work.

RQ-EVENTD is an external prerequisite for Bus 1B's wake integration. Freeze its
versioned notification contract with the router owner and test against a fake
receiver. Do not silently treat the unrelated in-process fleet event bus as a
durable wake service.

## Current source boundaries

- `src/core/fleet/event-bus.ts` is a best-effort in-process lifecycle bus. Its
  proposal-only handlers and flag-off behavior must continue to work.
- `src/core/knowledge/graph.ts`, `src/core/vision/mission-graph.ts`, and
  `src/core/universe/graph.ts` serve different graph domains. graph.v1 needs
  explicit account/node identities; reuse only after proving semantic alignment.
- `src/core/verse/seats.ts` is an inventory integration seam, not an authority
  issuer. Project values-free metadata and retain source-unavailable states.
- `src/core/observability/telemetry-sink.ts`, `src/core/devin/`, and
  `src/core/local-runtime/` are existing integration seams. Avoid parallel
  telemetry, process admission or local-runtime control implementations.

No dead code was identified in this planning scope. Future adapter jobs must
remove replaced adapter-local paths only after compatibility tests prove the
replacement; deleting the old fleet event bus is not part of this plan.

## Authority, contracts and acceptance

Each manifest entry is a handoff: combine its acceptance with `sharedAcceptance`,
then run its listed test files in a temporary HOME. Proposed paths may not exist
until implementation. Placeholder jobs intentionally have no test files or paths;
the source-recovery job must replace them before dispatch.

Graph edges describe eligibility, never grant identity, tools or permission.
Unknown node ids have no capabilities. Every adapter uses the existing sandbox
profiles and Locus admission; secrets arrive through Phantom Secrets and never
through the registry or bus. Messages remain untrusted even when the sender is
known. Ack follows durable reply, retries retain correlation, and wake failure
must not lose a persisted message. Logs and telemetry use explicit field
allowlists. Raw prompt, body and error strings are not telemetry.

Route A and B name protected routing/backpressure files. Route C exercises their
integration. They require owner-authorized follow-up jobs; their entries do not
authorize this task or another restricted worker to edit Tier-1 paths. Stop,
pause, quota, enrollment and sandbox admission retain precedence over both the
bandit ranking and the concurrency floor. Flag-off restores legacy routing
without deleting inboxes or spool records. Only the established publisher may
push after a separately authorized handoff.

The final integration job owns cross-parent acceptance: deterministic replay,
crash and duplicate delivery, bounded cancellation, metadata-only observability,
and flag-off rollback. Its fixture must report allocation counts and prove zero
unauthorized launches, duplicate replies and sensitive sentinel leaks. Offline
fixtures are not proof of live provider activation or production delivery.

## Verify this planning artifact

```sh
verification_home=$(mktemp -d)
HOME="$verification_home" npx vitest run test/graphbus-plan.test.ts
npm run typecheck
npm run lint
npm run check:docs
```

The plan tests check complete parent coverage, unique/recovered IDs, dependency
closure and acyclicity, explicit source blockers, shared gates, implementation
handoffs and final integration coverage. They do not claim to test the future
graph or bus implementations. Before dispatch, the router owner must reconcile
the original queue and replace the two missing-contract placeholders.
