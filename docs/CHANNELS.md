<!-- Keep under ~120 lines when the file is complete. Source: origin/master files. -->

# Channel guide

Every external message — Mason on Telegram, a CLI inbox post, a mobile
interjection, the desktop composer, the Phantom page, or a drop-folder
email — lands in one shared inbox, gets deduplicated, carries its source,
and receives a same-channel acknowledgement.

## Where messages land

- `~/.ashlr-runs/leader/MASON-INBOX.md` — the durable receipt store
  ([`appendInboxEntry`](../src/core/fleet/mason-inbox.ts)).
- The durable agent bus (readable via `phm comms bus read`) — mirrors
  accepted receipts through [`publishChannelEnvelope`](../src/core/fleet/channel-bus-publish.ts).
- Both paths are driven by the shared [`createChannelReceiver`](../src/core/fleet/channel-envelope.ts), so a duplicate never writes a second entry.

## Channels

`INBOUND_CHANNELS` lists **email · telegram · mobile · desktop · page · cli**
and each channel has display labels in
[`fleet-channels-model.ts`](../src/web-ui/routes/verse/fleet-channels/fleet-channels-model.ts).

### Telegram

Private chat to the configured bot ([`telegram-inbox-bridge.ts`](../src/core/comms/telegram-inbox-bridge.ts)).
Verified as Mason when `comms.telegram.chatId` in the config matches the event's
`senderUserId` (canonical ID: `telegram:<id>`). Explicitly enroll that private owner
with `phm comms pair-telegram` on the local host, or send `/pair <code>` from the
configured account using the existing private operator secret. A later identity
is refused; setup never overwrites an existing pairing record.
Plain language is enough: "how's the fleet?" returns the short glance, and any
other sentence is an order in `MASON-INBOX.md`. Setup is the existing bot token
and chat id ([operator glance](OPERATOR-GLANCE.md)).

### CLI

`phm comms inbox post --file <file|->`
([`comms-inbox.ts`](../src/cli/comms-inbox.ts)).  Verified as Mason when the
CLI operator's sender ID is in the allowlist (canonical ID: `local-operator`).

### Email

Run `phm comms setup-email` for local drop paths and the Mail.app rule / trusted
forwarder recipe. Save only Mason's independently verified addresses with
`phm comms email-drop <inboxDir> --from <verified-address> --save-config`.
The saved `~/.ashlr-runs/queue/email-drop.json` enables email in the existing
`phm comms cycle`; `phm comms email-cycle` runs that same email pass directly.
Set `enabled: false` to pause both ingestion and reply sending (omitting it
preserves enabled behavior for existing saved configs). Unknown senders remain
in the processed archive, without inbox steering or replies. Message-ID dedupe
prevents a second inbox entry or bus publication.

Drop-folder delivery via [`email-drop-bridge.ts`](../src/core/comms/email-drop-bridge.ts):
an external mail path saves raw RFC 822 files (`*.eml`) into an inbox directory;
Phantom parses, checks the allow-listed From address, writes the body, and drops a
`.reply.eml` into the outbound folder.  Sending those replies is opt-in on
macOS: `phm comms email-drop … --save-config --send-replies` stores
`sendReplies: true`, after which each `phm comms cycle` pass drains the outbox
through Mail.app — claimed atomically, sent exactly once, never retried from a
crashed claim.  Replies go only to the config's allow-listed `from` senders;
`ashlr fleet email-outbox [--send] [--json]` shows what is queued, sent or
stuck.  Mail.app cannot set `In-Reply-To`, so replies start a fresh thread.
Pairing and exact-domain DKIM are mandatory. When `PHANTOM_OPERATOR_SECRET` (or `~/.ashlr/comms/operator-secret`) is set, mail
also needs a DKIM pass for the sender's domain and that secret once; later mail
from the paired address stays plain language. See [operator glance](OPERATOR-GLANCE.md).

### Desktop

Sent from the desktop composer; source string is `"Phantom desktop"`
([`mason-inbox.ts`](../src/core/fleet/mason-inbox.ts) default source).  No
separate verification gate — the source is the channel label.

### Mobile

The remote phone gateway sends through the mobile channel
([`channelKey`](../src/web-ui/routes/verse/fleet-channels/fleet-channels-model.ts)
matches `mobile` / `remote` / `phone`); the gateway pins `"Phantom mobile"`
as the source for phone-originated writes.  Not a separately-verified sender.

### Phantom page

Messages sent through the Phantom page are captured under the `page` channel
label in the Channels pane (`"page"` / `"7790"` source match).  No separate
verification — the page source is the channel label.

