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

export function formatChannelAck(ack: ChannelAck): string {
  if (ack.status === 'duplicate') {
    return `Already received by Phantom; no duplicate interjection added. Receipt: ${ack.dedupeKey}`;
  }
  return `Received by Phantom. Receipt: ${ack.dedupeKey}`;
}
