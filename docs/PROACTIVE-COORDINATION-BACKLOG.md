# Provider-neutral coordination backlog

Phantom should own durable assignments, routing evidence, verification and the
operator notification feed. Users declare accounts, agents, capabilities,
preferences and goals; provider adapters establish what can actually run.
Personal assistant names and observed strengths are configuration, not fixed
product roles or authority. Multiple agents may share a provider or account.

## Review basis and milestone boundary

This engineering backlog was reviewed on 2026-10-12 in
`/Users/masonwyatt/Documents/Codex/2026-10-12/task/phantom-coordination`, branch
`codex/provider-neutral-companions-20261012`, based on
`ea5f9ac2e6f66b8cece71b91fd9f663c513599f7` (`@ashlr/phantom` source candidate
3.29.13). Parallel milestone edits are intentionally present in the proactive
modules and UI. This document records source findings and implementation
requirements; it does not claim those edits are tested, published, installed,
commissioned or accepted with a real provider. Use the final milestone test
report for its qualified revision and results.

The local milestone covers extensible profiles, scoped packets, a durable
companion task ledger, manual reports and independent review, observable holds,
and one local notification state. It provides coordination evidence without
provider contact. Funding references, declared capabilities and an enabled
profile do not establish entitlements, a connection, transport qualification or
spending permission. A fixture must be labeled simulated; a manual report must
retain its unverified origin even after an operator accepts its result.

No account credentials, private runtime records or session archives were read
for this backlog. No external agent or provider was contacted, and no service,
release target, installed app or account setting was changed.

## Existing foundations and remaining seams

| Area | Implemented before this milestone | Remaining coordination seam |
|---|---|---|
| Proactive identity | [Profiles](../src/core/proactive/profiles.ts) bind provider, account ID and agent ID separately from display labels. Operation readiness is explicit. | Extensible provider slugs, capability declarations and assignment preferences belong here. No qualified personal-agent adapter currently turns a profile into an executable resource. |
| Account routing | [Seat router](../src/core/routing/router.ts) admits by account/task fit before ranking; [pool policy](../src/core/resources/pool-policy.ts) separates readiness, quota, reserve, concurrency and task caps. | A unified read-only preview should join companion capability evidence to native pooled execution without treating one as the other. Preserve every excluded candidate and its reason. |
| Cheap decisions | [Jev decision layer](../src/core/decide/index.ts), [resource advice](../src/core/decide/resource-choice.ts), [decision ledger](../src/core/decide/ledger.ts). | Jev is confirmed as TypeSafe AI System One. Reuse its fallback, confidence, cache, call-budget and metadata-only choice contract. Do not infer performance or provider health from its name or recorded mean latency. |
| Context | [Temporal task context](../src/core/context/task-temporal-context.ts) retains source/account/revision, time, conflicts and supersession. | Companion packets need tenant, task, project binding and exact destination approval; project path or shared project memory alone cannot establish client sharing permission. |
| Goal ownership | [Outcome store](../src/core/goals/outcome-store.ts) and [outcome dispatch](../src/core/daemon/outcome-dispatch.ts) have durable claim/replay patterns. | Companion reports require their own semantics; do not reinterpret engineering merge success as generic assistant success or a provider completion claim as verification. |
| Bounded improvement | [Engineering supervision](../src/core/resources/console-engineering-supervisor-types.ts), [successor coordinator](../src/core/resources/engineering-successor-coordinator-types.ts), [Leader actions](../src/core/vision/leader-apply.ts). | Join the generic companion workflow to approved goals without creating another autonomous scheduler or changing the signed operating window. |
| Learned routing | [Learned router](../src/core/run/learned-router.ts), [assignment receipts](../src/core/learning/routing-assignment-receipt.ts), [causal metadata](../src/core/learning/causal.ts). | Account/model/task/scope-compatible companion evidence is not yet part of these priors. Deterministic assignment receipts explicitly do not prove randomized causal improvement. |
| Funding and cost | [Credit observations](../src/core/resources/credit-pool-types.ts), [API promotion contracts](../src/core/resources/claude-api-grant-types.ts), [budget store](../src/core/routing/budget-store.ts). | Connection, balance, expiry, configured budget, entitlement and actual consumption must remain independent evidence. Generic companions need qualified accounting adapters. |

