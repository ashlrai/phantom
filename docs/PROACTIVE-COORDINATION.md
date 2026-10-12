# Local proactive-agent coordination

This milestone adds provider-neutral planning and a durable operator workflow.
It does not connect personal agents or execute provider work. Every command
reply contains `dispatchAuthorized: false`; configured profiles remain unqualified.

## Operator workflow

In Proactive agents, add a provider/account/agent identity and declare the
capabilities and planning preferences you want. Multiple profiles can share a
provider or account. The immutable identity is separate from its editable name.
Old profile records hydrate metadata defaults without rewriting storage.

Record a local task with a tenant/project binding, stable task key, goal,
acceptance criteria, recipient and optional deadline/cost ceiling/attempt limit.
The packet endpoint derives a revision-bound local brief with no imported sources;
its coverage stays missing. Project and recipient fields are local planning
metadata, not verified account ownership or cross-account sharing permission.

Assign the reviewed recipient, prepare a handoff intent, record a manual report,
and review that exact result against the acceptance criteria. Operator reviews
are labeled separately from provider or independent verification. A failed review
leaves the task needing attention. A local notice can be acknowledged once.
No step sends work, reads an inbox, grants access, posts messages or spends money.

## Source contracts

- [Profiles](../src/core/proactive/profiles.ts) keep arbitrary provider slugs,
  account/agent identity, declared capabilities and preferences. Transport,
  entitlement, connection and pricing evidence remain separate prerequisites.
- [Coordinator](../src/core/proactive/coordination.ts) uses an immutable private
  ledger with CAS, request-digest replay, stable task identity, ownership epochs,
  manual report/verification receipts and notification state. Read-only replay
  precedes new-operation preference checks. Changed replay contents conflict.
- [Packets](../src/core/proactive/packets.ts) bind tenant, project, task, explicit
  source accounts, exact destination, artifact revision, scope and limits.
  Host authorization is supplied outside JSON and rechecked; parsing is not
  authorization. The current operator endpoint accepts only a local brief.
- [Planning](../src/core/proactive/planning.ts) ranks declared fit and preferences.
  Every candidate retains `executionEligible: false`. Scores do not measure
  quality, entitlement, quota, connection or spending eligibility.
- [API](../src/core/verse/proactive-coordination-api.ts) sits behind existing read
  session and operator mutation boundaries. It exposes no host reconciliation
  hook or live transport. [Wire references](../src/core/proactive/coordination-wire.ts)
  encode generated digests/IDs explicitly so general secret redaction stays active.

`GET /api/verse/proactive-agents/coordination` returns ledger quality, tasks,
packet recipients and local candidate reasons. `POST .../coordination/packet`
prepares the bounded brief; `POST .../coordination` accepts closed commands:
create, assign, handoff, report, operator-review, cancel and notification-ack.
Writes require the current revision and stable command ID. Preserve a command
after an uncertain response and retry its exact bytes; replay never dispatches.

## Recovery and evidence

Lease expiry blocks a new handoff and never transfers potentially active remote
work. Reassignment requires host evidence of no start or confirmed cancellation.
The optional host-observation port is injected by trusted code; tests use fixtures.
The HTTP API cannot fabricate accepted/running/cancel-confirmed observations.

Reports carry the original packet/attempt/epoch and exact result digest. New
current reports supersede older drafts; stale results remain history and cannot
advance the task. Semantic duplicate reports/reviews preserve acknowledged
notification state. Late reports preserve cancellation and verified terminal state.
Manual verification does not complete an engineering outcome or prove a merge,
deployment, package publication or provider execution.

Credential-shaped result text is refused so an operator cannot verify an exact
digest while its result bytes are hidden by public redaction. Storage is bounded,
private, no-follow and immutable. Hash-chain integrity is local consistency
evidence; it does not defend against a compromised same-user account rewriting
all records. Missing/degraded state cannot silently authorize work.

Null cost means unknown. A stated cost ceiling and deadline are planning limits,
not balances, provider acceptance, timers, execution admission or authority.
No background supervisor consumes these records in this milestone.

## Qualification still required

See [the backlog](PROACTIVE-COORDINATION-BACKLOG.md) for account-scoped transports,
proactive event ingestion, real cancellation/results, funding observations,
router shadow evaluation, bounded goal execution and commissioned release targets.
OAuth, persistent account access, paid calls and cross-client sharing require
separate authorization. The installed app and live fleet remain unchanged.