## Dedupe · attribution · acknowledgment

- **Dedupe window** — 10 minutes (first receipt, across restarts);
  [`CHANNEL_DEDUPE_WINDOW_MS`](../src/core/fleet/channel-envelope.ts).
- **Duplicate acknowledgement** — `"Already received by Phantom; no duplicate interjection added. Receipt: <key>"`
  (see [`formatChannelAck`](../src/core/fleet/channel-ack-text.ts)).
- **Attribution** — the `source` field in every inbox entry (e.g. `"telegram"`,
  `"Phantom mobile"`); the default source falls back to `"Phantom desktop"` when
  a channel omits one ([`mason-inbox.ts`](../src/core/fleet/mason-inbox.ts)).
- **Ack timeout** — 2 000 ms per [`CHANNEL_ACK_TIMEOUT_MS`](../src/core/fleet/channel-envelope.ts);
  the transport is best-effort and never unwrites a durable receipt.

## Is each channel working?

`phm channels` prints one row per channel you reach the Leader on: email,
Telegram, iMessage, mobile, the desktop app, the Phantom page, the terminal
and Slack. Each row says `connected`, `not set up`, `failing` or
`unknown: <reason>`, when the channel last carried a message in and out, how
many messages arrived in the last 24 h, how many senders are verified, the
channel's address (masked to its last four characters) and, when it is not
connected, the one next step. Failing channels come first.

```sh
phm channels          # the table
phm channels --json   # schema phantom.channels.v1, same as GET /api/channels
```

The desktop app's **Channels** pane (⌘K → "Open pane: Channels") draws the
same JSON as one card per channel. A value no source can prove reads
`unknown`, never a guessed zero; last outbound is `unknown` for channels
without a per-channel delivery receipt yet. A `~/.ashlr/config.json` that
exists but cannot be read makes the facts it feeds — Telegram's setup state
and the iMessage verified-sender count — read `unknown` as well, never a
guessed "not set up" or 0; the iMessage count itself is the size of the
`comms.imessageAllow`/`imessageHandle` allowlist, not just the handle.

## Setup and status from the CLI

`phm channels` is the one path: `add` writes a channel's config and nothing
else — no transport, no pairing, and no credential. Tokens and secrets stay in
their existing custody (`TELEGRAM_BOT_TOKEN`, `PHANTOM_OPERATOR_SECRET`, or the
private files above) and are never accepted on the command line or printed.

```sh
phm channels add telegram 123456789          # your numeric chat id; token stays in TELEGRAM_BOT_TOKEN
phm channels add email /path/to/mail-in --from you@example.com
phm channels status --json
```

`phm comms setup-telegram` still discovers the chat id. `status` reports each
channel's `configured`/`credential`/`paired` state plus `received`,
`pendingOutbound`, and `lastSeenAt` — measured numbers, or `"unknown"` when a
source cannot be read. Pairing stores follow the same rule: a missing
`queue/telegram-pair.json` or `queue/email-paired.json` is a measured
unpaired/zero, while an unreadable or malformed record reports `"unknown"` —
never a guessed "not paired". `cli`, `desktop`, and `page` need no setup and
always report ready; `mobile` needs the `~/.ashlr/verse-remote.json` gateway
file ([REMOTE-PHONE.md](REMOTE-PHONE.md)).

## Where to watch it

- **Desktop console** — the Channels pane (one card per channel), the
  Channel activity pane (inbox traffic per channel) and the Inbox pane.
- **CLI** — `phm channels [--json]` shows every channel's state;
  `phm channels status [--json]` rolls the six inbox kinds up;
  `phm comms bus read` shows every accepted bus envelope;
  `phm comms inbox read` reads the inbox file directly.
- **API** — the `GET /api/verse/fleet/runs/inbox` route exposes the inbox in JSON.

## One owner thread

`phm comms status --json`, `phm comms thread --json` and `phm comms send-owner --text "<reply>" --json` are the single owner thread across desktop, Telegram, email, iMessage and Slack. Inbound messages from the configured owner land in one ordered thread. A reply goes back to that channel and to the desktop thread, and nowhere else. Adapters stay disabled until configured. Secret fields are Phantom Secrets handle names. KILL and the comms pause halt every adapter. See [Owner thread](OWNER-THREAD.md).

## Send each update to the right channel

`phm notify rules` shows which channel each kind of update goes to, and
`phm notify rules set <type> <channel>` changes one. The Rules card in the
desktop Channels pane shows and edits the same rows through
`GET`/`POST /api/notify/rules` (`phantom.notify.rules.v1`).

