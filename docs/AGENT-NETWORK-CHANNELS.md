# Agent network channels

The Agent Bus can carry channel metadata alongside its existing envelope. Legacy
six-field messages remain valid. Channel-aware messages identify the channel,
opaque thread or chat reference, sender, whether any participant is external,
and optionally the originating bridge. An adapter must reject its own origin
before ingesting a message. These fields are assertions, not authentication.

`agent-network.toml` declares team identities and contains no credentials. Its
empty default allowlist denies every recipient. Entries use channel-scoped exact identities, for example `identities = [{ channel = "slack", id = "U123456" }]` under `[team]`. The shared send policy refuses
external or unknown recipients. It returns drafted when the local `comms.toml`
does not explicitly confirm `confirmedByMason = true`. A `sent` result means the policy conditions passed; it does not mean a message was delivered or grant authority to send. Real iMessage data stays on the Mac.

The following commands inspect the channel contract offline. No adapters are
registered by this change, and testing reports a refusal without sending or
using the network.

```sh
phm agents bus channels list --json
phm agents bus channels test email --json
```

Adapters implement `ChannelAdapter` and must enforce the loop guard and shared
send policy before any delivery. Credentials must be resolved at request time
through Phantom Secrets references; do not put them in configuration or logs.