## Next implementation sequence

### 1. Finish local coordination and an honest operator preview

Keep stable identity `(provider, accountId, agentId)` and immutable identity on
profile updates. Capability IDs describe work the user wants assigned, with
source and qualification represented separately. Show configured, connected,
executable, simulated and blocked states distinctly. Unsupported dispatch,
result, status or cancel must remain visible; a generic provider label cannot
enable a hidden transport.

Assignments bind task identity, tenant/project binding, input packet digest,
assignee, attempt, owner and ownership epoch. Record intent before any future
contact. Expected-revision CAS and command-ID/request-digest replay checks
prevent cooperative duplicate dispatch. A timeout after possible contact stays
unknown and held for reconciliation; an expired local lease does not prove a
remote agent stopped. Late reports remain historical and cannot advance a newer
owner. Result review checks exact report/result digests and acceptance criteria;
requesting cancel and confirming cancel are separate facts.

Build a pure capability-routing preview over these records before adding live
dispatch. It should report which candidates match declared requirements and why
execution is blocked. Feed native pools only through their existing admission
and reservation paths. Scoped shared tools must bind account, task and approved
destination. Recheck authorization at actual contact and publication, not only
when preparing a packet.

Minimum acceptance: two generic profiles on one provider, a second account on
that provider, arbitrary configurable assignments, blocked transport, concurrent
claim winner, exact replay, conflicting replay, restart after intent, ambiguous
timeout, stale-owner report, cancellation request/confirmation, failed review,
cross-tenant denial and one deduplicated local notification. Fixtures prove
these local contracts only. No live adapter acceptance follows from them.

### 2. Qualify one read-only companion integration

Use the [Dots evidence slice](DOTS-COMPANION.md) as the first compatibility
target, but implement an adapter contract independent of any assistant's name.
Commission one exact account/agent, one approved project and read-only evidence
operations first. Store operation-specific qualification references, exact
identity, allowed scopes, timestamps, expiry and revocation. A connection test
does not qualify dispatch, result or cancellation. Each additional account is
commissioned independently.

Proactive intake should append source-owned evidence and propose bounded work.
It cannot expand scope, approve spending or treat inbound text as an operator
instruction. Use source event IDs and revisions to deduplicate and handle
out-of-order updates. Phantom owns the durable notification outbox; selected
delivery adapters do not independently notify the user. Record delivery intent
and uncertain delivery before retrying. Local acknowledgement is not proof of
external delivery.

Acceptance: permission revocation between packet build and contact blocks the
operation; identity or scope drift fails; partial source coverage stays visible;
duplicate events/restarts do not create repeated work or notices. This stage
requires account-owner authentication and scoped sharing approval. Two Dots,
GrokBot and Meta Muse/Ash are compatibility targets, not mandatory lanes or
authorization to contact them. The separate Meta API engine does not connect a
personal Muse agent.

### 3. Join planning to resources, accounting and bounded iteration

Add one outcome-level operating contract containing success criteria and a
pinned evaluator/acceptance version, deadline, attempt/concurrency caps, monetary
ceiling, allowed resources, notification/escalation owner and stop conditions.
Null cost means unknown; zero is an explicit zero-dollar ceiling. Exceeding a
deadline, exhausting attempts, missing required evidence or unresolved remote
contact creates a visible hold. Preserve the original deadline and consumed
budget across restart and successor creation. Escalation proposes a change to
the owner; it never silently increases limits.

