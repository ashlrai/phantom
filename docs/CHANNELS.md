<!-- Keep under ~120 lines when the file is complete. Source: origin/master files. -->

# Channel guide

Every external message — Mason on Telegram, a CLI inbox post, a mobile
interjection, the desktop composer, the Phantom page, or a drop-folder
email — lands in one shared inbox, gets deduplicated, carries its source,
and receives a same-channel acknowledgement.

## Where messages land

- `~/.ashlr-runs/leader/MASON-INBOX.md` — the durable receipt store
  ([`appendInboxEntry`](src/core/fleet/mason-inbox.ts)).
- The durable agent bus (readable via `phm comms bus read`) — mirrors
  accepted receipts through [`publishChannelEnvelope`](src/core/fleet/channel-bus-publish.ts).
- Both paths are driven by the shared [`createChannelReceiver`](src/core/fleet/channel-envelope.ts), so a duplicate never writes a second entry.

## Channels

`INBOUND_CHANNELS` lists **email · telegram · mobile · desktop · page · cli**
and each channel has display labels in
[`fleet-channels-model.ts`](src/web-ui/routes/verse/fleet-channels/fleet-channels-model.ts).

### Telegram

Private chat to the configured bot ([`telegram-inbox-bridge.ts`](src/core/comms/telegram-inbox-bridge.ts)).
Verified as Mason when `comms.telegram.chatId` in the config matches the event's
`senderUserId` (canonical ID: `telegram:<id>`). The first accepted message pairs
that id; a later id is refused until `queue/telegram-pair.json` is removed.
Plain language is enough: "how's the fleet?" returns the short glance, and any
other sentence is an order in `MASON-INBOX.md`. Setup is the existing bot token
and chat id ([operator glance](OPERATOR-GLANCE.md)).

### CLI

`phm comms inbox post --file <file|->`
([`comms-inbox.ts`](src/cli/comms-inbox.ts)).  Verified as Mason when the
CLI operator's sender ID is in the allowlist (canonical ID: `local-operator`).

### Email

Drop-folder delivery via [`email-drop-bridge.ts`](src/core/comms/email-drop-bridge.ts):
an external mail path saves raw RFC 822 files (`*.eml`) into an inbox directory;
Phantom parses, checks the allow-listed From address, writes the body, and drops a
`.reply.eml` into the outbound folder.  Not yet available as a live service — a
configured allow-list is required before any real mail reaches the inbox.
When `PHANTOM_OPERATOR_SECRET` (or `~/.ashlr/comms/operator-secret`) is set, mail
also needs a DKIM pass for the sender's domain and that secret once; later mail
from the paired address stays plain language. See [operator glance](OPERATOR-GLANCE.md).

### Desktop

Sent from the desktop composer; source string is `"Phantom desktop"`
([`mason-inbox.ts`](src/core/fleet/mason-inbox.ts) default source).  No
separate verification gate — the source is the channel label.

### Mobile

The remote phone gateway sends through the mobile channel
([`channelKey`](src/web-ui/routes/verse/fleet-channels/fleet-channels-model.ts)
matches `mobile` / `remote` / `phone`); the gateway pins `"Phantom mobile"`
as the source for phone-originated writes.  Not a separately-verified sender.

### Phantom page

Messages sent through the Phantom page are captured under the `page` channel
label in the Channels pane (`"page"` / `"7790"` source match).  No separate
verification — the page source is the channel label.

## Dedupe · attribution · acknowledgment

- **Dedupe window** — 10 minutes (first receipt, across restarts);
  [`CHANNEL_DEDUPE_WINDOW_MS`](src/core/fleet/channel-envelope.ts).
- **Duplicate acknowledgement** — `"Already received by Phantom; no duplicate interjection added. Receipt: <key>"`
  (see [`formatChannelAck`](src/core/fleet/channel-ack-text.ts)).
- **Attribution** — the `source` field in every inbox entry (e.g. `"telegram"`,
  `"Phantom mobile"`); the default source falls back to `"Phantom desktop"` when
  a channel omits one ([`mason-inbox.ts`](src/core/fleet/mason-inbox.ts)).
- **Ack timeout** — 2 000 ms per [`CHANNEL_ACK_TIMEOUT_MS`](src/core/fleet/channel-envelope.ts);
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
