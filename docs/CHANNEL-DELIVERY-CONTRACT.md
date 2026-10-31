# Channel delivery contract

`createChannelReceiver` is the shared inbound boundary for a trusted channel
adapter, not an authentication or transport service. Before calling it, the
adapter must authenticate the sender using its channel's trusted evidence and
map that identity to a canonical `verifiedSenderId`. Use the same canonical ID
for the same person across channels, and configure `allowedSenderIds` with the
permitted IDs. Never use a sender or channel asserted in the message body as
proof of identity. The receiver checks the supplied ID against the allowlist; it
does not independently verify the adapter's claim.

The default inbox records the receiving channel as its displayed `source`; it
does not record `verifiedSenderId`. Source is presentation, not identity or
evidence of who sent the message. A duplicate does not replace the original
entry's source. Applications needing durable sender attribution must provide
their own trusted persistence; they cannot recover it from the inbox source.

## Receipt and acknowledgement

The receiver normalizes the body to Unicode NFC, converts CRLF and CR to LF,
and trims surrounding whitespace. For ten minutes from the first successful
receipt, the same canonical sender and normalized body deduplicate across
channels. A duplicate does not extend that window. Different canonical senders
remain distinct. The first receipt returns an `accepted` ack; a duplicate returns
`duplicate` with the same dedupe key and the current receiving channel.

With the default inbox sink, receipts persist in the shared `runsDir` (default
`~/.ashlr-runs`), so separate receivers using that directory share deduplication.
A custom `write` sink with no `runsDir` and no `receiptStore` keeps receipts only
in that receiver's memory. A custom sink with `runsDir` uses its local receipt
store, or the caller can supply a `receiptStore` that serializes lookup, sink
write and receipt commit across its users. A custom sink must report success
only after persistence.

The sink write and receipt commit are separate operations. A crash or receipt
commit failure after a successful write can leave an inbox entry without a
receipt; a retry may append again. This is not an exactly-once guarantee. A
refused or failed sink write does not reserve a receipt or trigger an ack, and
receipt-store failures return an error without an ack.

The optional `acknowledge` callback is attempted after an accepted or duplicate
receipt. It is best effort: a callback failure is swallowed, and a successful
receive result does not prove delivery of the ack. Route the callback through
the same authenticated channel and reply context that received the message.
The callback receives a detached ack and is awaited while calls to that receiver
are serialized; it must not await another receive on the same receiver.
`accepted` means the sink accepted the entry and the receipt was committed; it
does not mean a leader read or acted on it. `duplicate` means a matching receipt
was already recorded within the window, not that the leader acted on it.

## Minimal use

The following assumes the adapter has already authenticated the request,
resolved its canonical ID and captured the same-channel reply function. These
values are supplied by the adapter, not parsed from the body.

```ts
import { createChannelReceiver } from '../src/core/fleet/channel-envelope.js';

const receive = createChannelReceiver({
  runsDir, // shared by the channel adapters using the default inbox
  allowedSenderIds,
  acknowledge: async (ack) => { await replyOnThisChannel(ack); },
});
const result = await receive({ channel: 'email', verifiedSenderId, body });
// Handle !result.ok as a refusal; no successful ack was attempted for it.
```

Bind `replyOnThisChannel` to this request's authenticated reply destination.
If a receiver is shared across requests, its callback must instead route each
ack to the appropriate originating channel and reply context; the channel field
alone does not identify a particular conversation.
