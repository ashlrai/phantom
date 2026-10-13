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
Canceling an attempt before any persisted handoff intent allows a new local
assignment without inventing a remote cancellation receipt. Once intent exists,
reassignment still requires exact host evidence of no start or confirmed cancel.

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
Reconciliation binds the original command/task/attempt/revision and replays its
persisted result before consulting current host availability or observations.

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
An independent private watermark chain is reserved and synced before every
ledger revision. Tail truncation, missing ledger/head, or a reservation without
its ledger record is held for explicit reconciliation; recovery cannot turn
that loss into a fresh request. Older unanchored journals are also withheld.
This detects ledger-only loss and interrupted publication. The same OS user
replacing or deleting both custody paths remains outside its guarantee; future
external effects need their own protected, independently bound replay custody.

Null cost means unknown. A stated cost ceiling and deadline are planning limits,
not balances, provider acceptance, timers, execution admission or authority.
No background supervisor consumes these records in this milestone.

## Resource evidence and offline planning

Open **Planning lab** to inspect evidence independently of the task board.
[Resource projection](../src/core/proactive/resource-evidence.ts) accepts public
snapshots through an injected cache getter. It separates identity, connection,
capabilities, entitlement, readiness, usage windows, credits and cost. Percent
usage never becomes tokens or dollars; cost remains actual, estimated or unknown.
Stale, conflicting and unmeasured observations cannot become current measurements.
Credit expiry and native units are retained without implying subscription rights.
Funding product/account and declared eligible/excluded surfaces are independent
fields. A promotion tied to one API organization cannot fund a coding
subscription or consumer app by association. Purchase/grant receipts retain
their original amounts as receipts; balances and consumed cost stay unknown
without separate observations. Repository examples are synthetic.

The default HTTP integration projects saved profile declarations. Native usage,
funding, connection and actual cost are unknown until a host supplies already
captured public snapshots. It never calls a collector, refreshes an account,
reads an assistant session or silently probes a provider. A refresh in this view
means rereading this local projection.

[Routing lab](../src/core/proactive/routing-lab.ts) saves a deterministic shadow
evaluation of one exact saved task/brief, or runs a synthetic offline benchmark.
Synthetic System One responses exercise closed choices, order changes, malformed
answers, low confidence, cancellation and timeout/429/529 fallbacks. They are
fixtures, not TypeSafe calls or evidence that the model improves production
routing. The pinned model label records the intended contract, not model use.
Only local evaluation duration is measured; provider latency remains null.

Receipts pin request, input, snapshot and policy digests. An immutable intent is
saved before evaluation, and an interrupted intent stays uncertain. Retry the
same request; it does not restart an adapter. Changed request bytes conflict.
Preference proposals and withdrawals are inspectable local records and never
change production routing or grant authority.

`GET .../planning` lists receipts. `GET .../planning/resources` projects evidence.
`POST .../planning` records a preview, benchmark, proposal or withdrawal behind
the existing operator mutation gate. The preview accepts a saved task ID; host
code resolves its scope and exact packet. The browser cannot supply another
tenant, destination or source-account set. All results retain
`executionAuthorized: false`.

## Release readiness evidence

`GET .../planning/release` reports a missing target by default. The pure
[release evaluator](../src/core/proactive/release-readiness.ts) checks an exact
channel, target, version, source revision, artifact digest and attempt against
fresh tests, qualification, provenance, commissioning, provider-state and replay
receipts. Host evidence is independently validated through a separate injected
port; browser JSON cannot commission a target. All-fixture evidence remains
simulated even when the planned checks pass.

Post-check and recovery plans are channel-specific: npm uses a corrective newer
version, websites identify a previous deployment and affected targets, and
desktop recovery names signed prior assets and the customer update path.
These are structural planning checks; a later effect consumer must verify actual
signatures, deployment ownership, acceptance and recovery execution. Readiness
never authorizes publication, deployment, installation or service changes.

## Qualification still required

See [the backlog](PROACTIVE-COORDINATION-BACKLOG.md) for account-scoped transports,
proactive event ingestion, real cancellation/results, qualified cached funding
observations, live router evaluation, bounded goal execution and commissioned release targets.
OAuth, persistent account access, paid calls and cross-client sharing require
separate authorization. The installed app and live fleet remain unchanged.