Reuse [scheduling metadata](../src/core/routing/scheduling-types.ts) and
[reset-aware admission](RESET-AWARE-SCHEDULING.md). Distinguish provider-reported
usage, tariff-based estimates and unknown cost, with model/rate/source/as-of and
coverage. Subscription percentage is not tokens or dollars. Promotional,
purchased and subscription funding are different pools; cloud credit is not an
API grant. Credit expiry and admission cutoff need provider-owned precision and
identity evidence; unknown balance/expiry cannot authorize promo-only spending.
Connection readiness and a display override cannot establish quota or entitlement.

Jev may choose only from the already eligible closed set using approved
metadata, and the caller rechecks current policy, identity, Stop and reservations
after the asynchronous answer. Missing/slow/low-confidence answers use the
deterministic path. Measure real decision latency, tokens, compatible quality and
end-to-end time to verified outcome separately before claiming savings.

The existing REST transport is
[typesafe-client.ts](../src/core/classify/typesafe-client.ts), wrapped by
[decide.ts](../src/core/decide/decide.ts); adding a second client or SDK is not
needed for coordination. Current request types/defaults allow moving aliases
`jev-latest` and `jev-preview`; a reproducible evaluation needs additive concrete
model configuration, response-model checks and cache identity. Compare the
current Score min/max shape to the official rubric contract before using it for
new evaluations. Choice confidence expresses distribution sharpness, not proof
of correctness; this milestone corrects that documentation and comment wording.
Select thresholds
using task-specific held-out evidence. Keep capacity arithmetic, authorization,
budgets and other closed rules deterministic before asking the model.

Before expanding context formats, provide an explicitly typed representation for
SHA-256 artifact heads: the current generic secret detector refuses bare 64-hex
artifact values. Ordinary SHA-1 Git heads and revision-bound local briefs work.
Before large-scale coordination, add worker isolation and measured read budgets
for snapshot-ledger projection, plus safe archival/retention rather than silently
discarding duplicate/recovery evidence when bounded local storage fills.

Run an offline shadow corpus with pinned questions/model expectations,
option-order permutation, misleading/injected state, low-confidence answers,
out-of-vocabulary responses, maximum-choice overflow, timeout, 429 and 529.
The adapter currently falls back without retries, classifies 429 and 503 with
Retry-After as rate limits, and other failed HTTP responses as errors. Retain
those bounded behavior guarantees. After account authorization, separately
measure live classification errors and latency; provider marketing timings are
not an SLA. Source tariff estimates are date/model-specific, not invoice totals.
Learning from provider outputs must respect the provider's current terms; do
not build competing-model distillation into the self-improvement loop.

Acceptance: unknown readings stay unknown, expired credits block, changed
eligibility defeats cached advice, resumed loops preserve caps, and every
dispatch joins its recorded choice to actual/estimated/unknown accounting.
Qualified usage readers, paid API configuration or new funding access need
separate authorization; pure previews and synthetic accounting tests do not.

### 4. Make self-improvement inspectable and reversible

Record policy version, eligible candidate population, chosen action, task/model/
account cohort, input provenance and verified outcome. Quarantine stale,
simulated, self-reported, cross-tenant or incompatible evidence from production
priors. Explain recommendation changes and retain the prior policy version.
Enable shadow comparison and explicit rollback of routing preferences without
rewriting historical receipts. A measured regression triggers a hold or restores
the approved prior policy; it cannot enlarge allowed backends, tools, scopes,
credentials or release authority. Preserve deterministic safety gates.

Acceptance: a routing experiment is reproducible from pinned inputs, its impact
and exclusions can be inspected, rollback restores the prior approved behavior,
and malformed/missing learning receipts leave ordinary routing available.
Reuse verified outcome/production labels rather than counting task volume as
success. The [efficiency roadmap](EFFICIENCY-ROADMAP.md) separates measured local
changes from hosted and installed performance; use that same evidence standard.

## Release autonomy: reuse the current channels and qualify generic targets

