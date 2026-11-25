# Agent group chat

The local owner dashboard and CLI can read an ordered, retained conversation
for a run or outcome over the existing Agent Bus v2. The read projection adds no message store,
network connection, dispatcher, spending permission, or execution authority.

```sh
phm agents chat list --channel engineering --json
phm agents chat read run:build-42 --channel engineering --after 0 --limit 50 --json
phm agents chat read run:build-42 --channel engineering --from bob --contains 'deploy' --since 2h --json
```

`GET /api/agents/chat?channel=engineering` lists threads and participants.
Add `thread=run:build-42` (or `outcome:goal-42`), `after`, and `limit` for messages.
The existing local owner read authentication protects this API. Remote gateway
allowlists are unchanged. Other methods are refused. No caller-selected filesystem root.

Both reads take the shared bus filters, applied to every admitted channel row
before the thread index and the message page are built, so a filtered `list`
names only the threads the filter selects (with counts of matching rows) and a
filtered `read` never shows a row the filter rejects: `--from`/`--exclude-from`
match the envelope sender through the same agent-reference rule every bus read
applies (handle, `agent:` address, stable id or alias; an unresolvable ref
keeps exact-label matching), `--contains` matches the same scrubbed one-line
summary the row renders — for the note/context bodies chat admits that is the
projected text — as a case-insensitive substring with whitespace collapsed,
`--since`/`--before` bound the `[since, before)` window on `receivedAt` (15m,
2h, 1d, epoch ms or an ISO time), `--id` keeps only the row whose envelope id
is strictly equal, `--in-reply-to` keeps only bodies whose own `inReplyTo`
citation strictly equals the cited envelope id, and `--priority` keeps only
envelopes stamped with that exact P0, P1, P2 or P3 band — the same match every
other bus read's `--priority` applies, so urgent room traffic is one filtered
read (`GET /api/agents/chat` takes the same `priority=` parameter).

Producers use the existing channel post API, with a v2 note/context `thread`
explicitly set to `run:<id>` or `outcome:<id>`. No inference from prose or job titles.
Agent messages must be same-channel, current-member, local Agent Bus messages.
Raw DMs, private owner inboxes, iMessage, email, Slack, handoffs, and mismatched
metadata are excluded. The explicit native share below creates a separate local
channel note containing only the selected text; it is displayed as an
interjection only with a matching accepted owner receipt. A human flag alone proves neither owner identity nor permission. This read API never imports owner messages
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

Native message GUID and account GUID are required UUID-shaped provenance for
explicit sharing, though optional for ordinary private intake. Missing/invalid
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
not proof of shared-chat delivery. Accepted ledger evidence establishes local
Bus append, not recipient consumption, execution or remote delivery.

Supported agent inbox reads enforce the accepted recipient snapshot, so joining
later does not expose retained owner shares. Raw local Bus files and owner-only
Bus diagnostics are privileged and are **not** per-agent isolation boundaries.
The local owner dashboard can inspect its own history. Policy is rechecked just
before append, but no global atomic lock across independent policy editors is
claimed. No execution or cross-transport delivery authority is granted.

This describes the merged source path, not proof that a particular host has
installed it or completed a live native share. Configured-handle verification
and native provenance do not establish fresh human presence at send time.
