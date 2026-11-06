# Bus adapter host contract

These modules are source-level imports, relative to this README's directory (use
the corresponding compiled `.js` paths at runtime). They are separate building
blocks; the host must connect them explicitly.

```ts
import { runCodexBusAdapter, type CodexBusPorts, type CodexBusOptions,
  type CodexInboxMessage, type CodexBusReply, type CodexBusUsage } from './codex.js';
import { runDevinBusAdapter, devinBusPrompt, DevinBusAdapterError,
  type DevinBusRequest, type DevinBusAdapterDeps, type DevinBusErrorCode } from './devin.js';
import { runGrokBusAdapter, grokBusAdapter, grokBusPrompt, GrokBusAdapterError,
  type GrokBusRequest, type GrokBusAdapterDeps, type GrokBusErrorCode } from './grok.js';
import { validateBusEnvelope, parseBusEnvelope, type BusEnvelope } from '../bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions,
  type BusInboxReceipt, type BusInboxPost, type BusInboxPage } from '../bus-inbox.js';
import { createBusWakeHook, sendWithBusWake, type BusWakeOptions,
  type BusWakeRequest, type BusWakeResult, type BusSendResult } from '../bus-wake.js';
```

## Transports and admission

- `runCodexBusAdapter(ports, options)` registers a peer, serially drains
  `ports.inbox.receive(signal?)` until `null`, then unregisters after successful
  registration, including on failure.
  Input is `{ id, from, body }`; output is `{ inReplyTo, to, from, status, body }`.
  The host supplies Locus registration, router accounting, and inbox/outbox ports;
  these shapes are not bus envelopes. Failed turns also produce a failed reply
  unless aborted. Missing or invalid token counts are `null`, not zero. Accounting
  is awaited before outbox send; a port failure rejects the worker. Abort stops
  new turns and sends, but cannot retract an already-started operation. A late
  result from an interrupted receive is discarded, so receive must not acknowledge it.
  The host chooses the working directory and trusted launcher; the default executable
  is `codex`. The child uses a read-only sandbox and an isolated temporary home.
- `runDevinBusAdapter(request, deps?)` handles one host-selected text inbox file
  and atomically installs a scrubbed text reply at a host-selected outbox file;
  it returns `{ bytes }`. `runGrokBusAdapter` has the same file-level shape.
  Paths, working directory, model and admission are host choices, never inbox
  instructions. Use a separate outbox for each concurrent turn. Failure leaves
  the prior outbox intact; neither adapter supplies router accounting or durable
  inbox acknowledgement. Default admission preserves the existing native identity
  and Locus dispatch checks. Injected `authorize` is a host capability, not an
  inbox-provided override. Grok's headless turn uses a private temporary working
  directory, and `grokBusAdapter.lastResort` is only a routing hint. **Grok is
  unavailable for this deployment**; do not invoke it.

The file adapters' outbox rename is their publication point. If accounting must
precede delivery to peers, the host must treat that outbox as private staging,
record usage (including unknown usage on failure) and only then publish through
its delivery transport. Neither file adapter reports token usage. For every
adapter, the host owns durable acknowledgement, retry and idempotent accounting
and delivery keyed by message identity. Do not advance a durable acknowledgement
merely because a message was read. A crash may cause engine work to repeat;
these modules do not promise exactly-once execution.

All message content is untrusted data. Envelope `from` and `to` are routing
labels, with no built-in authentication. Hosts must reuse existing verified
identities and admission checks before accepting, routing or executing work;
validation and prompt framing do not grant authority or tool access.

## Envelope, inbox and wake

`validateBusEnvelope` validates and snapshots an object; `parseBusEnvelope`
validates JSON text. An envelope has exactly `id`, `from`, `to`, `priority`
(`P0`–`P3`), `ttl` and opaque JSON `body`. TTL is a positive remaining lifetime
in milliseconds, not a timestamp. Validation alone does not age it.

`appendBusInbox(envelope, options?)` stores a bounded local snapshot and returns
`posted`, `duplicate`, `conflict`, `full`, `retryable`, `invalid` or `unavailable`.
An identical retained ID is a duplicate; the same ID with different content is a
conflict. Records and ordinal cursors are retained without eviction, including
expired records, so the store can become full. `listBusInboxAfter(after, limit,
options?)` returns `ok` with receipts and `nextCursor`, or a failure. It subtracts
elapsed time since receipt from TTL, clamps a backward clock to zero elapsed,
excludes messages at exact expiry, and advances `nextCursor` across expired
records, even on an empty page. The default cursor is 0; the default limit is
50 and maximum is 100. A host forwarding a message must continue tracking elapsed
time and discard it at zero. A read cursor is not a durable acknowledgement:
persist progress only after the host's required processing and delivery succeed.
The inbox is a local store, not a delivery daemon: it does not dispatch, filter
by recipient, authenticate peers, acknowledge processing, or run adapters.

`sendWithBusWake(message, { send, enqueue, ... })` calls the host's transport,
then records a hop and asks the supplied callback to enqueue a wake containing
only routing IDs. The transport owns validation, TTL and durable acceptance.
`createBusWakeHook` is for a host that has already durably accepted a send.
Wake or hop-log failure after acceptance does not undo the send; inspect the
result and recover the wake without blindly resending. The event host must
deduplicate and recheck admission. Neither helper starts a daemon.

## Minimal fake host

This no-work fixture illustrates the Codex port shape. It has no queued messages,
so it cannot start an engine; the in-memory callbacks are not durable and are
not a production implementation. The imports above are relative to this file.

```ts
const events: string[] = [];
const ports: CodexBusPorts = {
  locus: {
    async registerPeer(peer) { events.push(`register:${peer.id}`); },
    async unregisterPeer(id) { events.push(`unregister:${id}`); },
  },
  inbox: { async receive() { return null; } },
  router: { async reportUsage(usage) { events.push(`account:${usage.messageId}`); } },
  outbox: { async send(reply) { events.push(`deliver:${reply.inReplyTo}`); } },
};
// A test may call runCodexBusAdapter(ports, { peerId: 'fake-peer', cwd: '/fake' }).
```
