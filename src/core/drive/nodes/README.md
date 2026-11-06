# Drive node authority

`DriveNodes` provides a node registry, leader election through heartbeats, and
fenced job claims. `LocalNodesStore` persists all three in one atomic snapshot
under the existing fleet local-store lock. Use a canonical path without symlink
components (including the macOS temporary-directory alias). Like fleet lane locks, uncertain or
unreadable authority fails closed instead of granting work. No credentials or
external service are needed.

```ts
const nodes = new DriveNodes(new LocalNodesStore(privateDirectory));
const session = nodes.join('worker-1');
if (!session) throw new Error('Node ID already live');
const leadership = nodes.heartbeat(session)?.leader;
nodes.enqueue('job-1');
if (leadership?.nodeId === session.nodeId) {
  const claim = nodes.claim(leadership, session, 'job-1');
  if (claim) nodes.complete(claim, 'result');
}
```

Call `heartbeat(session)` periodically, comfortably within both the node and
leader TTLs (defaults: 30 seconds and 10 seconds). Every live node participates:
a follower heartbeat acquires leadership automatically when the old leader
expires. Leader renewal preserves its token; acquisition allocates a larger
one. `renewClaim` extends a current claim (default 30 seconds). An expired
session must `join` again. Duplicate live node IDs are refused. `leave` revokes
the session immediately and enables failover without waiting for expiry.
Expired registry entries remain visible with their deadlines for diagnosis.

A durable global counter supplies node sessions, leader epochs and claim fencing
tokens. Never delete, restore an older copy of, or independently replicate the
state directory while workers can execute. Counter exhaustion, corrupt state,
clock regression, uncertain lock ownership and storage failure all refuse
operations. A failure after rename can have committed the operation; inspect
state before retrying. Completion is terminal and a repeated completion returns
false. Enqueue deduplicates job IDs, including completed jobs.

The authority compares the stored session, leader epoch, claim token and expiry
inside the same transaction that completes the job. A leader transition fences
all claims from its previous epoch immediately, even if their own TTL remains.
A stale worker cannot renew or complete; a live leader can reassign its job with
a higher token. Caller-provided expiry never grants authority. Tokens are
internal concurrency identifiers, not authentication credentials.

Fencing guarantees one accepted completion, not exactly-once execution of
arbitrary external effects. A paused worker can resume after failover. Executors
must pass the fencing token to an effect sink that rejects stale generations,
or use an idempotency key based on the job ID. Do not dispatch unfenced external
effects and infer safety from a lease check before the effect.

`queue-v1.ts` is the explicitly provisional `queue.v1` interface for
RQ-PHANTOM-DRIVER-1-QUEUE, which is absent from this checkout. Its adapter here
owns queue status in the same transaction as lease state. When the real queue
lands, replace the stub only with an adapter that atomically checks the fence
and commits queue completion at its authority. Calling a remote completion API
after releasing the local lock would violate this contract.

This backend coordinates processes on one host and one private local directory.
It is not an NFS or multi-host consensus protocol. A remote store must supply
serializable transactions and one authoritative clock. The constructor's clock
injection is for deterministic testing. Capacity is bounded to 16 MiB of state
and 64 KiB per result; completed records must not be pruned in a way that permits
job ID reuse or fencing counter rollback.
