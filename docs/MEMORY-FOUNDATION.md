# Memory foundation

The source-only memory foundation selects bounded, cited project evidence from a
supplied snapshot. It is a pure local kernel: no store, HTTP route, session
injection, recall worker, model call, filesystem access or execution grant is
wired to it. It does not migrate the existing shared `MEMORY.md`, team context,
lessons or genome stores.

Use [Context import](https://github.com/ashlrai/phantom/blob/master/docs/CONTEXT-IMPORT.md)
for the current reference-import and separately reviewed memory-editor workflow.
Use [Offline memory evaluations](https://github.com/ashlrai/phantom/blob/master/docs/MEMORY-EVALUATION.md)
for the independent synthetic fixtures and measurement limits, and
[Memory research](https://github.com/ashlrai/phantom/blob/master/docs/MEMORY-RESEARCH.md)
for future integration and experiments. Source implementation and offline
contract results do not establish an activated memory service or installed
release acceptance.

## Pure source interface

| Module | Responsibility |
| --- | --- |
| `src/core/memory/types.ts` | Closed version-1 fact, source, snapshot, query, exclusion and pack contracts |
| `src/core/memory/validate.ts` | Exact data shapes, byte/date/control limits, shared-pattern refusal, and a detached recursively frozen snapshot |
| `src/core/memory/scope.ts` | Exact project, owner and audience admission; exact original scope for lifecycle links |
| `src/core/memory/temporal.ts` | Review, valid-time, knowledge-time, lineage, revocation, conflict and tombstone eligibility |
| `src/core/memory/pack.ts` | Deterministic lexical selection, complete quoted evidence, byte limits and receipts |

`buildMemoryContextPack(snapshot, query)` is the supported composition entry
point. It validates unknown inputs, copies the query and freezes a detached
snapshot before selection. Caller changes cannot alter that detached snapshot. To prepare once for several
queries, call `immutableMemorySnapshot(raw)` and pass its returned snapshot to
`buildMemoryContextPack`. The actual detached JSON copy is validated again before freezing. Only
factory-created recursively frozen copies qualify
for reuse, through module-private weak membership; caller-frozen objects or
claimed preparation fields do not bypass validation. Every pack still reruns
query validation, scope, time, lineage, lifecycle, ranking and budget checks.
Preparation caches no query result, observes no live store, and makes no claim
that a supplied snapshot is fresh.
The lower-level temporal projector requires an already validated snapshot; it
is not a storage or authentication boundary.

A fact event identifies an immutable event, logical fact and positive revision;
its project, owner and audience; a subject and slot; text and source references;
observed, effective, recorded and review times; review decision; and explicit
supersession, derivation or deletion links. Every event declares
`authority: false`. Source references contain an ID, a claimed prefixed SHA-256
digest, locator, quotation and optional observation date. Dates are strict UTC
ISO strings with milliseconds; unknown observation dates are `null`.

An approved label requires review metadata. It records a caller-supplied review
decision, not proof of reviewer identity, source authenticity or factual truth.
A claimed source digest is not recomputed against an original archive by this
kernel. IDs, snapshot revision and watermark are supplied by the caller; they
are not signed receipts or a verified live-store revision.

## Scope and time

The caller must supply admitted canonical project IDs and authenticated owner
and audience identities through a future trusted adapter. This kernel compares
those opaque IDs exactly. It does not resolve paths, aliases or same-basename
projects, authenticate the caller, infer personal consent, or fall back to a
global collection. A relevant-looking foreign project or audience is excluded
before lexical ranking. Supersession and deletion cannot widen the target's
original project, owner or audience set.

The two temporal axes answer different questions:

- `time: { mode: 'current', at }` or `{ mode: 'asOf', at }` supplies the
  **validity time**. The caller chooses the clock; no implicit current time is
  read. `validFrom` is inclusive and `validUntil` exclusive. Unknown validity
  is ineligible.
- `knownAt` supplies the **knowledge cutoff**. `null` uses the snapshot's
  `recordedThrough` watermark. Facts recorded after this cutoff are excluded;
  review and observation dates cannot exceed the event's recorded date. A
  cutoff after the supplied watermark is refused.

A historical validity query with the current knowledge cutoff may use a later
import to reconstruct an earlier period. To ask what was known then, set
`knownAt` explicitly as well. Import arrival order alone never chooses a winner.
The receipt records both axes and the supplied watermark; none proves live
freshness.

## Revisions, withdrawal and deletion

Only applicable approved facts can enter a pack. Proposed or disputed records
cannot retire an approved predecessor. Conflicting visible claims in one slot,
unlinked concurrent revisions, missing or invalid lineage, and lineage cycles
fail closed. A derived claim is ineligible when any required parent is
ineligible, including a superseded, expired, conflicted or deleted parent.

Updates retain earlier events and append a higher reviewed revision with
explicit valid-time supersession links. A replacement's expiry or deletion does
not automatically restore its obsolete predecessor. An admitted, effective
replacement whose own lineage is invalid or cyclic does not restore it either:
its predecessors in the same scope and slot are excluded as `conflict`.

A `withdrawn` fact event is an append-only durable reviewed revocation revision,
with a review decision, review date and known effective `validFrom`. It never
enters a pack. Once effective and known, it retires explicit predecessors and
older revisions of the same fact in the exact original scope. Preserve the
prior approved events to reconstruct their earlier approved intervals; changing
a previous event's label in place loses that history. Equal-revision approval
and withdrawal decisions conflict and select neither. A genuinely higher
reviewed approval can express a later renewal. A withdrawn tombstone is refused.

Approved tombstones cover their explicit target event IDs and dependent
`derivedFrom` lineage within the exact admitted scope. Each target is applied
independently: a missing, unreviewed or foreign target is skipped and does not
void the deletion of the others. Current recorded deletion
decisions prevent those events from returning through historical validity or
knowledge queries. This is selection invalidation over the supplied snapshot,
not physical erasure. It does not erase original files, backups, provider
contexts or external copies, and does not prevent a new unrelated ID from being
reimported. A future import/store adapter must retain lineage and enforce its
own idempotency and deletion coverage; no broader resurrection guarantee is
claimed.

## Limits and output

| Boundary | Hard cap |
| --- | --- |
| Snapshot | 4,096 events; 32MiB exact canonical JSON bytes |
| Fact text | 16KiB UTF8 bytes |
| Source references | 1–8 per event; quotation 4KiB; locator 256 bytes |
| Lifecycle links | 32 per link array |
| Audiences | 1–32 unique IDs |
| Query text | 4KiB |
| Evidence pack | 256-byte minimum requested budget; 128KiB maximum; 1–64 facts |

Opaque IDs are bounded to 128 characters. Invalid shapes, extra fields,
accessors, sparse or custom arrays, unsupported authority fields, malformed
Unicode, unsafe controls, duplicate event IDs and over-cap inputs are refused.
Snapshot bytes are counted incrementally before allocating a whole over-cap
canonical encoding.

The existing pure `scrubSecrets` and `redactGenericHomePaths` patterns screen
free text and opaque IDs. If screening would change a value, the kernel refuses
it rather than silently rewriting a fact, quotation, locator or source claim.
This shared screening is not exhaustive private-data detection. A successful
pack says `contentSafety: 'screened-with-shared-patterns'`, not that all content
is safe to publish or send to a provider.

After eligibility checks, ranking counts unique query terms that match the
subject, slot and text. Common function words (`the`, `how`, `what` ...) are
ignored unless the query has nothing else, and ASCII words are folded by a small
fixed suffix list, so `builds`, `building` and `build` match. Other scripts are
compared exactly. An empty query gives each eligible event equal score. Ties go
to the event whose matched terms are rarer among eligible facts, then to event
ID order. There are no synonyms: a query that shares no word stem with a fact
does not find it. Each complete fact and its citations are canonical JSON
inside a fixed evidence boundary, with angle brackets escaped so quoted text
cannot close that boundary. The view (time mode, time, knowledge cutoff) and the
review disclaimer are stated once on the boundary tag rather than in every fact.
Quoted instructions remain data; `authority: false` never grants tool use,
deployment or account access.

When the query touches a slot whose claims were withheld as a `conflict` or
`revision-conflict`, the pack adds one line naming the subject, slot and number
of withheld claims, and asks the reader to check before relying on it. The
contested text itself never appears. These lines count toward the byte budget;
if one does not fit, the receipt records `conflict-notice-budget`.

The byte budget includes all returned evidence text, escaping, framing and
citations. Facts that do not fit are omitted whole with a reason. The receipt
and item metadata are separate bounded outputs, not included in that text
budget. The token estimate is explicitly UTF8 bytes divided by four, rounded
up; it is not an exact model tokenizer count.

Pack status distinguishes `ready` from `none` (no selected eligible evidence;
the text may still carry conflict lines),
`unknown`, `unavailable` and `refused`. An incomplete available snapshot is
unavailable. `none` may reflect irrelevant evidence or budget omissions; inspect
the receipt rather than interpreting it as proof that memory does not exist.
Receipts record scope, policy version, snapshot claims, temporal axes, selected
IDs and finite exclusion reasons. They do not attest execution authority or
replace authentication and output authorization in an eventual adapter.

## Minimal pure example

This TypeScript example uses fictional supplied records, performs no I/O and
makes no model or provider calls. The digest is deliberately a claim placeholder.

```ts
import { buildMemoryContextPack } from './src/core/memory/pack.js';
import type { MemoryFactEvent } from './src/core/memory/types.js';

const at = '2026-10-14T00:00:00.000Z';
const fact: MemoryFactEvent = {
  schemaVersion: 1, eventId: 'event_build_1', factId: 'fact_build', revision: 1,
  kind: 'fact', projectId: 'project_example', ownerId: 'owner_example',
  audienceIds: ['team_example'], subjectKey: 'build', slotKey: 'command',
  text: 'The project build command is npm run build.',
  sourceRefs: [{
    id: 'source_example', digest: 'sha256_' + 'a'.repeat(64), locator: 'line:1',
    quote: 'npm run build', observedAt: at,
  }],
  observedAt: at, validFrom: at, validUntil: null, recordedAt: at,
  reviewState: 'approved', reviewedAt: at, reviewerDecisionId: 'review_example',
  supersedes: [], derivedFrom: [], tombstones: [], authority: false,
};
const pack = buildMemoryContextPack({
  schemaVersion: 1, snapshotId: 'snapshot_example', revision: 1,
  recordedThrough: at, sourceState: 'available', complete: true,
  events: [fact], authority: false,
}, {
  schemaVersion: 1, projectId: 'project_example', ownerId: 'owner_example',
  audienceId: 'team_example', time: { mode: 'current', at }, knownAt: null,
  query: 'build command', maxBytes: 6144, maxFacts: 8, authority: false,
});
// pack.status === 'ready'; selectedEventIds === ['event_build_1'].
// This is an evidence result, not an agent instruction or execution permit.
```

Run the source-only regressions from a repository checkout with dependencies
already installed:

```sh
npm run test:ci -- --maxWorkers=1 --fileParallelism=false test/memory-foundation.test.ts
```

A structured persistence adapter, live authorization, actual source integrity,
concurrent append protocol, session integration and bounded active recall remain
future work. See the offline evaluation guide for what is and is not measured
before increasing automation.