| Update | Default channel | When |
| --- | --- | --- |
| `decision` (decisions and approvals) | iMessage | Now; reply YES or NO |
| `incident` | iMessage | Now |
| `texts-digest` (a digest whose `source` is `texts`) | iMessage | Once a day |
| `digest` (email and LinkedIn digests) | Email | When the digest is ready |
| `shipped` | Email | Next digest |
| `fyi` | Desktop app | Now |

Every update is also shown in the desktop app. Rules live in
`~/.ashlr/comms/notify-rules.json`; with no file, or one that cannot be used,
the defaults above apply and the view says why.

`phm notify route <update.json> --json` classifies one update and prints its
delivery plan (`phantom.notify.plan.v1`). It never sends: the owner-thread
adapters do. The update is a JSON object with optional `id`, `type`, `source`,
`text`, `status` and `to`. A named `type` wins (`approval`, `merged` and
`status` are older names for `decision`, `shipped` and `fyi`); without one the
text decides. An unrecognized type is `unknown` and goes to the desktop app
only. `status` keeps RECEIVED, ASSIGNED, RUNNING, BLOCKED or VERIFIED exactly;
any other word is `unknown`. Every step carries the one `owner` thread id, so a
reply on any channel lands in the same thread. A `to` outside the `[mason]` and
`[team]` identities in `~/.ashlr/agent-network.toml` makes every step a
`draft`, never a `send`.

## Preview an update route

`phm notify route approval` prints a JSON plan by default. Add `--text` for
plain words. `--dry-run` is always on: this command never sends, queues,
records a reply, reads credentials, or changes the shared owner thread.

| Update type | Preferred channel | Fallback | When |
| --- | --- | --- | --- |
| `decision` | iMessage | Desktop | Now; reply YES or NO |
| `approval` | iMessage | Desktop | Now; reply YES or NO |
| `digest` | Email | Desktop | Now, for an already prepared digest |
| `incident` | iMessage | Desktop | Now |
| `merged` | Email | Desktop | Next digest |
| `status` | Desktop | Email | Now on desktop; next digest if using email |

The typed table and planner live in [`owner-channel.ts`](../src/core/comms/owner-channel.ts).
Every plan names the existing `owner` thread. No second inbox or outbox is created.
Availability is a supplied scenario, not a live probe: omitted channels stay
`unknown`, including `wouldSendNow` for an immediate route with unknown health.
Use `--unavailable imessage --available desktop` to preview an iMessage outage.
These flags may repeat for different channels; contradictory or duplicate entries
are refused. If both channels are unavailable, the channel is `null`, delivery is
`blocked`, and `wouldSendNow` is false. Batched updates also report false.

Decision and approval plans specify a one-word `YES` or `NO` reply and reference
the existing `ownerAllowed` check, which accepts only the exact configured owner ID.
The existing `acceptOwnerInbound` receiver enforces that check before recording
messages. Availability flags never verify an identity or authorize sending.
This preview does not wire one-word replies into approval execution or schedule
digests. Actual adapters still enforce owner verification, KILL, pause and send policy.

## Unified inbox

