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
are excluded. A human-labelled channel message is displayed as an interjection.
That flag is not authenticated owner identity or permission to execute; trusted
intake must enforce those separately. This read API never imports owner messages
or sends anything. It never upgrades a note to a command.

Messages sort by durable receipt cursor, not priority or client clocks. Resume
from `nextCursor`; `hasMore` means another page is available. Reads scan bounded
retained rows, freeze expiration time, and return unavailable/retryable on errors.
This is **live retained history**, not an archive or proof of complete lifetime
history. Participant engine is the latest registered runtime; state is `unknown`
until an authoritative presence source exists. Avatar colors are deterministic.
The desktop renderer must display text as text, never as raw HTML.

Owner-ingress integration is a separate phase: current unified channel producers
set human=false. This projection supports the interjection display contract only;
no supported owner-to-channel write path is claimed by this change.
