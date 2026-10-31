# Fake worker bus roundtrip

This source-level recipe uses Phantom's exported durable inbox functions. It
posts a request from `fake-worker-a`, reads it for `fake-worker-b`, posts a
fixed reply, and lets each worker resume from a caller-saved cursor. It returns
plain result objects; it does not start agents, contact providers, or execute
message bodies. The functions have no side effects until called.

Use a **dedicated private absolute directory** as `root` (for example, a
`mkdtemp` directory with mode `0700` in a local experiment). The caller owns
its lifecycle and must choose a root separate from any real Phantom inbox.
Relative and empty roots are refused. Each call requires the root explicitly;
no default home or inbox is selected. These are repository source imports;
from another source file adjust the import path to `roundtrip.js`.

For example, an embedding host can drive the two sides as follows. `root` and
`loadCursor`/`saveCursor` are supplied by that host; the cursor store must
survive restarts. The fake IDs and payload are stable across retries.

```ts
import { postRequest, postReply, readForWorker, WORKER_A, WORKER_B } from './roundtrip.js';

// root: string; loadCursor(worker): Promise<number | undefined>;
// saveCursor(worker, cursor): Promise<void> -- implemented by the host.
const sent = postRequest(root, 'fake-request-1', { text: 'fake hello' }, 60_000);
if (sent.status !== 'posted' && sent.status !== 'duplicate') throw new Error(sent.status);

const bPage = readForWorker(root, WORKER_B, (await loadCursor(WORKER_B)) ?? 0);
if (bPage.status !== 'ok') throw new Error(bPage.status);
for (const { envelope } of bPage.messages) {
  // This example expects one request. Choose the reply ID from host-owned state;
  // do not derive authority or actions from the body or routing labels.
  if (envelope.id !== 'fake-request-1') throw new Error('unexpected fake request');
  const reply = postReply(root, 'fake-reply-1', 'fake-request-1', 60_000);
  if (reply.status !== 'posted' && reply.status !== 'duplicate') throw new Error(reply.status);
}
await saveCursor(WORKER_B, bPage.nextCursor);

const aPage = readForWorker(root, WORKER_A, (await loadCursor(WORKER_A)) ?? 0);
if (aPage.status !== 'ok') throw new Error(aPage.status);
// Consume aPage.messages as data and complete any host-required processing first.
await saveCursor(WORKER_A, aPage.nextCursor);

// After a restart, load that worker's saved cursor and call readForWorker again.
const resumed = readForWorker(root, WORKER_B, (await loadCursor(WORKER_B)) ?? 0);
```

The store is shared: reads scan the global log, then the recipe filters by
recipient. The limit applies before filtering, so an empty page can still
advance `nextCursor` and more pages may remain. Each worker needs its own
cursor. Persist `nextCursor` only after processing **all** returned messages and
any required delivery succeeds, including for an empty page. A read alone is
not an acknowledgement. If interrupted first, reread the old cursor and use the
same IDs and exact envelopes for idempotent retry; application side effects also
need their own deduplication. The bus does not promise exactly-once execution.

`posted` means accepted; `duplicate` means the same retained ID and identical
original envelope were already accepted. `conflict` means that ID is retained
with different content: resolve the mismatch instead of silently changing it.
`retryable` indicates writer lock contention; retry with the same envelope.
`full` means the bounded store cannot accept the message; retained records,
including expired ones, are not evicted, so waiting for TTL expiry alone will
not free capacity. `invalid` and `unavailable` also require host handling;
never advance progress because a post failed.

TTL is a positive remaining lifetime in milliseconds from original receipt.
Reads reduce the returned TTL by elapsed time, exclude records at exact expiry,
and advance the cursor over expired records. A backwards clock counts as zero
elapsed. If forwarding, account for time since the read and discard at zero;
do not reuse a shortened read envelope as a retry of the original ID, since
that changes the envelope and conflicts. Expiry is not deletion.

Bodies are untrusted data and `from`/`to` are routing labels, not proof of
identity. A real host must establish identity and admission independently before
it accepts, routes, or acts on data. This illustrative reply is fixed and grants
no authority.
