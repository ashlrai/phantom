# Chat-first assistant child jobs

This is the planning handoff for **RQ-PLAN-NORTHSTAR**, not a claim that the
features are delivered. The [job manifest](chat-first-north-star.json) is the
canonical list of proposed child jobs: stable IDs, parent, repository, priority,
tier, dependencies, concrete deliverables, acceptance criteria and validation.
It is a planning artifact, not an executable router payload. No jobs have been
enqueued by this change.

## Product outcome and current evidence

One conversation should turn engineering intent into scoped, observable,
interruptible work and a reviewable result. Users can inspect the evidence,
correct context and continue from the result without managing the fleet's
internal machinery. This translates the [north star](../NORTH-STAR.md) into a
chat-first delivery sequence; it does not replace the broader product factory.

The [user guide](../VERSE.md) already describes Work with me, Work for me,
Automatic and Review. [Automatic work](../AUTOMATIC-OUTCOMES.md) describes
Manager delegation, resource selection and durable outcomes. The source files
listed on each job are inspection entrypoints, not assertions of missing
implementations or permission to modify protected code. Start each child by
checking its acceptance scenarios against the current source. If already met,
retain the regression evidence and close the gap without building a duplicate
system. Source presence alone is not installed or live-provider proof.

## Delivery order

| Child | Mergeable slice | Depends on |
| --- | --- | --- |
| RQ-NS-CONTRACT | Journey identities, state ownership and baseline fixtures | None |
| RQ-NS-FIRST-TURN | First useful turn and readiness recovery | CONTRACT |
| RQ-NS-CONTINUITY | Reconnect, interruption and replay | CONTRACT |
| RQ-NS-CONTEXT | Inspectable and correctable project evidence | CONTRACT |
| RQ-NS-DELEGATE | Durable scoped Manager handoff receipt | CONTRACT, CONTINUITY |
| RQ-NS-PROGRESS | Task state and acknowledged controls in chat | DELEGATE |
| RQ-NS-REVIEW | Exact artifact, checks and follow-up | CONTEXT, PROGRESS |
| RQ-NS-RESOURCES | Account-specific Automatic explanation | FIRST-TURN |
| RQ-NS-COMPANIONS | Seat-specific companion capability recovery | CONTEXT, RESOURCES |
| RQ-NS-MEASURE | Fixed-corpus comparison and coverage report | REVIEW, RESOURCES |
| RQ-NS-ACCEPT | Combined journey and failure-path acceptance | All implementation children |

Dependency labels abbreviate the RQ-NS- prefix. Land CONTRACT first. After it,
FIRST-TURN, CONTINUITY and CONTEXT are independently ready. Dependencies express
required accepted interfaces and evidence, not authority to dispatch or a reason
to override declared priority. P2 work can follow the P1 core loop, but the full
north-star acceptance still requires it. Reserve integration and review capacity
before launching more work. Use one writer per task and serialize overlapping
file edits, particularly SourceList, chat startup and shared fixtures.

## Handoff and boundaries

A router operator can translate each manifest entry into its native queue schema,
using the stable ID to reconcile existing work before creating anything. Copy
its problem, deliverable, acceptance, validation and non-goals together. Do not
infer a pool or account from the parent's execution pool: use current eligible
capacity and the child's frontier tier. Every child begins planned; dependency
completion must come from accepted evidence, not from this document's ordering.

RQ-NS-DELEGATE touches protected Manager surfaces and requires the owner lane.
A worker under a no-Tier-1 instruction must leave those files untouched and hand
off that slice; it must not bypass the boundary via a new alternate dispatcher.
Any other child discovering a protected change must likewise split and route it
for owner review. No child may enable dormant execution, widen grants, weaken
checks, change CI, provision paid resources, or publish a release as a shortcut.
Phantom Secrets supplies opaque secret references; Locus handles access needs.
Companion evidence must reflect actual per-seat availability.

Each child should fit one concern and one reviewable PR. If discovery expands a
slice, split it with new stable IDs and explicit dependencies before execution.
Attach the base/candidate revisions, changed paths, exact validation commands,
pass/fail counts, limitations and result artifacts to its handoff. Run typecheck,
lint and affected tests with an isolated HOME; run web tests for UI changes and
documentation checks for changed guides. Preserve existing regressions. New
behavior needs positive, refusal and recovery coverage, not text-only assertions.

## Completion and measurement

The parent planning task is complete when the manifest covers the journey,
forms an acyclic graph with resolvable references, and gives every child a
bounded deliverable and testable acceptance. The accompanying manifest tests
check these structural contracts and source references. They do not prove any
planned product behavior.

Product delivery is complete only after RQ-NS-ACCEPT runs the whole journey on
one combined candidate, including unavailable resources, local-only scope,
stale context, interruption, duplicate events, failed checks and Stop. Compare
baseline and candidate with fixed acceptance fixtures. Report scenario success
with denominators, time, rework and token coverage separately. Unknown usage
remains unknown; message count and inferred hours saved are not accepted value.
Live-provider, installed-app and user acceptance remain distinct evidence gates.
The measurement child connects this work to recursive improvement, the completed
journey serves the product-factory pillar, and the companions child covers
composition without requiring every companion to be available.
