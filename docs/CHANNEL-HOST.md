# Hosting channel input

[`examples/channel-host.ts`](../examples/channel-host.ts) is a source-level integration example, not a server or a provider client. Run its fake in-memory demonstration from the repository root:

```sh
npx tsx -e 'import { runInMemoryDemo } from "./examples/channel-host.ts"; runInMemoryDemo().then(console.log)'
```

The import alone does nothing. The demo uses fake sessions, an in-memory sink and in-memory acknowledgment transports; it opens no connection and reads no credentials.

Create one `createChannelHost` per host and retain it while handling desktop, Telegram and email events. Inject a port for each channel, an allowlist of canonical identities, and a sink that reports success only after persistence. Call the corresponding `host.desktop`, `host.telegram` or `host.email` with a body and transport evidence. Each port's `verifyIdentity` must authenticate that evidence using the provider or host's actual security boundary and map its verified account to the same canonical Mason ID. Return `null` when it cannot verify the sender. The sample fake verifier is only a fixture, not an authentication scheme.

The evidence must come from a trusted transport and bind the authenticated sender, message and reply destination; do not derive identity or a reply destination from a sender string in the message body. The host chooses the channel handler, and the example constructs the receiver message only after verification, using that channel and the adapter's canonical ID. The receiver separately enforces the allowlist and validates the body. Never pass credentials in the body or canonical identity.

All three handlers share one receiver. It normalizes message text and deduplicates by canonical identity and normalized body across channels for ten minutes from the first successful receipt. Its dedupe state is **process-lifetime in memory**, scoped to that receiver: a restart or another host instance does not share it. The stored first envelope retains its originating channel; a duplicate is acknowledged on the channel that delivered the duplicate.

On a successful receiver result, the example calls that channel's injected acknowledgment transport with the accepted or duplicate acknowledgment and the original transport evidence. `acknowledgement: 'sent'` means the transport resolved, not that a person received it. A rejected transport produces `acknowledgement: 'failed'` while the successful receipt remains intact; the receiver has already recorded the write, so a retry within the window is a duplicate. A failed or rejected sink returns the receiver's failure reason and sends no acknowledgment; a retry can be accepted. Unverified or failed authentication also sends no acknowledgment and writes nothing. The host must decide how to observe and retry delivery failures. This example sends after `receive` returns so it can report transport failures; the receiver's optional callback itself swallows transport errors and is best effort. Do not use both acknowledgment mechanisms for the same delivery.
