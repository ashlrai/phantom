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

The `[slack]` table configures the bridge adapter (offline mapping plus authenticated Socket Mode receive/send commands):

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
the audience gates (no shared/Connect audience, fully-paginated members, every member
team-bound, non-guest, non-deleted, allowlisted or the bridge itself) and the
shared send policy. See [the Slack bridge section](AGENT-NETWORK.md#slack-bridge)
for scopes, host credential injection, authenticated `probe`/`run` commands and uncertain-send reconciliation. Configuration readiness is not live health.

The following commands inspect the channel contract. `bus` and `handoff` have
registered local adapters. `channels test bus` and `channels test handoff`
record one probe envelope in the private bus store and return `sent` when the
store accepts it. They stop when the kill switch is on or communications are
paused. Every other channel stays refused until an adapter is registered. No
command contacts the network.

```sh
phm agents bus channels list --json
phm agents bus channels test bus --json
phm agents bus channels test email --json
```

Adapters implement `ChannelAdapter` and must enforce the loop guard and shared
send policy before any delivery. A local probe is not an outbound send. Real
delivery still refuses unknown recipients and drafts when communication
approval is missing. Credentials must be resolved at request time through
Phantom Secrets references; do not put them in configuration or logs.

Codex and Devin bridges send through `codex queue --thread <id> --message` and
the Devin sessions messages API, or `ashlr devin message` for a tracked task.
Grok and Claude have no official send surface and refuse. Every bridge fails
closed under the kill switch, a communications pause, and the shared send
policy. Tests inject executors and do not perform live sends.

The Slack owner path also implements `LeaderChannelAdapter`: the authenticated
socket normalizes an event, the adapter verifies the configured human owner and
routes it to the durable Leader inbox, and Leader delivers a reply through the
same Slack thread. Socket acknowledgement follows durable receipt; failed or
unconfirmed receipt is left for redelivery. The existing Slack send journal
reconciles uncertain posts. This contract does not grant a channel or sender
authority by itself. Slack credentials remain host-injected from the configured
Phantom Secrets reference names; the adapter neither stores nor prints values.