Canonical npm publishing is already implemented in
[publish-canonical-npm.yml](../.github/workflows/publish-canonical-npm.yml) and
[canonical-npm-publisher.mjs](../scripts/canonical-npm-publisher.mjs). It binds
exact hosted CI, independent Audit and trusted attestation, reuses the original
archive, reconciles uncertain publication with reads, verifies public bytes and
provenance plus an isolated consumer, then promotes and reads back `latest`.
Source and documented historical commissioning do not establish a release of
this milestone. Follow [the current release guide](RELEASING.md); the legacy
`release.yml` and [successor policy verifier](../scripts/verify-release-policy.mjs)
remain frozen evidence contracts, not a canonical or generic release fallback.

The smallest release follow-on is a pure, versioned release-plan/receipt adapter
that projects the existing channel evidence into the Leader's task ledger.
It should not acquire credentials or execute publishing. Target commissioning
and effect consumers are separate changes, after agreeing the exact repository,
package/site/app, channels, responsible owner and recovery plan.

| Channel | Existing source seam | Required target binding and post-check | Recovery contract |
|---|---|---|---|
| npm | Current canonical publisher and [tests](../test/canonical-npm-publisher.test.ts) | Exact package/registry/version/archive integrity, source/tree and qualified run/attempt/artifact IDs; fresh provenance, isolated consumer and stable-tag readback | Never overwrite an immutable version. Reconcile uncertain acceptance; explicitly authorized tag restoration, deprecation and/or corrective newer version are distinct operations. |
| Website | [Host release](../src/core/website/host-release.ts) and [host adapter](../src/core/website/host-adapter.ts) | Existing profile is fixed to Phantom Secrets/public website. A generic profile needs separately commissioned owner/project/domain set, source/output digests, toolchain and fresh signed scope; staged and promoted health observations | Pin prior deployment and every affected alias. Verify restored aliases and route health; an attempted rollback is not proof of restoration. |
| Desktop assets and installed app | [Desktop tool policy](../scripts/desktop-release-policy.mjs), [artifact installer](../scripts/install-desktop-artifacts.mjs), [desktop guide](../desktop/README.md) | Exact app/version/platform/architecture, signed archive/feed, qualification and installed-byte/startup acceptance; Stop/drain and app lifecycle remain separate | Preserve independent signed prior assets and supported update/install behavior; package-tag rollback does not downgrade already installed clients. Test recovery for data/schema compatibility and stopped state. |
| Resident runtime | [Activation contract](RUNTIME_ACTIVATION_AUTHORITY.md), [M568](contracts/CONTRACT-M568.md), [M521](contracts/CONTRACT-M521.md) | Signed candidate/rollback bindings and scoped admission are observation evidence. M568 production roots are empty and its native consumer unavailable; resident start/ACK and provider dispatch need independent authority | Protected broker, external single-use replay, trusted time, atomic custody and exact stopped rollback remain prerequisites. No local receipt may self-enable them. |

Every future release plan must bind an exact artifact/version/target, immutable
test evidence and required freshness, current authority revision, deadline,
one-use attempt identity, post-release acceptance and channel-specific recovery.
A successful build is not publication; publication is not installation, site
health or resident activation. Learned policy changes cannot authorize a release.
Unknown provider state is reconciled before another write. A shared notification
reports each channel's actual state without announcing global completion early.

## Authorization and delivery boundaries

Local schemas, stores, projections, fixture transports, previews, test coverage
and a pure release-plan adapter can be developed without new account access.
This milestone changes no live services, installed app, publisher or provider.
Account-owner authentication, OAuth, persistent access/subscriptions, paid
resources, target commissioning, cross-client sharing and external-agent
communication require their own explicit authorization and qualification.
Client management versus ownership remains unconfirmed; account labels cannot
resolve it. Routine releases may be unattended inside a previously commissioned,
current, bounded policy; creating or widening that policy is a separate action.
