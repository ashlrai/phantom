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
source cannot be read. `cli`, `desktop`, and `page` need no setup and always
report ready; `mobile` needs the `~/.ashlr/verse-remote.json` gateway file
([REMOTE-PHONE.md](REMOTE-PHONE.md)).

## Where to watch it

- **Desktop console** — the Channels pane (top-level navigation) and the Inbox pane.
- **CLI** — `phm channels status [--json]` rolls all six kinds up;
  `phm comms bus read` shows every accepted bus envelope;
  `phm comms inbox read` reads the inbox file directly.
- **API** — the `GET /api/verse/fleet/runs/inbox` route exposes the inbox in JSON.

## One owner thread

`phm comms status --json`, `phm comms thread --json` and `phm comms send-owner --text "<reply>" --json` are the single owner thread across desktop, Telegram, email, iMessage and Slack. Inbound messages from the configured owner land in one ordered thread. A reply goes back to that channel and to the desktop thread, and nowhere else. Adapters stay disabled until configured. Secret fields are Phantom Secrets handle names. KILL and the comms pause halt every adapter. See [Owner thread](OWNER-THREAD.md).

## Unified inbox

`phm comms inbox [--json]`
([`unified-inbox.ts`](../src/core/comms/unified-inbox.ts)) is the read-only
roll-up of everything still pending, ranked the way Needs-you ranks: severity
band, then priority, then expiry, then newest. It aggregates four local sources
— unresolved `NEEDS-MASON.md` items, unanswered allowlisted teammate texts,
outbound drafts awaiting approval, and live bus `kind:"work"` envelopes with no
live claim — and each item carries `act` deep-link commands (`phm fleet
needs-resolve`, `phm fleet teammate-texts --answered`, `phm drafts approve`,
`phm fleet bus-claim acquire`). It never claims, replies, or mutates; a source
that cannot be read reports `missing`, `degraded`, or `unavailable` in
`sources` instead of pretending to be empty, and the list is capped at 200
items with the remainder counted in `omitted`. `phm comms inbox read` and
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