`phm comms inbox [--source <name>] [--kind <name>] [--severity <info|warn|high>] [--blocking] [--job <id>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--json]`
([`unified-inbox.ts`](../src/core/comms/unified-inbox.ts)) is the read-only
roll-up of everything still pending, ranked the way Needs-you ranks: severity
band, then priority, then expiry, then newest. It aggregates local sources
— unresolved `NEEDS-MASON.md` items classified by the same
`classifyNeedsYou` verdict `phm needs-you` reports (only a hard-limit item —
secrets, money, an outside send, destroyed data, a sign-in, or unclear
wording — blocks Mason; an auto item is ordinary work the fleet clears with
`phm needs-you resolve --auto`, so it lists non-blocking), needs-you answers
whose planner-inbox
relay is not confirmed — the same `readNeedsMasonReplyDeliveries` receipts
`phm fleet needs` reports as `replyDeliveries`, so the two surfaces can never
disagree; each pending receipt lists as a warn whose retry resolves the same
id again (the recorded reply is reused, never re-asked) and each receipt that
failed validation lists as unreadable with its delivery state unknown —
unanswered allowlisted teammate texts, unsettled Dot/Instinct teammate
tasks (the same `imessage.teammate-tasks.v1` ledger `phm fleet
imessage-tasks list` serves: queued, sending, pending, replied and expired
rows the drain still owes work on — cancelled and settled rows never list,
a replied task's RESULT text stays under this source rather than listing
twice, `expiresAt` is the task's real deadline while it is still the peer's
obligation and null once replied or expired, and each item deep-links
`phm fleet imessage-tasks dispatch --apply` and `list --job`),
live owner-thread inbound messages no recorded outbound reply cites (the same
awaiting-reply mark `phm comms status` counts, each item deep-linking
`phm comms thread` and `phm comms send-owner --reply-to`), recorded owner
replies whose channel fanout is not fully delivered — the delivery side of the
same mark, which counts a reply answered even when every channel refused it
(each `owner-delivery` item names the unconfirmed destinations as failed,
pending or unknown and deep-links the resend that retries only them),
outbound drafts awaiting approval — `phm drafts` items plus pending
Comms-agent reply drafts that have no cos mirror (every non-email transport,
or an email mirror that failed to write; a mirrored copy lists through its
`phm drafts` item while pending and still suppresses the Comms record once
decided, so one pending reply is one item, and items never carry the
recipient, which can be a handle) — live bus envelopes whose body the claim
contract accepts (`isClaimableWork`: a `kind:"work"` body or a protocol-v1
transport `task` body) with no
live claim (a live coordination-table row on the envelope's `queue:<id>` key
counts as held, since the message-id claim consults that same table),
live `worker-handoff` envelopes (`isWorkerHandoffBody`, the exact contract
`fleet handoff-receive`/`handoff-reply` accept — a pending assignment lists
until its TTL ends or the addressee answers it, claims are evidence only,
never a gate; an assignment the recipient already answered drops out once a
live reply routed recipient -> sender cites the handoff id through
`inReplyTo`/`replyTo` — resolved through the identity registry, so any
label of the two identities (or a member of the addressed channel) counts,
with an unreadable registry keeping literal-label matching —
the same durable evidence `agents conversations`
credits when it marks the thread answered), every envelope addressed to
the transport dead-letter sink (`bus.dead-letter` — the router's
delivery-failure report, docs/AGENT-BUS.md "Dead letters"): the original
envelope exhausted every live transport, had no route or outlived its
TTL, so the mail provably never arrived and lists as pending attention —
warn at minimum, high when the original was P0 — even though the
conversations, messages and edges projections deliberately exclude it as
"not agent mail"; the item names the failure reason, attempt count,
original parties/kind/id and correlation id when the letter kept them
(`payloadDropped` says when the original body was too large to keep),
with `agents bus show <letter-id>` and `comms bus read --to
bus.dead-letter` acts), and
open agent-bus v2 work-feed jobs (queued or rescheduled
`work.post` announcements with at least one claim key not fully held, plus
jobs the feed shows `blocked` or `failed` — stuck work needs a decision — or
open announcements that declare no claim keys, which `work claim` refuses
`no-claim-keys`; those list with `bus show` / `work feed --job` links and the
status detail when one exists instead of a claim act — and `running`/`idle`
announcements whose declared keys provably lost every live hold, which are
stalled work only the announcer can move; those list only under complete
hold coverage, since truncated, unavailable or absent coverage can never
prove "no hold". A retained `work.result` citing the job refines that read:
an in-flight report (`reserved`/`admitted`) means the peer dispatch pipeline
still owns the outcome, so the job hides like a held one would, while a
terminal report (`complete`/`failed`) means the worker answered and only the
announcer can move the status — the item then cites the result receipt
(`agents bus show <id>`) and says the report was made instead of reading as
abandoned; feed-job items of every kind also carry the newest result's
outcome in their detail — read
through the same projection as `phm agents bus work feed`), plus a refused
work feed itself — one high item naming the retained receipt the projection
blamed (`agents bus show <id>` / `work feed` links, `expiresAt` that
receipt's TTL deadline; a refusal that names no receipt keeps unknown
times), since the refusal hides every announced job and refuses the work
verbs until the receipt expires — plus pending mail in the legacy `phm bus`
mailbox store (`$ASHLR_HOME/bus-mailbox`, the records `phm bus inbox --to
<label>` reads and `phm bus ack` clears — a separate store the unified bus
never carried, so leftover mail would otherwise be invisible to this one
pending view; every pending unacked, unexpired message across EVERY
recipient label lists through `BusMailbox.pendingAll` in the mailbox's own
priority/acceptance/id drain order, each item keeping its own `to` label —
the `--to` `phm bus inbox`/`ack` take — with `since` the store acceptance
time and `expiresAt` acceptance plus TTL; titles reuse the shared bus body
composer so a secret-shaped body never reaches the item raw, an absent store
is `missing` while an unreadable one is `unavailable`, never an empty list
passed off as fact) — plus pending work on the shared task board across
EVERY peer (`phm bus thread`/`task`/`board`,
[docs/BUS-THREADS.md](BUS-THREADS.md)): the fleet-wide
`BusBoard.pendingAll` digest — the same locked snapshot and queue read
`pendingFor` serves per label set, where `work mine`'s board section still
needs the agent's labels ahead of time and `phm bus board pending` reads
one `--peer`'s view or, with `--all`, this same fleet-wide digest — lists
every unacknowledged delivery (board mail
awaiting `thread ack`; the wire TTL bounds live observers only, so `since`
is the delivery's recorded `createdAt` and `expiresAt` stays null) and
every task whose observed hold is not `held` — `open` is claimable work,
`ambiguous` an expired claim record the claim path never reclaims,
`unknown` a hold the unreadable queue could not prove, and `held` is
in-flight work that never lists; tasks store no timestamp, so their
`since`/`expiresAt` stay null — each item deep-links `phm bus thread
pending`/`ack` for a delivery and `phm bus task claim`/`list` or `phm bus
board pending` for a task, an absent board is `missing`, an unreadable
board, config or queue is `unavailable`, and unreadable claims or a
truncated item list is `degraded`, never an empty list passed off as fact —
plus agent
conversation threads still needing a person — the same `waiting` and
`blocked` threads the one shared conversations projection computes,
fleet-wide: a waiting item names who must answer, how long it has waited
and deep-links `phm agents conversations`, `phm agents bus show` and a
`phm agents bus post --thread`/`--reply-to` reply template; a blocked item names who
reported the block, who was told and how long it has stood, with the same
deep links. A thread whose latest message is already a pending bus item or
whose `job:` thread the feed already lists stays under the bus source, one
pending thing one item — plus pending wake hints fleet-wide (the same
`readAllWakes` projection `phm agents bus wakes --all` and
`fleet_agent_wakes` serve, grouped by addressee so the bounded queue tail
never floods the view: each warn item names the addressee, its hint count,
the newest hint time and up to three cited referents with the jobs they
provably name, deep-linking `phm agents bus wakes <label>` and `--all`; a
wake is only a pointer to read the inbox, never pending work itself, so
items stay warn and non-blocking and `expiresAt` stays null — a hint ages
out of the bounded tail with no deadline; a queue-tail read that cut older
hints or capped matched rows beyond the shown slice reports `degraded`,
the same `matched`/`truncated` honesty the wakes reads surface, while an
unreadable queue, registry or bus store is `unavailable`, never an empty
page passed off as "no wakes") — plus bot seats whose projected handoff plan still has work to
move (the same `planSeatHandoffs` read `phm bots handoffs` serves; only
eligible seats with pending, not yet journaled, handoff records list, each
item deep-linking `phm bots handoff --seat` and `phm bots handoffs`) — plus
unpublished peer work-dispatch results (the private
`agentnet/work-dispatch.json` journal's `work.result` receipts whose latest
recorded outcome was never confirmed sent to the proposing peer — the same
`sent !== outcome` rule `phm agentnet peers dispatch`'s publish pass and the
peer-bus admission check apply, so a peer cannot see a result the journal
does not prove this host published; the dispatch feed page reports only the
current proposals, so this backlog had no surface until now — each warn item
names the peer, outcome, consumer and receipt with `since`/`expiresAt` null
because the journal stamps receipt creation, not the last outcome move, and
deep-links `phm agentnet peers dispatch --apply`; an absent journal is
`missing`, an unreadable one `unavailable`, never an empty backlog passed off
as fact) — plus org-membership bus events the org plane still owes the bus
(`<runsDir>/org/agents.json` ledger entries with `busDelivered:false` — the
exact set `previewOrgOutbox` replays and `phm fleet org-sync --apply` posts,
one event per distinct `(revision, role)` edit under the stable id
`org-<storeId>-<revision>-<roleId>`; until the apply pass runs the bus cannot
see a staffing change the chart already recorded and `phm fleet org-board`
reports only a pending count, so each warn item names the role, tier,
status, proposing actor and ledger revision, carries `since` the entry's
recorded application time and `expiresAt` null — the event waits for the
next sync pass, never a guessed deadline — and deep-links `phm fleet
org-sync --apply` and `phm fleet org-board`; the read applies the same
`readAgentPlane` acceptance the org-sync/org-board reads do — private-file
gate, `org.agents.v1` schema mirrored locally for the Tier-1 closure,
chart invariants, secret-shape refusal and ledger contiguity — so an absent
store is `missing` and any refusal `unavailable`, never an empty backlog
passed off as fact) — plus
Gmail archive-plan overages, LinkedIn messages saved as
JSON files under `<runsDir>/comms/linkedin/inbox/` (answered when a file of the
same id exists in `.../linkedin/answered/`; replies stay drafts) and live
comms questions/approvals from the request queue (`~/.ashlr/comms/requests.jsonl`,
the same store `phm comms status` counts — a sent one is the single
outstanding slot Mason's numbered reply or button tap resolves and lists as a
blocking warn, a pending one is queued behind it; informational reports never
await a reply and never list, and `expiresAt` is the real TTL deadline
`expireStaleRequests` applies) — plus `*.eml` files still sitting in the
email-drop inbox dir (the same saved `queue/email-drop.json` config →
`inboxDir` → `readEmailDropInbox` the drop pass scans: inbound mail no
recorded-receipt source can see until `runEmailDropOnce` moves it into
`processedDir`, so a stalled cycle, a paused config or an unsafe folder
leaves real pending comms invisible; the whole backlog lists as ONE warn
item naming only the real file count — filenames never leave the directory —
with `since` the newest entry's filesystem mtime and `expiresAt` null, an
other-writable inbox degrading the source state while `enabled:false` only
annotates the detail, missing config or a missing inbox dir reporting
`missing`, invalid config `degraded` and a non-directory or unreadable inbox
`unavailable`; items deep-link `phm comms email-cycle` and `phm comms
diagnose --json`) — plus `.reply.eml` artifacts the email send
pass marked `stuck` in the reply outbox (the same read `phm fleet
email-outbox` serves: saved email-drop config → `outboxDir`, else the sibling
of `inboxDir` → `readEmailOutbox`; interrupted send claims, oversized or
unreadable files and malformed drafted rows each list as a warn with the
fixed reason — a stuck reply is never auto-resent, so items carry no
timestamp and deep-link `phm fleet email-outbox` and `phm comms diagnose
--json`; missing or invalid config, a missing outbox and an unreadable one
keep their own source state) — plus pending team approvals (access requests
and consequential handoffs only an owner/admin can decide, the same
`readTeamApprovals` section `phm approvals` and the desktop Approvals panel
project for the default team; each lists as a blocking warn deep-linking
`phm team approve|deny` and `phm approvals`) and pending inbox proposals
(the same `readPendingProposals` section — proposed actions that never
auto-apply; info items deep-link `phm inbox show|approve|reject`, a partial
capture drops `approve`, and a truncated or incomplete read reports
`degraded` with the items it did find) — and Slack requests whose local bus
append failed (the same `readSlackJournal` the `phm fleet slack-trace` and
`phm channels slack status` projections read: a journaled `ingested` row
with `bus: 'failed'` is an authenticated, validated Slack event whose bus
append never landed — the exact condition the trace calls `bus-failed`,
since send receipts only bind replies for the other outcomes — and it has
no bus envelope, no owner-thread record and no claim, so the journal is
the only durable evidence; posted, duplicate, legacy and ignored rows
either have a durable envelope another source already lists or cannot be
proven pending, so only failed appends list — each a warn naming channel,
thread and message ts only, never text, with `since` the journal receive
time, `expiresAt` null since the request is lost until re-ingested,
repeated failed ingests of one message collapsing to the newest row, deep
links `phm fleet slack-trace --channel … --thread … --message …` and `phm
channels slack status`, and source state the journal read's own — `ok`,
`missing` or `degraded`, never fabricated) — and outbound Slack sends
still unconfirmed (the same `readSlackSendReceipts` the `phm channels
slack status` `uncertainSends` count and the `phm fleet slack-trace` reply
binding read: a send-store receipt journaled `attempted` is a post whose
outcome the transport could not prove, kept so a later pass reconciles by
history scan instead of risking a duplicate post — until then the
recipient may never have seen the message, and every other surface reports
only the count, so each unconfirmed send lists as a warn naming channel
and thread ids only, never text; receipts keep no attempt timestamp, so
`since`/`expiresAt` stay null — the send waits until reconciled, never a
guessed deadline; `sent` receipts are proved deliveries and never list,
repeated keys collapsing to one item, deep links `phm channels slack
status`, `phm fleet slack-trace --channel … [--thread …]` and `phm
channels slack run --seconds 60` — the bounded pass that re-drives the
delivery and marks the receipt `sent` without reposting — with source
state the send-store read's own, never fabricated) — and Leader-thread
messages whose Telegram delivery the drain can no longer finish (the same
`readLeaderThreadUndelivered` read-only scan of the thread log and delivery
index `drainLeaderThread` drains — every listing path syncs memos first, a
write, so the inbox reads the store directly: a memo, question, update or
reply `failed` after its retries or `pending` past the 72 h offer window
means Mason may never have seen it on his phone, a class until now visible
only as the comms cycle's one-line outcome for the newest memo and in the
Verse thread; each lists as a warn naming the message kind and state with a
scrubbed text snippet, `since` the recorded post time and `expiresAt` null —
a failed send waits for a decision, never a guessed deadline; fresh pending
messages are the drain's own queue and never list, `sent` and never-queued
messages are proved or out of scope; source state is the read's own —
`missing` a verified-absent thread, `degraded` a truncated log,
`unavailable` an unreadable or malformed store — never an empty list passed
off as fact; deep links `phm channels`, `phm comms cycle` and `phm comms
send-owner`) — and the leader network's durable route and digest state
(the same bounded anchored read `readRouteReplyFacts` applies to
`<runsDir>/leader/network-state.json`, never the locking `pending()`
recovery pass: a verified owner request fully ingested for the leader —
inbox append and bus mirror proven, no delivered or attempted reply —
lists as a warn `leader-request`, the leader's own pending queue the
owner-thread source cannot see because network replies record to
MASON-OUTBOX.md, never the thread store — a reply recorded whose delivery
failed non-ambiguously stays in that queue (the network retries it) and
the item says "awaiting retry", never "awaiting reply"; a leader-bound route missing its
inbox append or bus mirror, or any route whose bus publish never landed,
lists as `leader-request-incomplete` — the request provably did not reach
every store the leader reads; a reply or away-digest whose delivery
attempt ended ambiguous (`attempted` without `delivered`/`sent`) lists as
`leader-reply-unconfirmed`/`leader-digest-unconfirmed` — the network
never retries an ambiguous attempt, so the owner may never have seen the
answer; items name channel, routing label, timestamps and job citations
only — owner recipient ids and channel refs never leave the reader, and
request text is scrubbed like every other source; source state is the
read's own — `missing` a verified-absent store, `unavailable` any
refusal — never an empty backlog passed off as fact; deep links `phm
leader inbox` and `phm comms thread`) — and the advisory coordination
ledger's whole pending surface (the `fleet.coordination.v1` ledger at
`~/.ashlr/fleet/coordination.jsonl`, through `readFleetCoordinationPending`
— the same replay `readFleetBoard` runs, projected fleet-wide in one read
and never its reaping mutation path: live ledger messages — `post` events
addressed to one coordination label or `all`, live until their TTL — list
as info `coordination-message` items carrying the scrubbed body as title,
the routing labels as detail and the record's own `since`/`expiresAt`,
deep-linking the addressed agent's `inbox` (the board for `all`
broadcasts); live assignment proposals — `assign` events with
`executionAuthorized:false`, advisory offers that never spawn work — list
as info `coordination-assignment` items naming task, repo and assignee;
and durable RESULT intents whose receipt publish never landed — a claim
concluded `intended` whose `postFleetMessage` never ran, the
`released-unposted` class `returnFleetClaim` reports once — list as warn
`coordination-return-unposted` items naming claim id, returning agent and
the receipt's expiry, since the released claim leaves the intent
invisible to every board, claims and returns read until expiry deletes
it; the owner-held lease-verified `return` retry is the detail, and lease
material never leaves the store; `missing` is a verified-absent ledger,
`unknown` any refusal — never an empty backlog passed off as fact; deep
links `phm fleet coordination board` and `phm fleet coordination inbox
--agent`) — and the claim-store drift verdict's disagreeing rows (the
`fleet.claim-drift.v1` read `phm fleet claim-drift` serves — the same
comparison `agents bus status` reports as counts only: live bus work
claims against the live `queue:<id>` coordination leases they are
dual-written to, joined on the `<id>:<cursor>:<receivedAt>` coordinate —
a bus-only row the coordination overlap check cannot see, a
coordination-only row the bus claims journal never recorded, and an
owner-mismatch pair where the same lease shows two holders each list as
warn `claim-drift-bus`/`claim-drift-coordination`/`claim-drift-owner`
items naming envelope id, owner labels, cursor and lease deadline,
`since` the claim coordinate's receipt time and `expiresAt` the lease
expiry that ends the disagreement; `UNKNOWN` — a claim store that could
not be read — reports `unavailable` with a null pending, never an empty
verdict passed off as fact, and VERIFIED with both stores absent is
`missing`; deep links `phm fleet claim-drift`, `phm agents bus show`,
`phm agents bus claim list --key`) — and each item carries `act` deep-link commands (`phm fleet
needs-resolve`, `phm fleet teammate-texts --answered`, `phm fleet
imessage-tasks dispatch --apply`, `phm fleet imessage-tasks list`, `phm comms thread`,
`phm comms send-owner`, `phm comms status`, `phm inbox show`,
`phm drafts approve`, `phm comms-agent drafts`,
`phm fleet bus-claim acquire`, `phm agents bus claim acquire`,
`phm fleet handoff-receive`, `phm agents conversations`,
`phm bots handoff`, `phm agentnet peers dispatch`, `phm fleet org-sync --apply`, `phm fleet org-board`, `phm agents bus post`, `phm comms email-cycle`,
`phm fleet email-outbox`,
`phm bus inbox`, `phm bus ack`, `phm bus thread pending`, `phm bus thread
ack`, `phm bus task claim`, `phm bus task list`, `phm bus board pending`,
`phm team approve|deny`, `phm inbox approve|reject`,
`phm fleet slack-trace`, `phm channels slack status`, `phm channels slack
run`, `phm channels`, `phm comms cycle`, `phm leader inbox`, `phm fleet
coordination board`, `phm fleet coordination inbox --agent`, `phm fleet
claim-drift`, `phm agents bus show`, `phm agents bus claim list --key`). It never claims, replies, or mutates; a source
that cannot be read reports `missing`, `degraded`, or `unavailable` in
`sources` instead of pretending to be empty, and the list is capped at 200
items with the remainder counted in `omitted`. The bare view also narrows:
`--source <name>` keeps one source's items, `--kind <name>` one item kind —
the item's own classification, finer than `--source` where one source emits
several kinds (the `bus` source's `bus-work`/`bus-handoff`/`bus-dead-letter`
split, the `board` source's `board-delivery`/`board-task` split) — `--severity
<info|warn|high>` one
severity band, `--blocking` only items that block, `--job <id>` only items
that provably name that job — a bus or mailbox body's `busBodyJobMatch`
citation, a feed job's id, a board task's fleet item or a delivery on a
job-carrying thread, a conversation thread's jobs, a teammate task's job, a
seat's `node-job` handoff (a `bus-claim` ref is a claim key, never a job) or a
peer-dispatch receipt's job —
and `--since <15m|2h|1d|ISO>` only items whose recorded `since` appearance
time reaches the cutoff, the same inclusive `>=` match every bus read
`--since` applies; `--before <15m|2h|1d|ISO>` is the exclusive upper bound
keeping only items whose recorded appearance time is strictly before its
cutoff, the same `<` match every bus read `--before` applies — the two
compose into one `[since, before)` window and an item exactly on either
boundary stays out of the excluded side; an item whose store keeps no
timestamp (`since` null) or
whose recorded time cannot be parsed never matches, so unknown never counts
as new or old; and `--contains <text>` only items whose scrubbed `title` or
`detail` carries the text as a case-insensitive substring with whitespace
collapsed — the same text the row shows, so a match is always visible in
the row it selects, while the `act` deep links (commands, never item
content) stay out of the match. The dimensions AND together. `total`, `omitted` and `items` then
describe
the matched view and the report echoes the applied `filter`, while `sources`
keeps every store's real unfiltered pending count — `null` when a source
could not be read, never a fabricated 0 — a filtered view never
reports a busy or degraded source as empty. `GET /api/verse/comms/inbox` —
the desktop and agent read of the same report — accepts the same dimensions
as query parameters (`source`, `kind`, `severity`, `blocking=true|false`,
`job`, `since`, `before`, `contains`, each at most once, plus `limit` 1–200 default
50), validated by `parseUnifiedInboxQuery` — the same value rules `phm
comms inbox` and `fleet_comms_inbox` apply — and echoes the applied
`filter` on the response exactly like
`fleet_comms_inbox` does; an unknown, repeated or malformed parameter is a
400, never a silently ignored filter. `phm comms inbox read` and
`post` keep their original meaning for Mason's local inbox file.

## Gmail triage building block

[`pollGmailBridge`](../src/core/comms/gmail-bridge.ts) is a local programmatic
triage function, not a configured Gmail integration or CLI command. Its caller
must provide a read-only inbox adapter and classification, composition and
summary functions. A poll accepts at most 100 messages; updates return summaries,
and eligible replies become local drafts. A reply is drafted only when the
provider's `autoSubmitted` value is `no` (case-insensitive); missing or other
values go to review. Duplicate or empty IDs in one poll also go to review.
The function has no provider send operation; drafting is not delivery.
