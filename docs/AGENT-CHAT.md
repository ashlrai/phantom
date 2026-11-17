# Agent group chat

The local owner dashboard and CLI can read an ordered, retained conversation
for a run or outcome over the existing Agent Bus v2. No new message store,
network connection, dispatcher, spending permission, or execution authority.

```sh
phm agents chat list --channel engineering --json
phm agents chat read run:build-42 --channel engineering --after 0 --limit 50 --json
```

`GET /api/agents/chat?channel=engineering` lists threads and participants.
Add `thread=run:build-42` (or `outcome:goal-42`), `after`, and `limit` for messages.
The existing local owner read authentication protects this API. Remote gateway
allowlists are unchanged. Other methods are refused. No caller-selected filesystem root.

Producers use the existing channel post API, with a v2 note/context `thread`
explicitly set to `run:<id>` or `outcome:<id>`. No inference from prose or job titles.
Only same-channel, current-member, local Agent Bus messages are included; DMs,
private owner inboxes, iMessage, email, Slack, handoffs, and mismatched metadata
are excluded. Only a channel message with a matching accepted owner receipt is displayed as
an interjection. A human flag alone proves neither owner identity nor permission. This read API never imports owner messages
or sends anything. It never upgrades a note to a command.

Messages sort by durable receipt cursor, not priority or client clocks. Resume
from `nextCursor`; `hasMore` means another page is available. Reads scan bounded
retained rows, freeze expiration time, and return unavailable/retryable on errors.
This is **live retained history**, not an archive or proof of complete lifetime
history. Participant engine is the latest registered runtime; state is `unknown`
until an authoritative presence source exists. Avatar colors are deterministic.
The desktop renderer must display text as text, never as raw HTML.

Agent producers still set human=false. The only owner ingress added here is the
explicit native iMessage sharing path below, not generic Bus sender flags.

## Explicit owner share (native iMessage)

An existing verified owner may send an exact JSON object:
`{"kind":"agent-chat.share","channel":"engineering","thread":"run:build-42","text":"Review the tests."}`.
This shares only the selected text. Ordinary messages and private history remain
in the existing local owner inbox. No new transport, credential, or permission
is enabled. Existing owner configuration, per-recipient team approval,
communications confirmation, pause and KILL apply; unavailable policy refuses.

Native GUID/account GUID are optional UUID-shaped provenance. Missing/invalid
metadata has no ROWID fallback: explicit sharing refuses while legacy-schema
polling still supports ordinary private messages. Current schema observation
is a host sample, not proof of global GUID uniqueness; conflicting reuse refuses.

A private, bounded 512 KiB / 1024-entry ledger pins source namespace + GUID,
content/target and approved stable recipient IDs. Pending writes recover through
Bus idempotency; accepted IDs never recycle. Replay older than seven days refuses
rather than resurrecting expired messages. Pending reads return retryable without
advancing cursors; policy-rejected pending records are terminal. A full ledger
refuses new shares, never evicts old idempotency records. Pause/KILL can leave
pending work blocked until recovery or Bus expiry. An inbox acknowledgment is
not proof of shared-chat delivery; accepted ledger evidence is required.

Supported agent inbox reads enforce the accepted recipient snapshot, so joining
later does not expose retained owner shares. Raw local Bus files and owner-only
Bus diagnostics are privileged and are **not** per-agent isolation boundaries.
The local owner dashboard can inspect its own history. Policy is rechecked just
before append, but no global atomic lock across independent policy editors is
claimed. No execution or cross-transport delivery authority is granted.
