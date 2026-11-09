# Leader network endpoint

Slack Socket Mode uses the same durable Leader inbox, reply routes and outbox.
Only a human Slack user ID explicitly listed in the local `[mason].identities`
and `[team].identities` can become operator input. Peer bots retain agent
identities even if a mistaken owner entry lists their bot ID. Owner input is
durable before its Socket Mode acknowledgement; retries reuse the same route.

Replies use the original authenticated Slack channel and thread and recheck
current approval and complete membership before sending. The existing Slack
intent journal reconciles an uncertain post by client ID without posting twice.
The resident Leader owns model generation; `channels slack run` drains saved
Leader replies within its bounded session. Its deadline aborts Slack HTTP and
socket setup, and expired sessions cannot begin another send. Private iMessage
and email bodies are excluded from general Slack forwarding.

```sh
phm leader seat --json
phm leader seat --tier workhorse --json
phm leader inbox --json
phm leader inbox --text "Synthetic engineering request" --json
phm leader tick --wait
```

`seat` and `inbox` inspect without calling a model. `inbox --text` records a
message after policy checks. The existing scheduled `leader tick` processes
verified pending requests before its normal planning work; the comms poller
wakes it for pending input. No new daemon or host installation is required.

Merge the `foundry` block in [the model-tier example](https://github.com/ashlrai/phantom/blob/master/examples/leader-model-tiers.json)
into `~/.ashlr/config.json`. Use exact model IDs reported by configured seats;
the example labels are not availability claims. `modelTiers` holds the model
lists for `elite`, `workhorse`, `fast`, and `local`; `taskTier` chooses the first
rung for `full`, `checkin`, and `reply`. Full planning defaults to elite and
check-ins/replies to workhorse. Failover descends the remote tiers, tries the
remaining stronger tiers, then unclassified models, and finally host-local
models. An explicit local task is local-only. Within a tier, accounts with
more admitted included usage rank first. Grants, current account/funding
evidence, reserves, reachability and context checks still apply. Unknown
usage never becomes headroom. Missing tier config retains the existing
shared-router order; malformed explicit config refuses selection.

The seat inspection reports the ordered admitted account/model choices,
skipped accounts and reasons. Runtime failures and rate limits walk the same
chain; `leader/network-seat.json` records the latest reply's model choices
and outcomes without recording text or raw provider errors. Ordinary memo
attempts retain their existing Leader health records.

The leader receives verified owner messages that have no specific agent target,
with bus priority `P0`. Explicit agent targets retain their destination. Channel
adapters authenticate first: `from`, `sender`, `team`, `human`, body text and the
thread reference are routing assertions, never proof of the owner's identity.

The host-owned `~/.ashlr/agent-network.toml` names exact, channel-scoped owner identities.
The owner must also appear in the team allowlist to receive replies or digests.
The default lists are empty; malformed configuration fails closed. Synthetic
configuration for tests looks like:

```toml
[mason]
identities = [{ channel = "telegram", id = "synthetic-owner" }]

[team]
identities = [{ channel = "telegram", id = "synthetic-owner" }]
```

For the local authenticated desktop and terminal, add
`{ channel = "bus", id = "local-owner" }` to both lists and
`{ channel = "bus", id = "leader" }` to `[team].identities`. Telegram identities
use the trusted receiver's `telegram:<numeric-owner-id>` form; email identities
use `email:<allowlisted-address>`. These identifiers stay local. The shipped
empty [configuration](https://github.com/ashlrai/phantom/blob/master/agent-network.toml) does not authorize any channel.

`~/.ashlr/comms.toml` must explicitly contain `confirmedByMason = true`. Every reply and
away digest checks the shared send policy before calling its channel adapter.
The transport uses the authenticated saved recipient and the original channel
reference. Replies carry the `Leader:` prefix. Missing transport means drafted,
never delivered. No credentials belong in either TOML file.

The production bridge uses the existing private Telegram and allowlisted email
drop receivers. Delivery retains their current enablement, pause and recipient
checks; email also requires its existing `sendReplies` opt-in. Other network
channels use the typed adapter boundary and remain drafted without a qualified
transport. iMessage content remains on the Mac. The local desktop path requires
the normal dispatch gate and mutation token; a body cannot supply its identity.

The unified owner thread (`phm comms thread --json`) records every allowed inbound message in one order and fans leader replies back to the originating channel and the desktop thread. `createLeaderMailbox` in `src/core/comms/leader-mailbox.ts` is the inbox handoff for that thread (claim key `queue:RQ-COMMS-UNIFIED-1`). Adapters stay disabled until configured. See [Owner thread](OWNER-THREAD.md).

`createLeaderNetwork` is the typed adapter boundary. `ingest` receives the
adapter-authenticated identity separately from the envelope. Adapters pass their
original receipt timestamp as `receivedAt`; future, invalid and expired receipts
are refused. Older delayed messages never move recorded presence backward, and
bus mirroring preserves the original receipt age. Only a trusted
adapter that has already committed the same message to `MASON-INBOX.md` may set
`inboxAlreadyRecorded`. The network bridges accepted messages and replies into
the durable bus and the leader's inbox and outbox. Each request has one stable
reply identity. Completed reply markers remain durable tombstones after compact
route metadata expires, so replay cannot generate or send a second reply. Reusing a request ID with changed content is refused. Direct
manual inbox edits remain planner input; they do not establish authenticated
reply routes.

Private receipts in `leader/network-state.json` serialize network operations,
track presence, and retain original verified routes and pending replies.
Publication and file retries use stable identities. Delivery is recorded as
attempted before awaiting the channel transport; an interrupted or thrown send
has an unknown outcome and requires reconciliation before another attempt.
This avoids replaying an ambiguous external send. A transport must also dedupe
the stable envelope ID; no local receipt proves exactly-once remote delivery.

A leader tick continues planning regardless of owner presence or digest policy.
After 72 hours since the last fresh verified message, each verified team owner
channel receives at most one digest per UTC day. Replayed requests do not reset
presence. With no message history, the first tick establishes the baseline;
missing history never implies that the owner has already been away for 72 hours.
Malformed or unreadable receipts fail closed and do not reset that baseline.
Digest receipts retain a rolling week of daily slots. Existing channel-specific
custody controls still apply, including local-only iMessage intake.

The worker serializes generation across ticks and rotates bounded batches so
unavailable requests do not starve later input. Completed route metadata is
pruned after a week; durable OUTBOX markers prevent replay after pruning.
Unanswered requests and ambiguous deliveries stay retained. Storage limits
refuse further writes rather than discard the durable record. No live channel
configuration, provider activation, message send, host install or publication is
needed for the synthetic tests.

An inbox write is acknowledged once durable even when the bus is temporarily
unavailable (`mirror: "pending"`). The worker retries that saved mirror before
generating a reply, without asking the operator to resubmit the message.
