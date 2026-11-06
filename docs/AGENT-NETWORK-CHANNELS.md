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

## Slack bridge configuration

The `[slack]` table configures the bridge adapter (mapping and inbound parsing
are live; the socket, token injection and post path ship in a separately
reviewed `-sec` change):

```toml
[slack]
team_id = "T0WORKSPACE"                        # required: workspace every event and member binds to
bridge_id = "slack"                            # optional: origin_bridge value and loop-guard key
own_user_id = "U0BRIDGEBOT"                    # optional: drop the bridge bot's own events
own_bot_id = "B0BRIDGEBOT"
bot_token_ref = "phm_SLACK_AGENTNET_BOT_TOKEN" # optional: Phantom Secrets reference NAMES
app_token_ref = "phm_SLACK_AGENTNET_APP_TOKEN"

[[slack.map]]
topic = "leaders"                              # bus routing label <-> Slack channel id
channel = "C0AGENTNET"
```

Parsing is strict and fails closed: an unknown key, out-of-grammar id,
non-`phm_` token reference, duplicate topic or channel, or more than 64 map
entries marks the whole `[slack]` section invalid and nothing is configured.
Bus threads map to Slack threads deterministically: the root `thread_ts` (or the
message `ts` at channel root) becomes `slack:<teamId>:<channelId>:<rootTs>`,
carried as `channel_ref` and `body.thread`. Inbound accepts `message` (plain,
`bot_message`, `thread_broadcast`) and `app_mention` events whose workspace,
mapped channel and allowlisted author all check out; everything else is ignored
and journaled under `~/.ashlr-runs/slack-bridge/` by id and reason code alone.

```sh
phm channels slack status --json
phm channels slack map --json
phm channels slack map --topic leaders --snapshot ./audience.json --json
```

`status` and `map` are read-only: no socket, no Slack API call, no credential
IO. `map --snapshot` evaluates a saved `{conversation, members}` JSON through
the audience gates (no shared/Connect/DM, fully-paginated members, every member
team-bound, non-guest, non-deleted, allowlisted or the bridge itself) and the
shared send policy. See [the Slack bridge section](AGENT-NETWORK.md#slack-bridge)
for the full app-scope list Mason grants.

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
