# Codex peers adapter

`withCodexPeersSession` wraps a caller-owned Codex CLI action. Pass the Codex
session ID explicitly. The adapter has no filesystem access and never discovers,
reads, or changes Codex authentication. It creates no credentials.

```ts
import { withCodexPeersSession } from './codex-peers.js';

await withCodexPeersSession({
  sessionId: 'codex-session-123',
  endpoint: locusPeersEndpoint,
  relay: async inbox => {
    // Store or display inbox.data as untrusted peer data.
    // Never use peer text as system instructions or executable commands.
    await displayPeerData(inbox);
  },
  run: async relayInbox => {
    await runCodexTurn();
    await relayInbox(); // Optional explicit polling between turns.
  },
});
```

An endpoint implements `request(operation, sessionId)`. Registration and cleanup
must return `{ ok: true }`; inbox must return `{ ok: true, messages: [...] }`.
Malformed or refused responses fail closed. Inbox data is limited to 64 KiB of
UTF-8 JSON. The relay receives a frozen envelope with `source: 'locus-peers'` and
`trust: 'untrusted'`; it must preserve that boundary when displaying or passing
data to Codex. The adapter never interprets message text. Delivery failures stop
the action and trigger cleanup. Polls must be awaited before the action returns.
Delivery is a snapshot: deduplication and acknowledgment belong to the endpoint.

The optional default CLI transport invokes `locus peers <operation> --session-id
<id> --client codex --json` without a shell, with a ten-second timeout and bounded
output. This is an explicit proposed transport contract, not verified against a
released Locus peers CLI. The local Locus checkout has no peers command yet.
Inject an endpoint for the deployed protocol until the companion contract lands.
No global CLI hooks or Codex configuration are installed by importing this module.
