# Drive shared state v1

`replicateState(mirror, local)` merges value-free node snapshots into a local
bare Git repository and returns the merged snapshot for the caller to persist.
Provision the dedicated repository with `git init --bare <directory>` and pass
its absolute path to `new GitStateMirror(directory)`. Independent nodes can
open the same mounted repository. No network remote, credentials, commits,
checkout, hooks, or source branch changes are needed. The adapter writes a
validated JSON blob and atomically advances `refs/drive/state-v1` with Git's
old-object compare-and-swap. `StateMirror` is the seam for another storage
adapter with the same atomic semantics.

The queue dependency is absent in this checkout. `QueueRecord` in `schema.ts`
is the local `queue.v1` metadata stub. Queue owners must map their records to
this exact contract, retaining prompts and execution payloads locally. This
module does not start tasks or grant lease/merge/budget authority.

## Contract

Every record has a kind, opaque 64-character lowercase hexadecimal `id` and
`nodeId`, a nonnegative safe-integer `fencingToken`, and a nonnegative
safe-integer `updatedAt` in epoch milliseconds. Use random opaque identifiers,
not raw names, paths, secrets, or hashes of low-entropy sensitive values.

- `queue.v1`: fixed `status` enum, including terminal `cancelled`. Retain
  terminal records to prevent stale replicas from resurrecting work.
- `budget.v1`: one ID per reservation, `reservedUsd`, `spentUsd`, and status
  `reserved`, `settled`, or `released`. Revisions replace the reservation;
  replication never adds two copies of the same spend. Retain settled entries.
- `metrics.v1`: one ID per node and window, with numeric totals.
  `metricsFromRollup` accepts the output of observability `buildRollup` and
  explicitly selects totals. Project paths, model names, evidence, and budget
  details are excluded. These are snapshots, so overlapping windows must not
  be summed. Use the same ID when refreshing a node/window.

The merge key is `(kind, id)`. The greatest fencing token wins, followed by the
latest timestamp. Equal versions use canonical payload byte order as a stable
tie-break. This gives commutative, associative, idempotent merges. Fencing tokens
must come from the queue's lease allocator; this transport does not mint or
verify them. A disconnected node can replicate after reconnecting, but cannot
infer permission to execute from its cached snapshot.

Runtime validation rejects unknown fields at every record level, accessors,
serialization hooks, invalid enums, arbitrary strings, negative or nonfinite
numbers, duplicate identities, and unknown schema versions. Errors never echo
input values. Validation runs before any Git object write and again on reads.
Rollup adaptation intentionally projects the larger local object into this
schema. Secret or environment maps have no wire representation. As with any
schema, callers must not deliberately encode secrets into numeric fields or
opaque IDs.

Snapshots are capped at 10,000 records and reads at 8 MiB. Corrupt state fails
closed. CAS contention retries at most 16 times. Local Git commands have a
10-second timeout and a minimal environment without inherited Git settings or
credentials. The caller owns directory provisioning, access permissions,
retention, backups, and any eventual archival policy. This local transport is
not authentication against malicious writers who already control that repo.
Deleting records and tombstone garbage collection are intentionally unsupported
until the queue defines a safe replica watermark protocol.

Run the real Git acceptance suite with an isolated home:

```sh
HOME=$(mktemp -d) npx vitest run test/perf-server-rollup.test.ts
```
