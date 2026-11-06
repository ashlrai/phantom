/** Text formatter for channel acknowledgement payloads.

Trust contract: the caller supplies a `ChannelAck` produced by
`createChannelReceiver` on a successful or deduplicated receipt.
This module emits no secrets, bodies, or sender identities.

Adapter import example:
```ts
import { formatChannelAck } from '../core/fleet/channel-ack-text.js';
const payload = formatChannelAck(ack);
// pass `payload` as the same-channel acknowledgement payload
```
*/
import type { ChannelAck } from './channel-envelope.js';

const ENTRY_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export function formatChannelAck(ack: ChannelAck): string {
  if (ack.status === 'duplicate') {
    const id =
      typeof ack.entryId === 'string' && ENTRY_ID_RE.test(ack.entryId)
        ? ack.entryId
        : undefined;
    if (id) {
      return `Already received by Phantom from another channel; this one is attached to that instruction (entry ${id}). Receipt: ${ack.dedupeKey}`;
    }
    return `Already received by Phantom; no duplicate interjection added. Receipt: ${ack.dedupeKey}`;
  }
  return `Received by Phantom. Receipt: ${ack.dedupeKey}`;
}
