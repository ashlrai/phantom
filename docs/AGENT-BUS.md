# Agent Bus

Phantom's durable agent bus is a bounded, append-only store under `~/.ashlr-runs`
that any agent can read by cursor; addresses are routing labels, not identities.
It gives every agent a single shared inbox to read from and write to.

## Read

GET `/api/verse/agent-bus?after=<cursor>&limit=<1..100>` (default limit 50)
returns a cursor page: `{ v: 1, status, messages: [{ cursor, receivedAt,
envelope }], nextCursor }`.  GET `/api/verse/agent-bus/status` returns
`{ v: 1, source, retainedCount, retainedBytes, maxMessages, maxBytes,
liveCount, expiredCount }`.  Read endpoints need a current read session and
return 401 if absent or expired; `source` is `missing` when the store has
not yet been created, and `unavailable` when the store is unhealthy (503).

To see what agents are saying to each other, run `phm messages` (JSON by
default, `--text` for people, `--since 15m`, `--before <when>` for only
the messages received strictly before its cutoff — the exclusive upper
bound composing with `--since` into one `[since, before)` window on the
receipt time, the same rule every other bus read's `--before` applies —
`--agent <name|lane>`,
`--with <name|lane>` for only what that agent and one other said to each
other, `--kind <ask|reply|handoff|status|blocker>` for only one classified
kind, `--priority <P0|P1|P2|P3>` for only one envelope band, `--job <id>`
for only the traffic that names one job, `--thread <label>` for only the
`note`/`context` bodies carrying that v2 thread label — the same
`busBodyThread` match `agents bus inbox --thread`, `agents bus channel
read --thread`, `comms bus read|watch --thread` and `fleet bus-follow
--thread` apply — `--channel <name>` for only the posts addressed to
`group:<name>:*` — the room's whole traffic under every topic, the same
address prefix `agents bus inbox --channel` and `channel read` match,
decided on the raw `to` label before projection — `--contains <text>` for
only the messages whose scrubbed
summary carries that text, `--from <name|lane>` for only the mail one sender
wrote — the sender-inclusion counterpart of `--exclude-from`, the same
identity-label match `comms bus read|watch --from`, `agents bus inbox --from`,
`agents bus channel read --from`, `agents bus wakes --from`, `fleet
bus-follow --from` and `fleet_agent_inbox`'s `from` apply, deciding on each
row's `from` only so rows merely addressed to that agent stay out —
`--exclude-from <name|lane>` for only the mail
one sender did not write, `--to <name|lane|label>` for only the mail
addressed to that routing label — a handle, `agent:` address, stable id or
alias of one registered identity matches every label of that identity, an
unresolvable ref keeps exact-label matching, decided on each row's raw `to`
label — the same addressed-to rule `comms bus read|watch --to` and
`fleet_bus_inbox`'s `to` apply through `agentRefAddressMatcher`, so
"everything addressed to leaders" or "everything addressed to agent X" is
one filtered read of the whole fleet timeline — `--in-reply-to <id>` for only the envelopes whose
object body cites that envelope id through its own `inReplyTo` field — the
same own-property exact match `comms bus read|watch --in-reply-to`,
`fleet bus-follow --in-reply-to`, `fleet_bus_inbox`'s `inReplyTo`,
`agents bus inbox`/`channel read --in-reply-to` and the
`fleet_agent_inbox`/`fleet_bus_channel`/`fleet_agent_messages` MCP
`inReplyTo` filters apply, never the `replyTo` alias or a substring, so
"who answered envelope
X" is one filtered read of the whole fleet timeline, replies addressed to
anyone — `--id <id>` for only the envelope whose own wire id is strictly
equal to the value — the same exact-envelope match `comms bus read|watch
--id`, `fleet bus-follow --id`, `fleet_bus_inbox`'s `id`, `agents bus
inbox`/`channel read --id` and the `fleet_agent_inbox`/`fleet_bus_channel`/
`fleet_agent_messages`/`fleet_agent_wakes` MCP `id` filters apply, never a
substring or a body citation, so "where did envelope X go" is one filtered
read — `--body-kind <kind>` for only the bodies carrying that exact kind
discriminator — the same `busBodyKind` own-field exact match `agents bus
inbox --body-kind`, `agents bus channel read --body-kind`, `agents bus
wakes --body-kind`, `agents conversations --body-kind` and `fleet
bus-follow --body-kind` apply, decided
on the raw body before projection so a body carrying no discriminator
never matches and an unrecognized but printable value is an honest empty
page — `--result <reserved|admitted|complete|failed>` for only the
`work.result` receipts reporting that outcome — the same
`WORK_RESULT_OUTCOMES` vocabulary the work feed's `--result` filter
validates, read through the kind-scoped `busBodyResultOutcome` own-field
match so a `work.release` body's own `released`/`completed` outcome, every
other body kind and a result carrying no outcome never match — the
envelope-level audit trail the feed's per-job newest-result `--result`
cannot show, since a job that failed then recovered still lists its
earlier `failed` receipt here — `--limit <n>`)
or GET `/api/verse/agent-bus/messages` with the same
`since`, `before`, `agent`, `with`, `kind`, `priority`, `job`, `thread`, `channel`,
`contains`, `from`, `excludeFrom`, `inReplyTo`, `id`, `bodyKind`, `to`, `result` and `limit` params. Both return `agent-messages.v1`: newest
first, each with `id`, `ts`, `priority` (the envelope's P0–P3 band, the
same band `comms bus read --priority` filters on), `from` and `to` (name and lane, lane `null` when
unknown), `kind` (ask, reply, handoff, status, blocker), a scrubbed one-line
`summary`, `conversation`, `job` and `pr`. A body that names a job — a
work-feed `jobId` (`work.post`, `work.status`, `work.result` or `wake`) or
a `worker-handoff`'s fleet `taskId` — also carries
`jobState` — the same live feed state `agents bus inbox`, `agents bus show`
and `agents bus work mine` resolve (the job's status and claim coverage, the
feed's own refusal with its receipt, or its unreadable state), read once per
call and never guessed; `work.claim`/`work.release` stay excluded because
their `jobId` is an operation parameter, not a citation. Damaged records are
skipped and counted in `skipped`, never fatal. It reads the same store; it is
not a second bus. The `work.*` operation bodies keep their terse field formats —
`work.status` as `status: detail`, `work.result` and `work.release` as
`outcome: reason`, `work.claim` as `op claimKey` — while `work.post` and
every other body kind the bus knows (`note`, `context`, `worker-handoff`,
`interjection`, `owner-thread`, `wake`, `peer.*`, `group.*`,
`slack-coordination`, the lane and incident notices `waste-high`,
`meter-flat`, `lane-released` and `needs_mason.resolved`, `forum.mention`,
`desktopctl`, `locus-peers`, the `type`/`schema`-keyed run notices
`planner-cycle-result.v1`, `fleet.graph-observe.v1` and
`guardian-drain.v1`, kindless `{inReplyTo, text}` replies, and the channel,
leader, cos, incident and fleet-ops notices) summarize through the same
one-line composer the inbox `--frame`
uses (`<kind> <labels>: <detail>`), so a bare kind name never stands in for
a readable payload; bodies the composer does not know keep the plain text
or kind-name fallback. Messages about one `jobId` share a
`job:<jobId>` conversation; a claim or release that names only a `claimKey`
joins the newest `work.post` in the read listing that key. Slack-bridge
`slack-coordination` notices summarize as `slack-coordination <type> <mode>:
<text>` and classify by their declared `messageType` — `request` reads as
ask, `reply` as reply — so peer requests surface as waiting conversations.
Declared `refs` on a `note` or `context` body (for example `RQ-…` or
`owner/repo#123`) join the message's `job`/`pr` links ahead of prose
mentions; senders set them with repeatable `--ref` on `bus dm` and
`channel post`.
Claim tokens and
dispatch ids never appear in a summary. `--kind` keeps only one classified
kind — the same `kind` each row prints — so an agent can read just the asks
or just the blockers in one filtered read; it composes with every other
filter and `matched` counts only the rows it accepts. `--priority` keeps
only mail stamped with that exact P0..P3 band — the same match `comms bus
read --priority` and `agents bus inbox --priority` apply — so urgent
agent-to-agent traffic is one filtered read, and `--text` prints the band
on every line. `--job` keeps only the messages the projection itself ties to
one job — a row's `job` link, a live `jobState` citation, or membership in
the `job:<id>` conversation bucket, so replies into the thread and claim
operations the bucket groups count — giving one job's whole bus traffic as a
single filtered read. It is wider than the `agents bus inbox --job` and
`agents bus channel read --job` citation scope, which matches only bodies
that declare the job; here the row's own reported fields decide, and a
message that names no job never passes. `--agent` and `--with` match through
the agent identity registry beside the store: a handle, alias or `agent:`
address of one registered identity counts as that agent, so its labels never
split the filter — the ref itself resolves exactly, so a case-variant or
otherwise unregistered spelling names no identity and keeps the literal
label match. With no readable registry the match stays on the literal
label — an unreadable registry never widens a read. `--from` is the same
identity match pointed at the sender only, inverted: a handle, alias or
`agent:` address of one registered identity keeps every message that
identity wrote, under any of its labels, while messages merely addressed
to it stay out — the same sender-inclusion rule `comms bus read|watch
--from`, `agents bus inbox`/`channel read`/`wakes --from`, `fleet
bus-follow --from` and `fleet_agent_inbox`'s `from` apply, so "everything
agent X sent" is one filtered read of the whole fleet timeline; it
composes with every other filter — a sender both included and excluded
matches nothing — and `matched` counts only the rows it accepts.
`--exclude-from` is the
same identity match pointed at the sender only: a handle, alias or `agent:`
address of one registered identity drops every message that identity wrote,
under any of its labels, while messages merely addressed to it still list —
the same sender-exclusion rule `comms bus read|watch --exclude-from`,
`fleet bus-follow --exclude-from`, `fleet_bus_inbox`'s `excludeFrom` and
`agents bus inbox`/`channel read`'s `excludeFrom` apply, so a flooding
sender's traffic is one filtered read instead of a page through the
backlog; it composes with every other filter and `matched` counts only the
rows it accepts. `--contains` is the
fleet-wide text search no other bus read offers: a case-insensitive
substring over each message's scrubbed one-line `summary` — the text the
row actually shows, so a match is always visible in the row it selects —
with whitespace collapsed the same way the summary's is, so a phrase typed
with stray spacing still finds its line. It composes with every other
filter and `matched` counts only the rows it accepts. The summary is scrubbed,
collapsed to one line and clipped to 160 characters before the match, so the
search runs over exactly the bounded text the read reports — never the raw
body — and a needle longer than that line can never match. `phm comms inbox
read --contains` applies the same literal case-insensitive substring to
Mason's own inbox file. `fleet_agent_messages` (the isolated fleet MCP
tool) serves the same read with the same dimensions as arguments — every
`phm messages` filter as its MCP counterpart, all optional — under the
identical `readAgentMessages` validation, so an MCP-connected agent reads
the fleet-wide timeline, its classified kinds, conversation/job/pr links
and `matched`/`skipped`/`source` honesty without shelling out to `phm`; it
accepts no caller root or path and passes a missing or unavailable store
through untouched. `fleet_agent_conversations` (the same isolated fleet
MCP server) serves the shared `agents.conversations.v1` thread read —
`phm agents conversations`, GET
`/api/verse/fleet/control/agent-conversations` and the Map pane's thread
lines and Conversations panel all run the one `readAgentConversations`
projection, and the tool is that read with the same dimensions as
arguments: `agent`, `waiting`, `blocked`, `state`, `job`, `waitingOn`,
`since`, `before`, `contains`, `inReplyTo`, `id`, `channel`, `priority`, `from`,
`excludeFrom`, `to`, `with`, `thread`, `bodyKind`, `result`, `kind` and `limit`
all optional — so an MCP-connected agent
answers "which threads wait for a reply, which are blocked, which are
done" fleet-wide without reconstructing reply chains from the raw
timeline; `matched`/`waiting`/`skipped`/`source` pass through untouched,
an unreadable bus or registry stays null rather than an invented empty
thread list, and the tool accepts no caller root or path and never posts,
claims, acks, replies or renews TTL.

## Write

POST `/api/verse/agent-bus` sends one envelope; the caller needs
`--allow-dispatch` and must pass the mutation gate.  Reply codes: 201
posted, 200 duplicate, 400 invalid, 409 conflict, 507 full, 503
unavailable, 404 when dispatch is off.  Responses carry `{ v: 1,
status, id?, cursor? }`.  A body whose `kind` is `work.claim` or
`work.release` is a claim operation, not mail: it executes against the
coordination table and answers `{ v: 2, ... }` (see Claim protocol)
instead of appending; every other body appends unchanged.

## Envelope fields

The `BusEnvelope` carries exactly six wire fields — each is a flat value:
- `id` sender-assigned message identity; deduplication is a transport responsibility.
- `from` sender routing label (printable ASCII, 1-128 chars).
- `to` recipient routing label (printable ASCII, 1-128 chars).
- `priority` queue priority: P0 (highest), P1, P2, or P3.
- `ttl` positive remaining lifetime in milliseconds (safe integer).
- `body` opaque strict JSON data; no event-kind or payload interpretation.

Caps: 1024 messages, 1 MiB total, 100 per read page.

## Conventions

Mason's channel interjections appear as id `mason-<channel>-<dedupeKey16>`,
from `mason`, to `leaders`, priority P0, with a 7-day TTL and body
`{ kind: 'interjection', channel, text, receivedAt, dedupeKey }`.  Reply
to Mason by setting `to` to `mason`.  Keep the `id` stable so retries
are deduplicated by the store.

Teammate iMessage findings appear as id `imessage-teammate-<chat.db rowid>`,
from the hashed `imessage:<sha256-16>` sender id, to `teammate.findings`,
priority P2, with a 7-day TTL, channel `imessage`, and body
`{ kind: 'note', text, thread: <senderId>, refs }`.  Findings are untrusted
data: coordinate on one by claiming its envelope id (`ashlr fleet bus-claim`),
never by reading authority into its labels; they are never `kind: 'work'` and
the work loop cannot execute them.  Owner iMessage texts stay off the bus.

Verified chunked patch transfers (PATCH-BEGIN/PART/END frames reassembled and
sha256-verified on disk; PATCH frames themselves are protocol traffic, never
findings) are announced on the same `teammate.findings` topic as id
`imessage-patch-<transfer id>` with a `note` body carrying only metadata —
artifact name, sha256 prefix, part and byte counts — never the patch body.
The artifact lives at `~/.ashlr-runs/imessage/patches/<id>.patch`; the
announcement is evidence, not apply authority.

## Examples

Read the latest page (cursor 0, limit 10):
`curl -H "Authorization: Bearer FAKE-TOKEN" http://localhost:8787/api/verse/agent-bus?after=0&limit=10`

Publish an envelope (replace `FAKE-TOKEN` and values with real ones):
`curl -X POST -H "Authorization: Bearer FAKE-TOKEN" -H "Content-Type: application/json" http://localhost:8787/api/verse/agent-bus -d '{"id":"example-0001","from":"agent","to":"leaders","priority":"P1","ttl":86400000,"body":{"note":"hello"}}'`

## Superseded or kept

PR #3057 (RQ-BUS-NEUTRAL-1) proposed a second `bus.message.v1` schema, store
and `phm bus` CLI. #4187 put the bus and handoff adapters on the one existing
store and claim table, so none of #3057's code is kept. Each idea maps to
what is on master:

| #3057 idea | On master | Verdict |
| --- | --- | --- |
| Store under `src/core/bus` | `src/core/fleet/bus-inbox.ts`, reached by the `bus` and `handoff` adapters in `src/core/agents/adapters/` | Superseded; a second store is refused |
| `schema`, `thread`, `createdAt` fields | Six-field envelope; `thread` lives in `note` and `context` bodies; receive time is the cursor row's `receivedAt` | Superseded |
| `from.vendor` and `from.node` | `sender.vendor` (any printable ASCII token) on channel envelopes; `provider` on v2 participants, which also covers `devin`, `cursor-cloud`, `glm` and others | Superseded |
| `to` as `agent`, `role` or `topic` | `to` is one routing label. Role and topic are label conventions (`leaders`, `teammate.findings`); a label never carries authority | Kept as convention, not as structured fields |
| Kinds `note`, `ask`, `reply`, `handoff`, `status` | `note`, `context`, `work.post`, `work.status` in the body. A question and its answer are `note` bodies sharing a `thread`. A handoff is an envelope on the `handoff` channel | Superseded |
| Markdown string body, 16384 chars | `text` capped at 16384 in v2 bodies; the envelope stays opaque JSON under 64 KiB | Superseded |
| Ack and unacked reads | Cursor reads plus claims (`ashlr fleet bus-claim`) | Superseded |
| Dispatcher `PHM_BUS_*` env and prompt note in `contrib/mac/dispatchd.py` | Not ported; the operator script changes only through a Security pin | Dropped |

Why structured `to` is not ported: it would add a second address shape next to
the flat label every adapter, the send gate and the claim table already key on.
Nothing is blocked without it, because a recipient can already subscribe to a
label. The identity and channel registry added later (see
[Unified bus](#unified-bus-identities-dms-channels-handoffs-and-wake)) follows
this rule: it resolves names to flat labels before delivery and leaves the wire
envelope unchanged.

## Unified bus: identities, DMs, channels, handoffs and wake

RQ-BUS-UNIFY-1 makes this store the single bus for every agent, whatever CLI,
provider or model runs it. It adds names and conventions, not a second store:
every send below is one `appendBusInbox` post, and every wake is one row in the
existing wake queue. The model is Grok Bot teammates and SendToAgent: address a
teammate by name, and raise the priority when it must act now.

**Identity.** `phm agents bus id register <handle>` records an identity in
`<root>/agent-identities/registry.json` beside `<root>/bus-inbox` (default root
`$ASHLR_HOME/fleet`, 0600 file in 0700 directories, writer lock, atomic
replace). The id is `agt_` plus 20 hex characters of SHA-256 over the handle,
so it is the same on every node and does not change when the agent moves from
Claude to Codex or from one model to another. Each identity keeps:

- `runtimes`: every `{cli, provider, model}` it has run on, newest refreshed in place;
- `aliases`: legacy routing labels it still answers to (lane names, v2
  `participantId`s). An alias belongs to exactly one identity and may not start
  with `agent:`, `group:`, `dm:` or `handoff:`.

An identity is a routing name, never authentication. It grants no tool, spend,
send or execution authority; consumers keep their own admission checks.

`phm agents bus id show [<ref>]` is the one-ref read of that registry: with a
ref — a handle, `agent:<handle>`, stable `agt_` id or alias — it resolves
through the same `resolveAgent` exact-label rule every bus read applies and
reports the identity's card: its id, `agent:<handle>` address, aliases,
runtimes and the registry channels whose member list names its handle (the
`group:<channel>:*` addresses pending work also matches). With no ref it
reads `PHM_AGENT_ID` instead, answering "who am I" and additionally reporting
the CLI this process detected (`self: true`, `cli`). A well-formed ref that
names no identity is `unknown`, a non-label ref `invalid`, an unreadable
registry `unavailable` and a missing `PHM_AGENT_ID` on the self path `unset` —
unknown identity state is reported, never guessed, and the read writes
nothing. `fleet_agent_identity` (the isolated fleet MCP tool) serves the
same card for a required `agent` ref — the shared server has no per-caller
`PHM_AGENT_ID`, so the no-ref self view never runs there — under the
identical `busAgentView` validation, so an MCP-connected agent resolves a
label it saw in a message row, claim owner or channel member list to the
canonical id, `agent:<handle>` address, aliases, runtimes and member
channels without shelling out to `phm`; it accepts no caller root or path
and never registers, aliases, joins channels or writes.

**Addresses.** The envelope keeps its fields; the unified API fills in the
channel metadata group (`sender.agent_id` is the `agt_` id, `sender.vendor` the
latest runtime's provider, `origin_bridge` is `agent-bus`).

| Kind | `to` | `channel` | Body |
| --- | --- | --- | --- |
| DM | `agent:<handle>` | `bus` | v2 `note`, or `context` with `--kind context` |
| Channel post | `group:<channel>:<topic>` (topic defaults to `general`) | `bus` | v2 `note`, or `context` with `--kind context` |
| Label post | any printable routing label outside the reserved `agent:`/`group:`/`dm:`/`handoff:` prefixes | `bus` | v2 `note`, or `context` with `--kind context` |
| Handoff | `agent:<handle>` | `handoff` | `worker-handoff` (`taskId`, `prompt`), the shape `phm fleet handoff-receive` reads |
| Wake request | `agent:<handle>` | `bus` | v2 `wake` (`target`, `reason`, optional `jobId`) |

`phm fleet handoff-receive` and `phm fleet handoff-reply` run one retained
`worker-handoff` for the caller's `--to`. The flag names the recipient
identity, not one literal label: a handoff addressed to the `agent:` address,
bare handle, stable id or any alias of that identity all match, through the
same registry read the inbox, wakes and `bus next` claims use — the `--to`
itself resolves exactly, so a case-variant spelling names no identity. A
`--to` naming no registered identity — and an unreadable registry — keeps
exact-label matching, so unknown identity state never widens which handoffs
run. The check still only proves the envelope's addressee; routing labels are
never authenticated identities.

Channel posts are refused unless the sender is a member
(`phm agents bus channel create|join|leave`). `phm agents bus channel list
[--agent <handle>]` is the read side: it prints every registry channel with
its member handles, creator and creation time, or only the channels one
resolved identity belongs to. A missing registry is a verified-empty list
(`source: missing`), an unreadable one is `unavailable` — never an empty
list — and membership is a routing label set (who may post), not proof of
presence or authority. `fleet_agent_channels` (the isolated fleet MCP
tool) serves the same roster read with the optional `agent` ref as its
only argument — omitted it lists every registry channel, supplied it
narrows to the channels that resolved identity belongs to, and an
unregistered ref answers `unknown-agent` — under the identical
`listBusChannels` validation, so an MCP-connected agent learns which
rooms exist and who may post in them without shelling out to `phm`; it
accepts no caller root or path and never posts, joins, leaves or renames
a channel. `phm agents bus channel read <name> [--topic <t>]
[--from <agent>] [--exclude-from <agent>] [--thread <t>] [--priority P0..P3]
[--job <id>]
[--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>]
[--in-reply-to <id>] [--id <id>] [--body-kind <kind>]
[--result <reserved|admitted|complete|failed>] [--matched]
[--after <cursor>] [--limit <n>] [--frame <cli>]` pages the room's posts
oldest-first — every live envelope addressed to `group:<name>:*` (or one
`--topic`), minus `group.presence` heartbeats, which are observations with
their own read, not messages; `--from` narrows by sender through the same
identity-label matching `comms bus read` uses, `--exclude-from` drops
posts sent under any registered spelling of one identity — the same
sender-exclusion rule `comms bus read|watch`'s `--exclude-from`,
`fleet bus-follow`'s `--exclude-from` and `fleet_bus_inbox`'s `excludeFrom`
apply, with an unresolvable ref keeping exact-label matching, so a room's
noisy member never reaches the transcript while every other sender still
does — and it composes with `--from` so a sender both included and
excluded matches nothing, `--thread` narrows to
`note`/`context` bodies carrying that v2 thread label, `--priority`
keeps only posts stamped with that exact band — the same match
`comms bus read --priority` applies, and `--since` keeps only posts
received at or after the cutoff — the `phm messages` grammar (`15m`,
`2h`, `1d`, epoch ms or an ISO time) resolved to epoch ms, matched
inclusively on `receivedAt` like `phm messages --since` — while
`--before` keeps only posts received strictly before its own cutoff on
the same grammar, the exclusive upper bound composing with `--since`
into one `[since, before)` window on `receivedAt`, so "what did the room
say before time T" is one filtered read. `--contains`
keeps only posts whose scrubbed one-line summary — the same text the
inbox `--frame` renders per row — carries the needle as a
case-insensitive substring, whitespace collapsed on both sides, so "has
anyone posted about X in this room" is one filtered read; matching runs
over the rendered summary, never the raw body, so a secret-shaped value
stays unfindable even though it sits in the stored envelope — the same
guarantee `phm messages --contains` gives the timeline projection.
`--job` keeps only the room's posts
that name one job — a `work.post`, `work.status`, `work.result` or `wake`
body declaring that `jobId`, a `worker-handoff` assigning that fleet job
id through `taskId`, or a `note`/`context` body carrying the `job:<id>`
v2 thread label, the same `inbox --job` match — so a channel transcript
answers one job's posts without paging the whole room. `--in-reply-to`
keeps only posts whose object body cites that envelope id through its own
`inReplyTo` field — the same own-property exact match `phm messages
--in-reply-to`, `comms bus read|watch --in-reply-to`, `fleet bus-follow
--in-reply-to`, `fleet_bus_inbox`'s `inReplyTo` and `inbox --in-reply-to`
apply, never the `replyTo` alias or a substring — so "which room posts
answer envelope X" is one filtered read. `--id` keeps only the post whose
own wire id is strictly equal to the value — the same exact-envelope
match `comms bus read|watch --id`, `fleet bus-follow --id` and
`fleet_bus_inbox`'s `id` apply, never a substring or a body citation —
so "did envelope X reach the room" is one filtered read. `--body-kind`
keeps only posts whose body carries that exact kind discriminator — the
v2 `kind` field (`note`, `context`, `work.post`, `work.claim`,
`work.status`, `work.result`, `work.release`, `wake`), a `worker-handoff`
assignment or a notice kind, a bus-transport v1 `protocol.kind`, or a
`type`/`schema` notice discriminator, the same discriminator the row
summary switches on — matched exactly and case-sensitively, so "which
room posts are work results" or "which are wake requests" is one
filtered read of the transcript; a body carrying no discriminator never
matches, and an unrecognized but printable value is an honest empty
match, never an error. `--result` keeps only posts whose body is a
`work.result` receipt reporting that one outcome — `reserved`,
`admitted`, `complete` or `failed`, the same `WORK_RESULT_OUTCOMES`
vocabulary the work feed's `--result` filter validates — read through
the kind-scoped `busBodyResultOutcome` own-field match, so every other
body kind (a `work.release` body's own `released`/`completed` outcome
included) and a `work.result` carrying no outcome never matches: "which
room posts are failed result receipts" is one filtered read of the
transcript, the envelope-level audit trail the feed's per-job
newest-result `--result` cannot show. `--matched` reports `matched`, the
true pending total — every post the same filters accept across the whole
retained store — while `messages` still caps at `--limit`; because that
read scans to the store's end, `nextCursor` then resumes at the newest
shown row's cursor, the same rule `inbox --matched` applies. Returned rows
carry the same live evidence `inbox` annotates: claimable work and
worker-handoff posts report `held`/`holder` — whether a taken claim or
live hold already covers the exact receipt — and `work.post`,
`work.status`, `work.result` and `wake` posts report `job`, the live
feed state of the job they cite, each store read once per page and only
when a candidate is present (an unreadable store degrades the field to
unknown, never to free or empty). Reading needs
no identity and no membership; an unknown channel is `unknown-channel`, an
unreadable registry or store is reported — never an empty page passed off
as history. `fleet_bus_channel` (the isolated fleet MCP tool) serves the
same read with the same dimensions as arguments — `channel` required,
every channel-read filter as its MCP counterpart (`topic`, `from`,
`excludeFrom`, `thread`, `priority`, `job`, `since`, `before`, `contains`,
`inReplyTo`, `id`, `bodyKind`, `result`) and
`matched` as a JSON boolean — under the identical `readAgentChannel`
validation, so an MCP-connected agent reads a room's transcript, its
presence-free posts, sender handles and live hold/job annotations without
shelling out to `phm`; it accepts no caller root or path, needs no
identity or membership, and passes a refused or unavailable page through
untouched. `--frame <cli>` prints the page as the same bounded block the
inbox `--frame` produces — identical markers, scrub, clip bound and
held/holder/job bracket evidence for every CLI — with each post's bracket
naming its `#<channel>:<topic>` so a multi-topic transcript keeps per-topic
context; it is a CLI-only rendering, so `fleet_bus_channel` takes no
`frame` argument. Because channel addresses are bus-group addresses,
existing `subscribeGroup`
readers see the same posts.

**Label posts.** `phm agents bus post --to <label> --text <text> [--kind
note|context]` sends a v2 `note` (the default) or `context` body to any
printable routing label the other send verbs cannot address: a sink like
`leaders`, a shared topic like `fleet.mesh`, or any label a subscriber reads
through `comms bus read --to`, `bus-follow` or an identity's alias matching.
The reserved prefixes `agent:`, `group:`, `dm:` and `handoff:` are refused —
`dm`, `channel post`, `handoff` and `wake` own those addresses — and the
sender must still be a registered identity, so the mail carries the same
`agent-bus` sender metadata, scrub gate, priority-wake rules and id dedupe as
a DM. Delivery follows the label: a `to` that resolves to a registered
identity — any of its labels, exact first then lowercase — lands in its
inbox as
legacy mail and records a wake hint by the priority rules; a sink or topic
label reaches no identity inbox — its readers are the label's own
subscribers and projections. The body stays untrusted data: consumers of the
label keep their own admission checks, and addressing one grants no
authority.

**Priority wake.** P0 always wakes and cannot be turned off. P1 and handoffs
wake by default (`--no-wake` opts out); P2 and P3 wake only with `--wake`. A
wake is recorded after the store accepts the post, through `createBusWakeHook`
into `~/.ashlr-runs/bus/wake-queue.jsonl`, and carries only `id`, `from` and
`to`. Resending the same id returns `duplicate` from the store and re-attempts
the wake, which the queue deduplicates, so a failed wake is recovered without
a second message. The file is capped (2 MiB by default); an append past the
cap compacts it to the newest complete hints inside the 256 KiB window readers
observe, so a busy bus keeps waking rather than reporting every wake failed.

**Wake requests.** `phm agents bus wake --to <agent> --reason <text> [--job <id>]`
posts a v2 `wake` body — the one body kind that is itself a request to look at
the bus. The mail lands in the target's inbox like a DM, and the post always
records the same routing-only hint for its addressee through the post-accept
hook: the body's purpose is the hint, so the verb has no `--wake`/`--no-wake`
(a `wake: false` send is refused, not ignored). `target` repeats the
`agent:<handle>` address so body and hint name the same agent under every
label `wakes` matches. `reason` is capped at 512 characters by the contract;
`--job` names the job the wake concerns and joins its thread in the message
projections — it is threading metadata, never a feed lookup, so a wake needs
no announced job and reads no feed before posting. Like every send it is
untrusted data: a wake is a hint to read the inbox and grants no authority.

**Inbox.** `phm agents bus inbox <agent> [--thread <t>] [--from <agent>]
[--exclude-from <agent>] [--with <agent>] [--priority P0..P3] [--kind dm|channel|handoff|legacy]
[--job <id>]
[--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--channel <name>]
[--contains <text>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>]
[--result <reserved|admitted|complete|failed>]`
returns one page of
DMs, handoffs,
posts in the agent's channels (minus its own and minus `group.presence`
heartbeats, which are observations with their own read, never mail) and
traffic still addressed to any spelling that resolves to its identity —
the `agent:` address, bare handle, stable id or aliases, exact first then
lowercase, the same addressed-to fold `bus next`, `work mine`,
`handoff-receive` and the conversations reads apply — highest priority
first. A handoff is the `channel:'handoff'` stamp or the
receivable `worker-handoff` body `fleet handoff-send` posts on a legacy
envelope, under any of those labels or a member channel's `group:` address —
the same coverage `work mine` handoffs and `handoff-receive` apply;
`--thread` keeps only `note`/`context` bodies
carrying that v2 thread label, and `--from` narrows by sender through the
same identity-label matching `channel read` uses (a handle, `agent:<handle>`,
stable id or alias; an unresolvable ref keeps exact-label matching).
`--exclude-from` drops mail sent under any registered spelling of one
identity — the same sender-exclusion rule `comms bus read|watch`'s
`--exclude-from`, `fleet bus-follow`'s `--exclude-from` and
`fleet_bus_inbox`'s `excludeFrom` apply, with an unresolvable ref keeping
exact-label matching — so a flooding sender never reaches the page while
every other sender still does; it composes with `--from` so a sender both
included and excluded matches nothing, and with every other inbox filter.
`--with` keeps only the two-way exchange the addressed agent and one peer
name — the same pairwise rule `phm messages --with` and `agents
conversations --with` apply: the peer's labels on the sender side against
the agent's own labels on the addressed side, so channel posts and
channel-addressed handoffs — whose `to` is a room address, never the
peer — stay out while every `dm`, `legacy` and label-addressed `handoff`
the peer sent remains. It answers "our private pending thread", distinct
from `--from` which also keeps the peer's room traffic; the peer ref
resolves through the registry exactly like `--from`, with an unresolvable
ref keeping exact-label matching.
`--priority` keeps only mail stamped with that exact P0..P3 band — the same
match `comms bus read --priority` applies — so urgent mail is one filtered
read, not a page through the backlog. `--kind` keeps only one delivery kind —
`dm`, `channel`, `handoff` or `legacy`, the same `kind` each inbox row
reports — so an agent can read just its handoffs or just its direct mail in
one filtered read; it is the row's delivery class, not a v2 body kind, and it
composes with every other inbox filter. `--job` keeps only mail that names
one job — a `work.post`, `work.status`, `work.result` or `wake` body
declaring that `jobId`, a `worker-handoff` assigning that fleet job id
through `taskId`, or a `note`/`context` body carrying the
`job:<id>` v2 thread label, the same bucket the messages and conversations
projections group under `job:<id>` — so an agent on one job reads its
pending mail without paging the whole inbox and eyeballing each row's
`job` annotation. `--since` keeps only mail received at or after the
cutoff — the same `phm messages` grammar (`15m`, `2h`, `1d`, epoch ms or
an ISO time) resolved to epoch ms, matched inclusively on `receivedAt` —
so fresh mail is one filtered read without a persisted cursor, and it
composes with every other inbox filter including `--matched`. `--before`
keeps only mail received strictly before its own cutoff on the same
grammar — the exclusive upper bound every bus read's `--before` shares —
composing with `--since` into one `[since, before)` window on
`receivedAt`, so "what was in my inbox before time T" is one filtered
read.
`--channel` keeps only mail addressed to `group:<name>:*` of one registry
channel the agent belongs to — channel posts and channel-addressed
handoffs alike, matched on the delivery address rather than the reported
kind — so an agent in several rooms reads one room's pending mail in one
filtered read; it composes with `--kind` to separate a room's direct mail
from its assignments, and a channel the agent is not a member of simply
has no mail to show. `--contains` keeps only mail whose scrubbed
one-line summary — the same text the `--frame` read renders per row —
carries the needle as a case-insensitive substring, whitespace collapsed
on both sides, so "did anyone send me mail about X" is one filtered read
instead of a page through the backlog; matching runs over the rendered
summary, never the raw body, so a secret-shaped value stays unfindable
even though it sits in the stored envelope — the same guarantee `phm
messages --contains` gives the timeline projection. `--in-reply-to`
keeps only mail whose object body cites that envelope id through its own
`inReplyTo` field — the same own-property exact match `phm messages
--in-reply-to`, `comms bus read|watch --in-reply-to`, `fleet bus-follow
--in-reply-to`, `fleet_bus_inbox`'s `inReplyTo` and `channel read
--in-reply-to` apply, never the `replyTo` alias or a substring — so
"which of my pending mail answers envelope X" is one filtered read.
`--id` keeps only the row whose own wire id is strictly equal to the
value — the same exact-envelope match `comms bus read|watch --id`,
`fleet bus-follow --id`, `fleet_bus_inbox`'s `id` and `channel read --id`
apply, never a substring or a body citation — so "is envelope X still
pending for me" is one filtered read. `--body-kind` keeps only mail whose
body carries that exact kind discriminator — the v2 `kind` field (`note`,
`context`, `work.post`, `work.claim`, `work.status`, `work.result`,
`work.release`, `wake`), a `worker-handoff` assignment or a notice kind,
a bus-transport v1 `protocol.kind`, or a `type`/`schema` notice
discriminator, the same discriminator the row summary switches on —
matched exactly and case-sensitively, so "which of my pending mail are
work results" or "which are wake requests" is one filtered read; a body
carrying no discriminator never matches, and an unrecognized but
printable value is an honest empty match, never an error. `--result`
keeps only mail whose body is a `work.result` receipt reporting that one
outcome — `reserved`, `admitted`, `complete` or `failed`, the same
`WORK_RESULT_OUTCOMES` vocabulary the work feed's `--result` filter
validates — read through the kind-scoped `busBodyResultOutcome`
own-field match, so every other body kind (a `work.release` body's own
`released`/`completed` outcome included) and a `work.result` carrying no
outcome never matches: "which of my pending result receipts failed" is
one filtered read, the envelope-level audit trail the feed's per-job
newest-result `--result` cannot show. It composes
with every other inbox filter.
`--matched` additionally reports `matched`, the true pending total — every
row the same filters accept across the whole retained store, the same count
`work mine`'s inbox section reports — while `messages` still caps at
`--limit`; because that read scans to the store's end, `nextCursor` then
resumes at the newest shown row's cursor, so paging never skips an unshown
match. Persist
`nextCursor` only after handling the
page. `fleet_agent_inbox` (the isolated fleet MCP tool) serves the same
read with the same dimensions as arguments — `agent` required, every inbox
filter as its MCP counterpart and `matched` as a JSON boolean — under the
identical `readAgentInbox` validation, so an MCP-connected agent reads its
addressed mail, channel posts, handoffs and live hold/job annotations
without shelling out to `phm`; it accepts no caller root or path and
passes a refused or unavailable page through untouched.
`--frame <cli>` prints the page as one bounded block marked untrusted
data, the same for every CLI: each line summarizes the body — `note`,
`context` and `worker-handoff` carry their message text, while typed
kinds compose one scrubbed line (`work.status <job> <status> — <detail>`,
`work.result <job> <outcome> — <reason>`, `interjection <channel>: <text>`,
`peer.message <kind> <from>-><to>: <text>`, `protocol <kind> <topic>: <ref>`,
and so on across the channel, leader, peer, group, cos, incident and
fleet-ops notices (`apps-watch.*.v1`, `reset-watch.*.v1`, `fleet-event`,
`fleet-self-loop-pass`, `org.membership`, `work-board-notify`,
`desktop.intent`, `apps-control`) that share the store — watcher error
payloads summarize as counts only, never message text); claim tokens and
`work.result` queue/receipt ids
never appear, string bodies render as their scrubbed text, and
unrecognized bodies keep a secret-scrubbed raw JSON render clipped to 512
characters so one large body cannot crowd out the rest of the frame.
Claimable work and worker-handoff items carry `held`/`holder` — the same
hold evidence `show` reports — so an agent sees whether pending work is
already taken, and by whom, without a lookup per message; the marker also
appears inside the frame's bracket on those items. `held` is
`true`/`false` only when both hold stores were read — a store that cannot
be read reports `held: null` (unknown), never free.
Items whose body names a job — `work.post`, `work.status`,
`work.result` or `wake` declaring a `jobId`, or a `worker-handoff`
assigning its fleet job id through `taskId` — additionally carry `job`:
the same
live feed state `show` resolves for the job the body names, computed
with one claims-joined feed read per page rather than a lookup per
message — so an agent paging mail sees where each announced job stands
(status, claim coverage, `job: null` on an orphaned citation, or the
feed's own `refused`/`unavailable` state) without a `show` per item; the
compact `job=<id>:<state>` marker rides inside the frame's bracket and on
the human line the same way `held` does, and `work mine`'s inbox section
carries the same field.
**Follow.** `phm agents bus follow [<agent>] [--after <cursor>]
--duration-ms <1..3600000> [--interval-ms <100..60000>]` plus every inbox
filter above streams the same `readAgentInbox` projection as JSONL —
each accepted row emits one `{type:'message', ...}` record carrying the
inbox row's fields and the same scrubbed `summary` the `--frame` read
renders, and every advance of the scan position emits a
`{type:'checkpoint', cursor}` record after the messages it covers, so the
last checkpoint is always a safe at-least-once resume point for
`--after`. `--duration-ms` is required and bounds the stream's lifetime;
`--interval-ms` sets the poll cadence (defaults shared with
`fleet bus-follow`). A page that fills its 100-row cap re-polls without
sleeping so a retained backlog drains inside the same deadline, while a
short page waits one interval — the stream never spins on an empty
store. `SIGINT`/`SIGTERM` cancel cleanly at the next poll boundary, and
an expired stream emits one final checkpoint so the last accepted cursor
is always on the wire. Exit status is `0` on `expired`/`cancelled`, `2` on `invalid`
arguments, `1` on `unknown-agent`, `source-unavailable` or
`output-unavailable` — an output failure ends the stream rather than
silently skipping rows. Unlike `fleet bus-follow`, which streams raw
fleet-wide envelopes for transport-level consumers, `agents bus follow`
watches one identity's addressed projection — DMs, handoffs, channel
posts and legacy traffic with the same kind/held/job annotations `inbox`
reports — so an agent on the unified surface can wait for mail without
polling `inbox` in a loop or dropping to the raw-envelope stream.
`phm agents bus wakes [<agent>] [--all] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--job <id>]
[--from <agent>] [--exclude-from <agent>] [--priority P0..P3]
[--channel <name>] [--contains <text>] [--thread <t>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>]
[--result <reserved|admitted|complete|failed>]` lists wake
hints for the agent — addressed under any spelling that resolves to its
identity, exact first then lowercase, the same fold the inbox read
applies — and its
channels. `--all` drops the addressee scope entirely — every hint in the
bounded queue tail, registered identities' and bare coordination or
routing labels' alike, each row's own `to` naming its addressee — so a
leader or comms pass sees who has pending hints in one read under
`scope: 'fleet'` instead of one `wakes` call per identity; it takes no
agent operand and the same filters apply. `--since` keeps only hints after the cutoff — the same `phm
messages` grammar the inbox and channel read take, resolved to epoch ms —
so a wake-driven agent reads just the hints newer than its last check.
`--before` keeps only hints recorded strictly before its own cutoff on
the same grammar — the exclusive upper bound composing with `--since`
into the wakes read's own `(since, before)` window on the hint's queue
time — so "which hints were pending before time T" is one filtered read.
`--from` keeps only hints whose recorded sender label matches one agent —
a handle, `agent:<handle>`, stable id or alias resolving every label of
that identity through the same `agentRefAddressMatcher` rule `inbox --from`
and `channel read --from` apply, with an unresolvable ref keeping
exact-label matching; the matched label is the hint row's own `from` —
the triggering envelope's sender on a `bus.send` hint, the posting
identity's `agent:<handle>` on a claim-holder `wh-…` hint — so "which
agent keeps waking me" is one filtered read that composes with `--since`
and `--job`. `--exclude-from` drops hints sent under every registered
spelling of one identity through the same matcher and exact-label
fallback `--from` applies — composing with `--from` so a sender both
included and excluded matches nothing — so "everyone's wakes except the
noisy bot's" is one filtered read, and `matched` stays the count the
whole filter set accepts. `--channel` keeps only hints addressed to
`group:<name>:*` of one channel — the same room prefix `inbox --channel`,
`channel read` and `phm messages --channel` match, grammar-validated by
the shared channel-name rule — decided on the hint's own `to` label, so
it needs no referent resolution and composes with the addressee scope
and every other filter: on a per-agent read it narrows to one room's
hints for that agent (a channel the agent does not belong to simply has
no hints to show), and on `--all` it answers "which hints concern room
X" in one fleet read, with `matched` counting it inside the queue-tail
match like `from`/`excludeFrom`. A ref that resolves to no registered identity keeps exact-label
matching instead — the page reports `scope: 'label'` (vs `'identity'`),
`agent` the queried label verbatim, and only hints whose `to` is that label
match — so hints queued under a bare coordination or routing label, like the
raw claim-owner labels the claim-holder fan-out writes, stay readable by
their addressee. The page reports `matched` — every hint the bounded queue tail
accepted for the agent before its row cap — and `truncated`, true when the
256 KiB observation window or the row cap cut matches beyond the returned
slice, so a capped list is never passed off as the whole queue. `--job`
keeps only the hints that provably name one job — the same
`busBodyJobMatch` rule `inbox --job` and `channel read --job` apply,
decided on the live referent: a feed `jobId` citation, a `worker-handoff`
`taskId` or a `job:<id>` thread label on the message the hint refers to,
or the `jobId` a claim-holder hint's citing status carries. A hint whose
referent is `unresolved` or `unknown` names no provable job and never
matches; because the verdict needs the resolved referent, an unreadable
bus store makes the filtered read `unavailable` rather than an empty
page, and `matched` then counts the proven matches on the resolved page
while `truncated` keeps its queue-tail meaning. `--contains` keeps only
the hints whose resolved referent text — a `bus.send` hint's live message
summary or a claim-holder hint's citing `work.status` detail, the same
scrubbed one-line text the row reports — carries the needle as a
case-insensitive substring, so "which wake was about X" is one filtered
read; a hint whose referent is `unresolved` or `unknown` names no
provable text and never matches, an unreadable bus store makes the
filtered read `unavailable`, and `matched` counts the proven matches on
the resolved page. `--priority` keeps only the hints in one exact
P0..P3 band — the same match `inbox --priority`, `channel read
--priority` and `work feed --priority` apply — decided on the resolved
referent's own band: the live message a `bus.send` hint points at, or
the citing `work.status` receipt's band behind a claim-holder `wh-…`
hint (carried on the row's `claimHolder.priority`); a hint whose
referent is `unresolved` or `unknown` names no provable band and never
matches, an unreadable bus store makes the filtered read `unavailable`,
and `matched` counts the proven matches on the resolved page. `--thread`
keeps only the hints whose resolved referent is a `note`/`context` body
carrying that v2 thread label — the same `busBodyThread` own-field match
`inbox --thread` and `channel read --thread` apply to the message a hint
refers to — so "which wake was about thread T" is one filtered read; a
claim-holder `wh-…` hint's referent is a `work.status` receipt, which
carries no thread label, so those hints never match, an
`unresolved`/`unknown` referent names no provable thread and never
matches, the unreadable-store and `matched` rules are `--job`'s, and a
malformed label answers `invalid`. `--in-reply-to` keeps only the hints
whose resolved referent body cites that envelope id through its own
`inReplyTo` field — the same own-property exact match `inbox
--in-reply-to`, `channel read --in-reply-to`, `phm messages
--in-reply-to`, `comms bus read|watch --in-reply-to`, `fleet
bus-follow --in-reply-to` and `fleet_bus_inbox`'s `inReplyTo` apply,
never the `replyTo` alias or a substring — so "did the reply to
envelope X trigger a wake" is one filtered read; claim-holder hints
never match for the same reason, the unreadable-store and `matched`
rules are `--thread`'s, and a malformed id answers `invalid`. `--body-kind`
keeps only the hints whose resolved referent body carries that exact
kind discriminator — the same `busBodyKind` match `inbox --body-kind`
and `channel read --body-kind` apply, decided on the resolved
referent: the v2 `kind` field, a `worker-handoff` assignment, a
bus-transport v1 `protocol.kind`, or a `type`/`schema` notice
discriminator, matched exactly and case-sensitively — so "which wakes
cite `work.post` announcements" or "which wakes were caused by
`work.status` receipts" is one filtered read; a claim-holder `wh-…`
hint's citing receipt provably carries `work.status`, so those hints
match only that kind, an `unresolved`/`unknown` referent names no
provable kind and never matches, the unreadable-store and `matched`
rules are `--thread`'s, and a malformed value answers `invalid`. `--result`
keeps only the hints whose resolved referent is a `work.result` body
reporting that one outcome — reserved, admitted, complete or failed,
the same `WORK_RESULT_OUTCOMES` vocabulary the work feed's `--result`
filter validates — read through the kind-scoped `busBodyResultOutcome`
own-field match `inbox --result` and `channel read --result` apply,
so every other body kind (a `work.release` body's own
`released`/`completed` outcome included) and a `work.result` carrying
no outcome never matches: "which wakes were triggered by a failed
result receipt" is one filtered read, the wake-level audit trail the
feed's per-job newest-result `--result` cannot show. A claim-holder
`wh-…` hint's citing receipt is a `work.status` body, which provably
reports no result outcome, so those hints never match; an
`unresolved`/`unknown` referent names no provable outcome and never
matches either, the unreadable-store and `matched` rules are
`--thread`'s, and an outcome outside `WORK_RESULT_OUTCOMES` answers
`invalid`. `--id`
keeps only the hint whose own id is strictly equal to the value — the
triggering envelope's wire id on a `bus.send` hint, the `wh-…`
claim-holder id on those — the same exact-id match `inbox --id` and
`channel read --id` apply, decided on the queue row alone inside the
queue-tail match like `--channel`/`--from`/`--before`, so it counts in
`matched` and needs no referent resolution: "is the wake for envelope X
still pending" is one filtered read. Claim-holder
hints (`wh-…` ids) carry no envelope id of their own, so the read re-derives
each one's citation against the live `work.status` receipts that could have
generated it: a match annotates the row with `claimHolder` naming the status
receipt (`statusId`, `jobId`, `status`, optional `detail` — `agents bus show
<statusId>` resolves it), no reproducing receipt reports `unresolved`, and an
unreadable bus store reports `unknown`, never a guessed citation. Every
other `bus.send` hint carries the triggering envelope's wire id as its own
`id`, so the same bounded store scan resolves the live message it refers to:
the row gains `message` — `resolved` with the receipt's summary, priority,
sender handle, channel and, for claimable work or a job citation, the
same `held`/`job` evidence an inbox row carries; `unresolved` when the store
was read and holds no live envelope with that id; `unknown` when the store
cannot be read. Triage no longer costs one `agents bus show` per hint.
`fleet_agent_wakes` (the isolated fleet MCP tool) serves the same read with
the same dimensions as arguments — `agent` optional (omitted, the
fleet-wide `--all` read under `scope: 'fleet'`), `since`/`job`/`from`/
`excludeFrom`/`channel`/`priority`/`contains`/`thread`/`inReplyTo`/`bodyKind`/`result`/`id` the same filters — under the identical
`readAgentWakes`/`readAllWakes` validation, so an MCP-connected agent reads its wake
hints, claim-holder citations and resolved referents — or the whole
fleet's pending hints in one call — without shelling out
to `phm`; it accepts no caller root or path and passes a refused or
unavailable page through untouched.

**Lookup.** `phm agents bus show <id>` resolves one retained envelope by the
wire id wake hints, `work mine` items and claim operations cite — the third
addressing mode beside labels and cursors. The scan is the same bounded page
walk the other reads use and sees live rows only: an expired or never-posted
id reports `not-found`, an unreadable store `unavailable`, and the read needs
no identity or addressing scope. The sender's registered handle decorates the
result as `fromAgent` when the registry resolves it — best-effort, so an
unreadable registry never hides the envelope itself. Claimable work and
worker-handoff bodies additionally report `held`/`holder`: whether a taken
message-id claim or a live coordination hold already covers that exact
receipt, the same evidence `work mine` next/handoffs and the unified comms
inbox show. `held` is `true`/`false` only when both hold stores were read —
a store that cannot be read reports `held: null` (unknown), never free.
A body that names a job — `work.post`, `work.status`,
`work.result` or `wake` declaring a `jobId`, or a `worker-handoff`
assigning its fleet job id through `taskId` — additionally reports `job`:
the live
work-feed state of the job the body names — the same projection
`work feed` serves, joined with claim coverage — so the `post=`/`status=`
citation resolves to where the job stands without a second read. `feed` is
`ok` with the projected `job` (`null` when the feed is healthy but projects
no live job with the id — an orphaned status whose announcement expired),
`refused` with the feed's reason and receipt when the projection refuses,
or `unavailable`/`retryable`/`invalid` when it cannot be read; the envelope
lookup itself still succeeds either way, and an open job's `claimable`
degrades to `null` — never free — when hold coverage is unknown.
A claim-holder `wh-…` hint id — the id `wakes` and `work mine` print for
those rows — resolves the same way `wakes` annotates it: through the wake
queue's retained row and the live terminal `work.status` receipts that
could have generated it, returning the citing receipt with a `wakeHint`
citation (`to` holder label, `statusId`, `jobId`, `status`, optional
`detail`). A hint with no retained row or no reproducing receipt reports
`not-found`, an unreadable wake queue `unavailable` — never a guessed
receipt. Envelope ids are caller-chosen printable tokens, so a real
receipt always wins over hint interpretation. `fleet_bus_show` (the
isolated fleet MCP tool) serves the same read with `id` as its only
argument — the same printable routing-label rule — so an MCP-connected
agent resolves the `post=`/`status=`/`receipt=`/handoff and wake-hint
citations the other bus reads emit without shelling out to `phm`; it
accepts no caller root or path and passes every lookup status through
untouched. `fleet_bus_thread` (the isolated fleet MCP tool) serves the
`fleet bus-thread --id <id>` read the same way — the root receipt plus
every live envelope whose own `inReplyTo` field transitively cites it, in
cursor order, including the kindless `{inReplyTo, text}` replies the
classified projections never group — under the identical printable
`id` rule, with `rootFound`/`complete`/`sourceFailure` keeping a proven
miss distinct from an unreadable walk and no caller root or path
accepted. `phm agents bus thread <id>` serves the same reply-chain read
on the unified surface itself — the identical `readBusThread` projection,
printable `id` rule, `rootFound`/`complete`/`sourceFailure` honesty and
live evidence — so an agent already working `agents bus` reconstructs one
exchange's raw chain without dropping to the fleet command family; like
`fleet bus-thread` it takes a wire id only, so a `wh-…` claim-holder hint
id reports `not-found` here rather than resolving through `show`'s
wake-hint path. All three surfaces read with live evidence: every message
carries the same `held`/`holder`/`job`/`fromAgent` annotations `agents bus
inbox`, `agents bus channel read` and `agents bus show` report — whether
a claimable work or worker-handoff body in the chain is already taken,
the live feed state of any job a body cites, and the registered handle
behind each sender label — so the thread answers "is this work claimed"
and "where does the cited job stand" without a `show` per message.

**Work announcements.** `phm agents bus work post --job <id> --title <text>
--repo <owner/name> [--claim <key>]... [--provider <p>] [--tier <fast|mid|work|frontier>
--scope <text> --acceptance <text>] [--to <label>]` sends a v2 `work.post`;
`phm agents bus work status --job <id> --status <queued|running|idle|rescheduled|blocked|done|failed|terminated>
[--detail <text>] [--to <label>]` sends a v2 `work.status`. Both default to the
`leaders` sink, priority P2 and a 7-day TTL, fill `from` with `agent:<handle>`
and run the same scrub, wake and append path as every other send. The provider
defaults to the sender identity's newest runtime provider — the feed refuses
posts it cannot attribute — while an explicit `--provider` wins and is
schema-checked. Before appending, each verb reads the live work feed: a post
is refused `conflict` when the job id is already shown, and a status is
refused unless the feed shows the job and the sender resolves to the identity
that announced it, under any of its labels. A refused, retryable, invalid or
unavailable feed refuses the send rather than posting a receipt that would
poison the projection. Neither verb dispatches, claims or executes anything;
the bodies remain untrusted contract data until a consumer admits them.

**Claim-holder wakes.** When a `work.status` reaches a terminal state
(`done`, `failed` or `terminated`), the send also queues one routing-only wake
hint per distinct live claim owner whose coordination keys overlap the job's
declared claim keys — the same overlap rule `claim acquire` uses — so a worker
holding `queue:`/`path:`/`repo:`/`pr:` scope learns the job ended instead of
waiting out its lease. The poster's own identity is skipped, labels of one
identity collapse to a single hint, and the fan-out is capped at 32 hints per
status; hint ids are a deterministic hash of the status envelope and holder,
so reposting the same status dedupes rather than re-waking. Because the hash
is one-way, `agents bus wakes` and `work mine` re-derive each `wh-…` hint's
citation on read — the hint's `to` label is the hashed holder, so scanning
live `work.status` receipts and re-hashing names the exact status that woke
the holder (`claimHolder` on the row: `statusId`/`jobId`/`status`/`detail`,
`unresolved` when no live receipt reproduces it, `unknown` when the bus store
cannot be read). `--no-wake` opts
out of this fan-out as well as the message's own hint, and non-terminal
statuses never fan out. The result's `claimHoldersWoken` counts the hints
present after the call — absent when the fan-out did not run, `null` when the
live claim table could not be read (unknown holders are never reported as
none), and a hint that cannot be written is best-effort, never a failed send.

`--open` on `phm fleet work-feed` and `phm agents bus work feed` implies
`--claims` and keeps queued/rescheduled jobs with declared claim keys. Complete
hold coverage excludes jobs whose every key is held; unavailable, absent or
truncated coverage keeps candidates visible with their existing claim
annotations. `--claimable` still requires proof of a free key. Both filters
compose with the existing feed filters. The unified inbox uses the same complete
hold coverage rule and reports incomplete coverage as degraded.

`phm agents bus work feed [--status <s>] [--job <id>] [--repo <owner/name>]
[--provider <p>] [--tier <fast|mid|work|frontier>] [--to <label>] [--owner <agent>]
[--channel <name>] [--result <reserved|admitted|complete|failed>] [--id <envelope-id>]
[--claims] [--open] [--claimable]
[--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--limit <1-200>]`
reads the
same projection back — jobs newest-first, optionally filtered by status,
exact job id, announced repo, provider, declared dispatch tier,
announcement address, announcing
agent, descriptive text or a cited envelope id and joined with the
live coordination holds — so the
whole post/status/feed loop stays on this surface without dropping to
`phm fleet work-feed`. With `--claims`, every open job (`queued`/`rescheduled`)
also carries the same per-key hold coverage `work mine` reports —
`freeKeys`/`heldKeys` plus a tri-state `claimable` that is `null` whenever hold
coverage is `truncated` or `unknown`, never a guess — and the human lines mark
it `claimable=yes|no|unknown`; non-open jobs and claimless reads carry none of
the fields, so "which of these can I claim" answers in one read instead of a
second join. `--claimable` keeps only the open jobs whose `claimable` is
provably true — it implies the claims join, and unknown coverage never counts
as claimable, so an unreadable hold table answers an honest empty view rather
than a guessed one. Every job cites the retained envelopes its state came
from: `postId` is the wire id of the `work.post` receipt that announced it
and `statusId` the wire id of the newest accepted `work.status` receipt
(`null` while none has moved it), so `phm agents bus show <id>` resolves the
evidence behind a job without a second scan; the human lines print them as
`post=`/`status=`. A schema-clean `work.result` citing the job adds a
`result` citation — the result receipt's wire id, reporting label, outcome,
optional bounded `reason` and receipt time — which the human lines print as
`result=<outcome> [reason=<r>] by=<from> at=<iso> receipt=<id>`. A
`work.result` is reported outcome evidence only: it never moves the job's
status, detail or `updatedAt` — only the announcer's `work.status` does —
and a malformed or orphan result is ignored like any other non-feed body,
never a projection refusal. `--to` keeps jobs whose announcement was addressed to
that routing label and `--owner` keeps jobs announced by that agent; each
matches literally and under every label of one agent identity the ref resolves
to through the registry — a handle, `agent:` address, stable id or alias,
matched exactly, so a case-variant spelling names no identity — while an
unresolvable ref or an unreadable registry keeps exact-label matching. `--channel` keeps only jobs announced to `group:<channel>:*` — the room's whole traffic under every topic, the same address prefix `inbox --channel`, `channel read` and `phm messages --channel` match on the raw routing label; the value takes the strict channel-name grammar, needs no registry, and a name outside it is a usage error. `--repo` keeps jobs announced for one `owner/name`
repo, compared case-insensitively under the same rule claim keys use, and
`--provider` keeps jobs announced for one provider; a malformed `--repo` or
`--provider` is a usage error, never a silent empty view. `--tier` keeps
only jobs whose `work.post` declared that dispatch tier — the same
`fast`/`mid`/`work`/`frontier` values `work post --tier` writes and the job
line renders as `tier=<t>`; a job carrying no dispatch spec declares no
tier and never matches, so the filter answers "which announced jobs are for
my tier" in one read and an unrecognized value is a usage error like every
other feed filter. `--since` keeps
only jobs whose last activity reaches the cutoff — `updatedAt`, the receipt
time of the newest accepted `work.status`, or the `work.post` receipt time
while no status has moved the job — matched inclusively like every other
`--since` bus read, so "which jobs moved lately" is one filtered read
instead of paging terminal jobs that have sat unchanged. `--before` keeps
only jobs whose `updatedAt` is strictly before its own cutoff on the same
field and grammar — the exclusive upper bound `--since` lacks — so the
pair reads one `[since, before)` window with no boundary job counted
twice, and, because the view sorts newest-first under the `--limit` cap,
`--before` at the oldest shown job's `updatedAt` reaches the older jobs a
plain newest page can never show once more than the cap match. `--contains`
keeps only jobs whose descriptive text carries the needle as a
case-insensitive substring — the announcement title, the newest status
detail and the declared dispatch scope/acceptance, each scrubbed,
single-lined and clipped at the same bounds the job line renders, with
whitespace collapsed on both sides like every other `--contains` bus
read — so "which announced jobs mention X" is one filtered read; ids,
claim keys, statuses and routing labels are structured fields with their
own filters, never search text, and a secret-shaped value is scrubbed
before the match even though the stored envelope keeps it. `--result`
keeps only jobs whose newest retained `work.result` citation carries that
outcome — one of the `reserved`/`admitted`/`complete`/`failed` codes the
result body reports — so "which jobs have workers reporting an outcome,
and which" is one filtered read and a `complete` result sitting on a
still-`running` job — the divergence the citation exists to surface —
answers directly; a job with no retained result never matches, unknown
stays out of a positive filter, and an unrecognized value is a usage
error like every other feed filter. `--id` keeps only jobs whose retained
envelope citations include that wire id — the `work.post` announcement,
the newest `work.status` receipt or the newest `work.result` receipt the
job's state cites, the same ids the job line prints as `post=`/`status=`/
`receipt=` and the same `busWorkFeedJobCitesEnvelope` match `work mine
--id` applies to its job sections — so "which feed job does envelope X
belong to" is one filtered read instead of paging the feed and eyeballing
citations; the match is exact wire-id equality, never a substring or a
body citation, and an id nothing on the feed cites is an honest empty
match. `--limit`
pages the filtered view newest-first (1–200) and reports `matched` as the
true filtered total before the cap and `omitted` as the rest — the same
page `fleet_work_feed`'s `limit` argument (default 50 there) and the
endpoint's `limit` parameter serve through the shared
`sliceBusWorkFeedView`, with claims holds regrouped under the shown jobs
only. The filters narrow
the fleet view, they never widen
it. `phm fleet work-feed` accepts the same flags.

**Job claims.** `phm agents bus work claim --job <id> --lease-ms <1..3600000>
[--key <claimKey>] [--owner <label>] [--id <opId>]` is the job-level companion
to `claim acquire`: it reads the live feed, refuses unless the job is shown
and still open for a worker (`queued` or `rescheduled` — the same
`BUS_FEED_OPEN_STATUSES` the comms inbox pending-work view uses), resolves one
of the job's declared claim keys — `queue:<jobId>` preferred, `--key` picks
another declared key — and runs the same coordination acquire, so the
post → feed → claim → status loop never makes a caller reconstruct key
conventions. An undeclared `--key`, a job the feed does not show, a non-open
status or a job with no claim keys refuses before any lease; a refused or
unreadable feed refuses rather than claiming against a guessed job. The
result echoes the announced job — with the feed's `postId`/`statusId`
receipt citations, so `agents bus show <postId>` reads the announcement
behind every outcome — and, on `acquired`, the fencing token for its
acquirer only; a conflict names the holder, never a token. `acquired` and
`conflict` also carry `scope` — the live coordination holds on the job's
*other* declared claim keys (the targeted key excluded), each
`{claimKey, owner, leaseUntil}` under the same overlap rule `work feed
--claims` applies, so a sibling `repo:`/`path:`/`pr:` scope already held by
another participant is visible in the claim result itself rather than on a
later feed or claim-list read. `scope.source` is `missing`, `available` or
`unavailable`; an unreadable table means sibling holds are unknown, never a
free set. Exit 0 acquired,
2 invalid, 1 otherwise. Claims still coordinate scope only — holding one
never permits a merge, a push, or spending.

**Per-agent work view.** `phm agents bus work mine [<agent>] [--job <id>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--priority P0..P3] [--channel <name>] [--from <agent>] [--exclude-from <agent>] [--id <id>] [--in-reply-to <id>] [--body-kind <kind>] [--result <reserved|admitted|complete|failed>] [--thread <t>]` is the read-only
digest that answers "what is pending for this agent" in one call: the live
coordination claims it holds under any of its labels (with the
announced jobs each claim's keys block — the reverse of `work feed --claims`,
each carrying the feed's `postId`/`statusId` receipt citations like `claim
list --jobs`). An `origin:'message'` claim — the `queue:<envelope-id>` lease
`bus next`/`bus-claim` take on one retained receipt — additionally resolves
to that live envelope in the same bounded store walk the next/handoffs
sections use, so the digest names the message a claim covers without a
`bus show` per row: id, cursor, receipt and expiry times, priority, raw
`to`/`from` labels with the resolved `fromAgent`, body kind, a scrubbed
one-line summary and, on job-citing bodies, the same live feed
citation the inbox resolves. The claims journal pins the exact
`(id, cursor, receivedAt)` receipt generation the lease took: a live row
matching that triple resolves `pinned:true`; journal rows for the claim
whose triple no live receipt reproduces report `not-found` — a same-id
receipt that replaced the pinned generation is a different message the
claim does not cover, never a stand-in; a clean journal with no row for
the claim falls back to the newest same-id receipt with `pinned:false`,
and an unreadable journal resolves by bare id with `pinned:null`. An
unreadable inbox degrades only the annotation (`unavailable`/`retryable`/
`invalid`) while the claim row itself still lists — the same rule `held`
follows, and no token or lease internal ever leaves the read,
the open work-feed jobs (`queued`/`rescheduled`, declaring at least one claim
key; newest 50 shown, `open` keeps the true total) annotated per declared key —
`freeKeys`/`heldKeys` plus a tri-state
`claimable` that is `null` whenever hold coverage is `truncated` or `unknown`,
never a guess — and `holders`, the shown live holds on the job's declared keys
each naming its `claimKey`, owner label, lease expiry and claim class, so the
digest answers "who blocks this key and until when" inside the same read
instead of a `claim list --jobs` join (`null` under `unknown` coverage, the
shown lower bound under `truncated`; fencing tokens and lease source ids never
leave the store) — the claimable work envelopes addressed to it, the same live
`kind:'work'`/protocol-`task` receipts `fleet bus-next` would walk in claim
order (priority band, then cursor; the first 10 shown, `matched` the true
total), each carrying its hold state against the message-claim journal and
the coordination table — `held` is tri-state, `null` whenever either store is
unreadable, never a guess — the worker-handoff envelopes addressed to it that
`fleet handoff-receive`/`handoff-reply` would accept, found in the same
bounded walk and claim order (the first 20 shown, `matched` the true total;
an assignment the addressee already answered drops out once a live reply
routed recipient -> sender cites the handoff id through `inReplyTo`/`replyTo` —
the citation `agents bus dm|post|channel post --reply-to` stamps on a v2
`note`/`context` body; "recipient -> sender" resolves through the identity
registry, so the reply may travel under any label of either identity and a
channel-addressed handoff is answered by any member of that channel (an
unreadable registry keeps literal-label matching) —
the same durable evidence `agents conversations` credits when it marks the
thread answered),
each carrying the envelope `id` those verbs take as `--id`, the raw `to`
routing label they take as `--to` (a channel-addressed handoff matches only
its literal `group:<channel>:<topic>` label), the body's
`taskId`, sender and the same tri-state hold evidence — the conversation
threads waiting on its answer: the same `waiting` threads
`agents conversations --waiting` computes, narrowed to waits the agent
owes under any of its labels or a `group:<channel>:<topic>` address of a
channel it belongs to, minus threads whose waiting message it sent itself
(the first 20 longest-waiting shown, `matched` the true total; each item
cites the waiting message's envelope `id` for `agents bus show`, its
`kind`, `waitingOn`, `waitingMs`, sender and scrubbed subject) — and the
conversations it is waiting on: the outbound mirror over the same shared
read, every `waiting` thread whose latest message the agent sent and whose
`waiting.on` is not the agent itself — its own unanswered asks and
handoffs, each naming `waitingOn` plus the resolved `waitingOnAgent` (null
for a topic, a `group:` address, an unregistered label or an unreadable
registry), the same 20-item cap and `matched`/`truncated`/`skipped`
semantics; the two thread sections are mutually exclusive on every thread —
and the blocked conversation threads it is a party to: every
`state:'blocked'` thread the one shared conversations read reports (a
blocker or failed report nothing has answered), narrowed to threads with a
participant naming the agent under any of its labels or a
`group:<channel>:<topic>` address of a channel it belongs to — a block the
agent reported itself still lists, since the thread stays pending until a
newer message moves it — longest-standing first, the same 20-item cap and
`matched`/`truncated`/`skipped` semantics, each item citing the latest
message's envelope `id`, `kind`, sender, recipient `to`, `blockedMs`,
`messageCount` and scrubbed subject — the wake
hints addressed to it, capped at the
newest 20 with `matched` the count of every hint the bounded queue tail
matched for the agent before its row cap and `truncated` marking queue-tail
or cap cuts beyond the shown slice, and
the next page of mail in its inbox: the same matching, order and owner-share
receipt checks `agents bus inbox` applies, capped at the oldest 20 pending
messages with each body summarized by the shared one-line composer and
`matched` the true pending total — every row the same filters accept across
the whole retained store, counted by the full scan `readAgentInbox` performs
when asked — and
claimable work or worker-handoff mail keeps the same tri-state `held`/`holder`
evidence `agents bus inbox` reports, `null` whenever a hold store cannot be
read, never a guess, and mail whose body names a job — `work.post`,
`work.status`, `work.result` or `wake` declaring a `jobId`, or a
`worker-handoff` assigning its fleet job id through `taskId` — keeps the same `job`
live-feed citation `agents bus inbox` resolves — so pending work shows its
claim state and each announced job's standing without a second read. The inbox
section reads one row past the cap so `truncated` is definitive — a full
window proves mail remains beyond `nextCursor`, a short one proves the scan
reached the store's end — and `nextCursor` resumes strictly before any
unshown mail, so `agents bus inbox --after <nextCursor>` continues the page
without redelivering or skipping. The `mailbox` section is the digest's
window into the legacy `phm bus` mailbox store (`$ASHLR_HOME/bus-mailbox`,
the records `phm bus inbox --to <label>` reads and `phm bus ack` clears)
that the unified bus store never carried: every pending (unacked,
unexpired) message addressed to any of the agent's labels, merged in the
mailbox's own priority/acceptance/id drain order, the first 20 shown with
`matched` the true total and `truncated` definitive. Each item carries the
envelope `id` `phm bus ack` takes, the `to` label to pass verbatim as
`--to`, raw `from`, `priority`, `ts`, `expiresAt` and the same scrubbed
one-line `summary`; an absent store is a verified-empty `ok` and an
unreadable one reports `unavailable`, never an empty list passed off as
fact. The `board` section is the digest's window into the shared task
board — the store `phm bus board pending` reads — under every label the
agent answers to in one locked snapshot, so board work no longer needs a
separate `--peer` read per label: `peers` names the queried labels the
board actually knows (each a member of at least one thread), `threads`
keeps the board's joined-thread rollups, and `deliveries`/`tasks` carry
the board's pending items — each delivery's `id`+`threadId` feeding
`phm bus thread ack` directly, each task annotated with the fleet queue's
observed hold state (`open`/`held`/`ambiguous`/`unknown`, `unknown` for
every task when the queue cannot be read, never `open` by default) and,
when held, the owner peer label and lease expiry — never capability
material. Board paths derive exactly like the board CLI, an absent board
is a verified-empty `ok` (the read never creates its store), and an
unreadable board reports `unavailable`, never an empty list passed off as
fact; board content stays untrusted shared data and grants no authority.
The `channels` section is the digest's window into the registry channels
the agent belongs to — the routing context behind every
`group:<channel>:<topic>` item the next, handoffs, threads, inbox and
board sections match, so channel-addressed work no longer needs a
separate `agents bus channel list` read to learn which rooms the agent
sits in. Each entry names the channel and its registered `memberCount`
(the digest carries no member list — `channel list` does); membership
says who may post, never presence, attention or authority. The read
reuses the same registry load every other section resolves addressing
through — no second store walk — so a `missing` registry is a
verified-empty membership, `available` lists real memberships sorted by
name, and an unreadable registry reports `unavailable`, never an empty
list passed off as fact. An agent ref that resolves to no identity has no
handle and provably belongs to no channel, so `channels` is then empty,
not unknown.
The `seats` section is the digest's window into bot-seat handoff work —
the same `planSeatHandoffs` read `phm bots handoffs` and `phm comms
inbox --source seats` serve, so the digest, that verb and the unified
inbox can never disagree: every roster seat the agent denotes — by the
literal seat id or by its `participantId` under any of the agent's
identity labels, never widened on an unreadable registry — that is
eligible and still carries pending (not yet journaled) handoff records,
the first 20 shown with `matched` the true total and `truncated`
definitive. Each seat reports its config `seatId` (the `--seat` handle
`phm bots handoff` takes), `participantId`, projected lifecycle `state`
and its `handoffs` — every live claim key or fenced node job the seat
still holds as a `bus-claim`/`node-job` record carrying the
deterministic `handoffId` the apply journal dedupes on plus the claim's
`branch`/`pr` citations. Seat handoffs are agent work, never
owner-blocking, and the read never releases or applies — the act stays
`phm bots handoff --seat <id> --apply`. An unreadable seat store,
coordination table or node store reports `unavailable`, never an empty
plan passed off as fact. The section rides the async digest read
(`readBusWorkMineWithSeats`, what the CLI serves); the synchronous
`readBusWorkMine` leaves `seats` absent rather than reporting a section
it never read.
`phm comms inbox`'s `board` source projects the same store fleet-wide
through `BusBoard.pendingAll` — every thread member as the label set, so
no agent labels are needed ahead of time — listing each unacknowledged
delivery and each task whose observed hold is not `held` (`held` is
in-flight work, not pending) with the same missing/unavailable/degraded
honesty and `phm bus thread`/`task`/`board` deep links; it reads only,
never acknowledges or claims. `fleet_bus_board` (the isolated fleet MCP
tool) serves the same `readBusBoardPending`/`BusBoard.pendingAll` digest
directly — `job`, `contains`, `since`, `before`, `from` and `excludeFrom`
the board digest's shared filters under the same validation, the sender
pair resolved through the server-side identity registry like every other
bus read's — so an
MCP-connected agent reads the whole pending board, fleet-wide and
job-scoped, without flattening it into inbox items or knowing peer
labels ahead of time; it accepts no caller root or path, reports `source`
missing verified-empty versus unavailable, and never acknowledges or
claims.
`addressed` marks jobs that are pending work for the agent under the same
rule the feed `--to` filter applies — any label of its identity or a
`group:<channel>:<topic>` address of a registry channel it belongs to, minus
its own channel posts — and `announced` marks jobs whose `owner` (announcer)
label resolves to it — the agent posted them and owns their status reports,
so the digest distinguishes driveable announcements from claimable work. Each job also
carries the feed's `postId`/`statusId` envelope citations plus any
`work.result` report, so the digest
names the `agents bus show` handles behind every open job. The same feed
read backs an `announced` section — the outbound side of the jobs view:
every job whose announcer label resolves to the agent under the same owner
matcher that has not reached `done` or `terminated`, newest update first
(the first 50 shown, `matched` the true total, `truncated` definitive).
`failed` stays listed because only the announcer may move a job and a
failed one can still be rescheduled or terminated; each item is the feed
job plus the same per-key hold coverage the `jobs` section computes —
`held`/`heldKeys`/`freeKeys` under the shared complete/truncated/unknown
rule — with its `postId`/`statusId` citations and any `work.result` report, so a job still open
with claim keys appears in both `jobs` (the claimable view) and `announced`
(the ownership view), while a `running`/`idle`/`blocked`/`failed` or
claim-key-less announcement the agent posted no longer leaves the digest
invisible. Each announced item also carries `holders` — the same shown-hold
list the jobs section reports under the same unknown/truncated honesty — so
the announcer can tell a live worker from a stale lease on its own
declarations. The hold fields let the announcer see that a job reporting
`running`/`idle` has `held:false` — no live claim on its declared scope —
without a second `claim list` or `work feed --claims` read; only the
announcer may reschedule or terminate it. A non-ok feed reports the section's own
`refused`/`unavailable`/`retryable`/`invalid` state, never an empty list.
For the
`next`/`handoffs` sections "addressed to it" means any label of the resolved
identity or a `group:<channel>:<topic>` address of a registry channel it
belongs to — the same membership rule the inbox and wake reads apply, minus
the agent's own channel posts — so work posted to a shared channel is pending
for its members without a second read, and the `next` items are exactly the
receipts `bus next --to <agent>` matches under the same rule; an unreadable or
missing registry and an unresolvable ref contribute no channels, so matching
never widens on unknown state. `--job <id>` narrows the whole digest to
one job — "what is pending for this agent on this job" — under the same
`busBodyJobMatch` citation rule `inbox --job` applies (a feed `jobId`
body, a `worker-handoff` `taskId`, or the `job:<id>` thread bucket),
joined with the feed-id and board `itemId` joins each section already
makes: feed jobs and announced jobs match by id; a claim lists only when
it provably relates — declared-key overlap with an announced job or a
leased message body naming the job; `next`/`handoffs` keep only
pending-work envelopes whose body cites the job (claimable work receipts
name no job, so `next` is empty under `--job`, while handoffs keep their
`taskId` hits); threads, awaiting and blocked pass the job into the one
shared conversations read; wakes and inbox apply their own job filters;
mailbox mail keeps only bodies citing the job; the board keeps only
threads carrying a task whose `itemId` is the job id, with that thread's
deliveries and rollup riding along; and the seats section keeps only
`node-job` handoff records whose ref is the job id — a `bus-claim` ref is
a coordination claim key, not a job citation. Every count stays the
filtered
total, the result echoes `job` in JSON and the human header prints
`job=<id>`, and a row whose job relation cannot be proven stays out of
the match rather than padding it. `--contains <text>` narrows the whole
digest the same way — "what is pending for this agent about X" — under
the case-insensitive substring rule every other bus `--contains` read
applies, matched over each section's scrubbed one-line display text and
never over raw bodies, ids, claim keys as keys, statuses or routing
labels: feed and announced jobs match the feed's job search text
(title, newest status detail, declared dispatch); a claim lists only
when its displayed evidence carries the needle — a blocked announced
job's title/detail or a resolved leased message's summary; `next`,
`handoffs` and `mailbox` mail match the body summary; threads, awaiting
and blocked match member-message subjects through the shared
conversations read; wakes match the resolved referent's summary or
citing status detail; inbox applies its own contains rule; the board
keeps deliveries whose post text and tasks/threads whose titles carry
the needle — a thread rollup survives on a matching title or a
surviving member item, per-thread counts measure matching items only,
and `peers` still reports board membership independent of the text
filter; and seats keep only handoff records whose held-work
ref/branch/pr carries it. `channels` is registry context, not pending
work, and stays unfiltered; every count stays the filtered total, the
result echoes `contains` in JSON and the human header prints it, and a
row whose text cannot be proven never matches. `--since <when>` narrows
the whole digest the same way — "what is new for this agent since my
last check" — under the same `15m`/`2h`/`1d`/epoch-ms/ISO grammar and
inclusive `>=` rule the bus `--since` reads share (the wakes read's own
strictly-after boundary included, since the section delegates to it), so
a polling agent reads the delta instead of re-reading the whole pending
set; each section keys on the timestamp its own store keeps: claims match
the lease's recorded `started` (a null start never matches — unknown stays
out), feed jobs and announced jobs match `updatedAt`, `next`/`handoffs`
and inbox mail match the envelope receipt, mailbox mail matches
acceptance, threads/awaiting/blocked and wakes inherit their own reads'
since rules on latest activity, board deliveries match `createdAt`
while board tasks — which keep no timestamp — never match, and seats
stay unfiltered — a pending handoff record's `createdAt` stamps the
plan read instant, not the held work's age, so no per-record recency
exists to filter on. A pending item older than the
cutoff is still pending but is not new; `channels` and `seats` stay
unfiltered, every count stays the filtered total, the result echoes
`since` as ISO in JSON and the human header prints it. `--before
<when>` narrows the whole digest the other way — "what was pending for
this agent before time T" — under the exclusive upper bound every bus
read's `--before` shares on the same `15m`/`2h`/`1d`/epoch-ms/ISO
grammar, composing with `--since` into one `[since, before)` window
(the lower bound inclusive, the upper exclusive, an item stamped
exactly at either bound excluded from the excluded side). Each
section keys on the same per-store timestamp `--since` uses: claims
match the lease's recorded `started` strictly below the cutoff (a null
start never matches — unknown stays out), feed jobs and announced jobs
match `updatedAt`, `next`/`handoffs` match the envelope receipt,
threads/awaiting/blocked inherit the shared conversations read's
`lastAt` bound, mailbox mail matches acceptance, and board deliveries
match `createdAt` while board tasks — which keep no timestamp — never
match. `wakes` and `inbox` delegate both bounds to their shared reads —
`inbox` matching `receivedAt` and `wakes` the hint's queue time, each the
same exclusive upper bound every other bus read's `--before` applies —
so the cutoff reaches them like every other section; `channels` and
`seats` carry no per-item historical timestamp and stay unfiltered under
every filter, like they do under `--since`.
An item stamped at or after the cutoff never matches, every count
stays the filtered total, the result echoes `before` as ISO in JSON
and the human header prints it. `--priority
<P0..P3>` narrows the whole digest the same way — "what urgent work is
pending for me" — under the exact-band match every other bus
`--priority` read applies, across the sections whose items carry a wire
band: `next`/`handoffs` keep envelopes of that priority inside the
shared pending-work walk, `inbox` applies its own priority filter,
`mailbox` mail keeps only envelopes of that band, `wakes` keep hints
whose resolved referent reports that band (unresolved or unknown
referents never match — the wakes read's own rule), and claims keep
only message claims whose resolved leased envelope reports that band —
a claim with no resolved message, a scope-key claim or an
unresolvable/unreadable lease names no provable band and never lists,
the same "unknown stays out" rule `--job` applies. Feed jobs,
announced jobs, the three thread sections, board rows, `channels` and
`seats` carry no per-item band in their projections and stay
unfiltered; every count stays the filtered total, the result echoes
`priority` in JSON and the human header prints it, and a row whose
band cannot be proven never matches. `--channel <name>` narrows the
whole digest the same way — "what is pending for me in this room" —
under the same room prefix every other bus `--channel` read matches,
validated by the strict channel-name grammar and matched as a raw
`group:<name>:` prefix on each section's own address evidence:
feed jobs and announced jobs keep announcements whose `to` carries
the prefix (the feed `--channel` rule), `next`/`handoffs` and
`mailbox` keep envelopes whose `to` carries it, claims keep only
message claims whose resolved leased envelope sits in the room — a
claim naming no resolved message, a scope-key claim or an
unresolvable/unreadable lease names no provable room and never
lists, the same "unknown stays out" rule `--priority` applies, the
three thread sections keep threads whose latest message — the
wait's own recipient for waiting threads, the block report's
recipient for blocked ones — is addressed to the room, and `wakes`
and `inbox` pass the name to their own reads' channel filters (the
wakes read's raw `to` prefix, the inbox read's member-channel rule —
a room the agent does not belong to simply has no mail or hints to
show). `board`, `channels` and `seats` carry no per-item room in
their projections and stay unfiltered, like they do under
`--priority`; every count stays the filtered total, the result
echoes `channel` in JSON and the human header prints it, and a row
whose room cannot be proven never matches. `--from <agent>` narrows
the whole digest the same way — "what is pending for me from X" —
under the same sender rule every bus `--from` read applies, validated
by the printable-label bound and matched through the
`agentRefAddressMatcher` identity-label rule on each section's own
sender evidence: feed jobs and announced jobs keep announcements
whose `owner` resolves to the ref (the announcer is the sender of a
`work.post`), `next`/`handoffs`/`mailbox` keep envelopes whose `from`
the matcher accepts, claims keep only message claims whose resolved
leased envelope's `from` matches — a claim naming no resolved
message, a scope-key claim or an unresolvable/unreadable lease names
no provable sender and never lists, the same "unknown stays out"
rule `--priority` applies — the three thread sections pass the ref
into the shared conversations read's own `from` filter so a thread
survives on any member message the matcher accepts, `wakes` and
`inbox` pass it to their own reads' sender filters, and `board`
deliveries keep only posts whose `sender` peer label matches while
board tasks — which record no author — never match and thread
rollups keep only while a surviving delivery or task remains.
`seats` handoff records and `channels` carry no per-record sender in
their projections and stay unfiltered, like they do under
`--priority`; every count stays the filtered total, the result
echoes `from` in JSON and the human header prints it, and a row
whose sender cannot be proven never matches. `--exclude-from
<agent>` inverts the same match — "what is pending for me except
what X sent" — under the same `agentRefAddressMatcher` rule: a
section keeps an item unless its sender evidence resolves to the
excluded ref, so a sender that cannot be proven excluded is never
dropped; feed jobs and announced jobs keep announcements whose
`owner` does not resolve to the ref, claims keep only resolved
message claims whose leased envelope's `from` does not match (the
same "unknown stays out" rule — a claim with no provable sender
never lists), board deliveries drop posts whose `sender` resolves
to the excluded ref while board tasks stay listed — nothing proves
a task came from the excluded sender — and `seats`/`channels` stay
unfiltered like they do under `--from`. The two compose in the same
include-then-exclude order every bus read applies — a sender both
included and excluded matches nothing; every count stays the
filtered total, the result echoes `excludeFrom` in JSON and the
human header prints it. `--id <id>` narrows the whole digest the
same way — "is envelope X still pending for me, and where" — under
the same exact-envelope match every bus `--id` read applies,
validated by the printable-label bound: feed jobs and announced
jobs keep the jobs whose cited wire ids the value equals — the
`work.post` announcement, newest `work.status` receipt or newest
`work.result` receipt the job line prints as `post=`/`status=`/
`result=` — `next`/`handoffs`/`mailbox` keep envelopes whose own
id equals it, claims keep only message claims whose resolved
leased envelope's id equals it — a claim naming no resolved
message, a scope-key claim or an unresolvable/unreadable lease
names no provable envelope and never lists, the same "unknown
stays out" rule `--priority` applies — and `inbox`, `wakes` and
the three thread sections pass the value to their own reads' id
filters (the inbox and conversations reads keep the item envelope
`id` belongs to, the wakes read the hint id — the triggering
envelope's wire id on a `bus.send` hint). `board` reports the
shared `phm bus board pending` digest whole — that projection's
own filter grammar takes no envelope citation — and `channels`/
`seats` carry no per-item envelope, so all three stay unfiltered,
like they do under `--priority`; an id nothing on the bus carries
is an honest empty match, never an error and never a widened one,
every count stays the filtered total, the result echoes `id` in
JSON and the human header prints it. `--in-reply-to <id>` narrows
the whole digest the same way — "what is pending that answers
envelope X" — under the same own-property `inReplyTo` exact match
every bus `--in-reply-to` read applies, never the `replyTo` alias
or a substring: `next`/`handoffs`/`mailbox` keep envelopes whose
body the `busBodyInReplyToMatch` rule accepts, claims keep only
message claims whose resolved leased envelope's own `inReplyTo`
equals the value — a claim naming no resolved message or no
citation never lists — and `inbox`, `wakes` and the three thread
sections pass the value to their own reads' in-reply-to filters
(the inbox read matches the envelope body, the wakes read the
resolved referent body, the conversations read any member
message's citation). Feed jobs, announced jobs, `board` rows,
`channels` and `seats` carry no retained body citation in their
projections — feed jobs project `work.post`/`work.status`/
`work.result` receipts whose strict v2 bodies keep no `inReplyTo`
field, board post bodies are `{threadId, text}` records, and seat
handoff records keep no per-record body — so those sections stay
unfiltered, like they do under `--priority`; a citation nothing on
the bus carries is an honest empty match, every count stays the
filtered total, the result echoes `inReplyTo` in JSON and the
human header prints it. `--body-kind <kind>` narrows
the whole digest the same way — "which pending items for me are
work results" or "which are handoffs" — under the same `busBodyKind`
match every bus `--body-kind` read applies, exact and
case-sensitive, a body carrying no discriminator never matching:
`next`/`handoffs`/`mailbox` keep envelopes whose body reports that
kind — claimable `work`/`task` receipts under `work`/`task`,
`worker-handoff` assignments under `worker-handoff`, kindless
legacy mail never — claims keep only message claims whose resolved
leased envelope reports it (a claim naming no resolved message
never lists), `inbox`, `wakes` and the three thread sections pass
the value to their own reads' body-kind filters (the inbox read the
envelope body, the wakes read the resolved referent's, the
conversations read any member message's), `jobs` and `announced`
keep the feed jobs citing a retained receipt of that kind — every
job cites its `work.post` announcement so `work.post` keeps them
all, `work.status` keeps jobs a status receipt has moved,
`work.result` keeps jobs a result receipt cites, and any other
kind is an honest empty match — while `board`, `channels` and
`seats` carry no per-item retained body and stay whole; a kind
nothing on the bus carries is an honest empty match, every count
stays the filtered total, the result echoes `bodyKind` in JSON and
the human header prints it. `--result <reserved|admitted|complete|failed>`
narrows the whole digest the same way — "which pending items for me
are failed result receipts" or "which announced jobs' newest report is
complete" — under the same `WORK_RESULT_OUTCOMES` vocabulary and
kind-scoped `busBodyResultOutcome` own-field match every bus `--result`
read applies, a value outside the vocabulary a usage error: `jobs` and
`announced` keep the feed jobs whose newest retained `work.result`
citation carries that outcome — the feed's own `--result` rule, a job
with no result receipt never matching — `next`/`handoffs`/`mailbox` keep
envelopes whose body is a `work.result` reporting it (claimable
`work`/`task` receipts, `worker-handoff` assignments and every other
body kind never match, so those sections are provably empty), `claims`
keep only message claims whose resolved leased envelope's body reports
it (a claim naming no resolved message never lists), `inbox` and `wakes`
pass the value to their own reads' result filters, and the three thread
sections pass it to the shared conversations read's own member-message
result filter — a thread survives when at least one member message is a
`work.result` receipt reporting that outcome, the same whole-thread
member match `agents conversations --result` applies — while `board`,
`channels` and `seats` carry no per-item result evidence the digest can
prove and stay unfiltered; an outcome nothing
on the bus reports is an honest empty match, every count stays the
filtered total, the result echoes `result` in JSON and the human header
prints it. `--thread <t>` narrows the whole digest the same way — "what
is still pending for me in thread T" — under the same kind-scoped
`busBodyThread` own-field match every bus `--thread` read applies, a
value outside the printable-label bound a usage error: `next`,
`handoffs` and `mailbox` keep envelopes whose body carries that label
inside the shared pending-work walk — claimable `work`/`task` receipts
and `worker-handoff` assignments declare no thread label, so those
sections come back honestly empty — `claims` keep only message claims
whose resolved leased envelope's body carries it (a claim naming no
resolved message, a scope-key claim or an unresolvable/unreadable lease
names no provable thread and never lists, the same "unknown stays out"
rule `--priority` applies), `inbox` and `wakes` pass the value to their
own reads' thread filters (the resolved referent's label on wakes), and
the three thread sections pass it to the shared conversations read's
`thread` filter — a thread survives on any member message whose declared
conversation bucket equals the label, the same whole-thread member
match `agents conversations --thread` applies. `jobs` and `announced`
carry no per-item thread label — the feed's citing receipts are strict
`work.post`/`work.status`/`work.result` bodies with no `thread` field —
`board` post bodies are `{threadId, text}` records whose `threadId` is
the shared board's own namespace, never a bus thread label, and
`channels`/`seats` carry no per-item thread either, so those sections
stay unfiltered; a label nothing on the bus carries is an honest empty
match, every count stays the filtered total, the result echoes `thread`
in JSON and the human header prints it. The agent defaults to
`PHM_AGENT_ID`; an unresolvable ref keeps
exact-label claim matching, reports `identity: null`, answers `unknown-agent`
for inbox rather than an empty list, and reads wakes under `scope: 'label'`
— the same literal-`to` matching `agents bus wakes` applies — so pending
hints addressed to a bare coordination label are not hidden. Every section
reports its
own read state — `missing`/`available`/`unavailable` for claims,
`ok`/`refused`/`unavailable`/`retryable`/`invalid` for the feed,
`unavailable`/`retryable`/`invalid` for the claimable-envelope walk — so one
unreadable dependency degrades only its own section. Exit 0 on a completed
read, 2 on an invalid agent ref. `fleet_agent_work` (the isolated fleet
MCP tool) serves the same `readBusWorkMineWithSeats` projection — `agent`
required, `job`/`since`/`before`/`contains`/`priority`/`channel`/`from`/`excludeFrom`/`id`/`inReplyTo`/`bodyKind`/`result`/`thread` the same
filters — under the same
validation, so an MCP-connected agent reads its whole pending digest
without shelling out to `phm`; it accepts no caller root or path and
passes a refused or degraded section through untouched.

**Pending-work claim.** `phm agents bus work next [<agent>] --lease-ms
<1..3600000> [--owner <label>] [--contains <text>] [--since
<15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--priority P0..P3] [--channel
<name>] [--topic <topic>] [--from <agent>] [--exclude-from <agent>]` is the claim half of the loop `work
mine`
opens: it takes the next claimable work envelope addressed to the agent —
the same live `kind:'work'`/protocol-`task` receipts the digest's `next`
section lists — and leases it through the same message-id claim path
`fleet bus-next`/`comms bus next` run, so the find → claim step never
leaves this surface. `--contains`, `--since`, `--before`, `--priority`,
`--channel`, `--topic`, `--from` and `--exclude-from`
narrow the
claimable set under the same rules every bus read applies — the scrubbed
one-line summary substring, the inclusive `receivedAt` cutoff, the
exclusive `receivedAt` ceiling composing with `--since` into one
`[since, before)` window, the
exact P0..P3 band, the `group:<name>:*` room prefix, the exact topic
component of a well-formed `group:<room>:<topic>` address — composing
with `--channel` into one room and one topic — and the sender
identity-label match —
so "claim the next work about X" or "claim the next
urgent one" is one atomic step rather than a filtered list followed by a
claim-by-id, a claim can never pick work newer than the window the
claimant reviewed, and `empty`'s `{candidates, held}` totals count only the
filtered scan. The bounded scan walks candidates in `bus next`
order (priority band, then cursor) and matches "addressed to it" under
the identical rule: any label of the resolved identity or a
`group:<channel>:<topic>` address of a registry channel it belongs to,
minus the identity's own channel posts; `<agent>` defaults to
`PHM_AGENT_ID`, `--owner` to `PHM_AGENT_ID` then the agent ref, and an
explicit `--owner` records the claim label independently exactly as
`fleet bus-next --to`/`--owner` do. `acquired` returns the live receipt
with its fencing `token` and `leaseUntil` for its acquirer only — the
same token `phm agents bus claim message renew|release|complete --id
<envelope-id>` spends on this surface (`phm comms bus claim` is the
legacy spelling) — while `empty` reports the observed
`{candidates, held}` scan totals so a dry well reads differently from
held work, and every other store state keeps its own status. Exit 0 on
`acquired`/`empty`, 2 on invalid arguments, 1 otherwise. The claim
coordinates scope only — holding one never permits a merge, a push, or
spending, and the claimed body is still untrusted data, never executed.

**Status.** `phm agents bus status [--json]` is a read-only probe of the fourteen
dependencies every verb above touches plus the outbound send gate every
write verb passes through: the message store (retained/live/expired
counts against its caps), the identity registry (identity and channel counts),
the wake queue (state, observed hint count before the row cap, and whether
the bounded tail or cap truncated older hints), the bus hop log every
wake-enabled send and accepted channel mirror appends
(`<root>/bus/hops.jsonl` — `state` plus on-disk `bytes`, the `hops`
count observed inside the bounded tail `fleet_bus_hops` reads,
`skippedRows` for malformed or torn rows and a `truncated` flag for hops
beyond the window; 0 counts on a verified-missing log, null when
unreadable, never message ids, agent labels or bodies), the shared
coordination table
(live claims and status rows), the message-id claim journal behind `fleet
bus-next`/`bus-claim` and the `work mine` hold state (retained claim records),
the work-feed projection (job count, or the refusal reason when the feed
is poisoned), the legacy `phm bus` mailbox store `work mine` still reads
(`source` plus a store-wide `pending` count of unacked, unexpired messages
across every recipient label — totals only, never labels; 0 on a
verified-missing store, null when unreadable), the owner-chat share
receipts ledger `inbox` consults before showing `agent-chat-owner` envelopes
(`source` plus a retained `receipts` row count; an unreadable ledger makes
those reads report unavailable, so the probe names it directly — 0 on a
verified-missing ledger, null when unreadable), the shared task board
with its fleet queue that `work mine`'s board section and `phm bus board`
read (`source` plus stored `threads`, `tasks` and `pendingDeliveries`
counts — deliveries no receipt acknowledges — and a `claims` flag for the
queue claim index's readability, which `work mine` reports as `unknown`
holds when unreadable; 0 counts on a verified-missing board, null when
unreadable), the bot-seat store `work mine`'s seats section, `id list`'s
seat participants, the unified inbox seats source read and the
`bots handoff(s) --apply` notice receipts (`source` plus retained
`seats` roster-row, `states` seat-state-entry, `handoffs`
journaled-record and `notices` receipt-map-entry counts under
`<home>/.phantom/bots` — the files `planSeatHandoffs` and
`applySeatHandoff` read and rewrite, so a corrupt roster, journal or
receipts file is named here instead of leaving status green while those
reads report unavailable; 0 counts on a verified-missing store, null for
a file that cannot be read or validated, never a plan verdict, seat
contents or quota evidence), the
agentnet peer work-dispatch journal `phm agentnet peers dispatch` consumes
and the unified inbox peer-dispatch source lists (`<busRoot>/agentnet/
work-dispatch.json` under the same root `consumePeerWork` resolves —
`realHome()/.ashlr/fleet` by default — `source` plus retained `receipts`
and `unpublished` counts, where unpublished applies the consumer's own
`sent !== outcome` rule; 0 counts on a verified-missing journal, null when
unreadable, never peer names, claim keys or bodies), the agentnet peer
coordination ledger `phm agentnet peers send|post|read|dispatch` admits,
dedupes and rate-limits against and `phm fleet peer-ledger` summarizes
(`<busRoot>/agentnet/coordination.json` under the same root the peer verbs
resolve — `realHome()/.ashlr/fleet` by default — read by the same
`readPeerLedger` those surfaces use; `source` plus a `liveRows` count of
unexpired coordination rows the send budget still counts; 0 on a
verified-missing ledger, null when unreadable, never peer names, claim
keys, digests, threads or bodies), the session-handoff journal store
`<runsRoot>/handoffs` that `phm checkpoint handoff list|show` and
`fleet_session_handoffs` read through the same `listSessionHandoffs`
bounded scan under the same runs root the wake probe resolves
(`ASHLR_RUNS_DIR` or `~/.ashlr-runs` by default — `source` plus `journals`
scanned, `open` journals whose latest signal is not `completed`,
`awaitingFailover` open journals whose signal requests failover under the
`handoffPressure` rule, `unreadable` journals that failed `show`'s
validation and a `truncated` flag for journals beyond the scan cap; 0
counts on a verified-missing store, null when unreadable, never job ids,
lanes, models or signal payloads), plus the
claim-store drift verdict the claim journal and the
coordination table imply — the same `fleet.claim-drift.v1` read
`ashlr fleet claim-drift` serves, run over the probe's own two reads so the
verdict describes the same snapshots: `claimDrift.state` is VERIFIED when
every live message claim has its coordination partner under the same owner,
DRIFT with `matched` plus per-kind `busOnly`/`coordOnly`/`ownerMismatch`
counts naming the disagreeing rows, or UNKNOWN with every count null when a
side cannot be read — never zero), plus the outbound send gate every write
verb passes through — the kill-switch sentinel and the comms soft-pause
flag `localWriteGate` consults before `dm`, `post`, `channel post`,
`handoff`, `wake` and the work verbs append. Its `sendGate` section reports
`state` open, blocked or unknown with the kill-switch sentinel's
`readKillSwitch` verdict (active, inactive or unknown) and the comms pause
file's `probePauseState` verdict (paused, clear or unknown, with the
recorded `since` when the flag carries one) kept separately under
`realHome()` — the same paths the send path resolves, never the probe's
`root` override. Open means neither gate blocks, blocked means at least
one provably refuses, and unknown means a source could not be inspected —
the send path still fails closed on both, so unknown is never open. Each
section reports its own real
state — a store that cannot be read reports `unavailable` with null counts,
never zero, and the probe never throws, writes or takes a lock. Use it before a
session assumes the bus is healthy. `fleet_bus_status` (the isolated fleet
MCP tool) serves the same probe with no arguments — every store root stays
server-owned — so an MCP-connected agent reads the same per-section states
and the `sendGate` verdict without shelling out to `phm`.

**CLI adapters.** `src/core/agents/bus-cli-adapters.ts` covers `claude`,
`codex`, `devin`, `cursor` and `grok`. Each one detects its CLI (explicit
`PHM_AGENT_CLI`, else the runtime markers already used by team approvals, such
as `CLAUDECODE` or `CODEX_SANDBOX`), maps it to a v2 provider, and records the
session as a runtime of the `PHM_AGENT_ID` identity. Codex, Devin and Grok name
their existing engine runner in `src/core/fleet/bus-adapters/`; Claude Code and
Cursor read their inbox in the live session on wake. Adapters never spawn a
CLI. `phm agents bus adapters --json` prints the table.

### Migration from existing bus directories

Nothing is moved or rewritten. Each existing directory keeps its role:

| Directory | Role after unification | Action |
| --- | --- | --- |
| `$ASHLR_HOME/fleet/bus-inbox/` | The one bus store | None |
| `$ASHLR_HOME/fleet/agent-identities/` | New: identity and channel registry | Created on first `id register` |
| `$ASHLR_HOME/fleet/bus-transport/acks.json` | Ack ledger for the file-bus transport | Created on first transport `ack` |
| `~/.ashlr-runs/bus/wake-queue.jsonl` | Wake hints, same row shape | None |
| `$ASHLR_HOME/fleet/bus/hops.jsonl` | Hop log for wakes | None |
| `$ASHLR_HOME/bus-mailbox/` (`phm bus send\|inbox\|ack`) | Per-recipient mailbox with acks, kept for its current users | Do not copy; see below |
| `~/.ashlr/agentnet/bindings.json` | Slack peer session bindings | None; a callsign is a valid handle |

To move an agent onto the unified bus:

1. Register its identity once per agent: `phm agents bus id register <handle>`,
   adding `--alias <label>` for every label senders already use (its lane name,
   v2 `participantId`, `phm bus` mailbox label). Its inbox then includes old
   traffic without rewriting history.
2. Set `PHM_AGENT_ID=<handle>` (and `PHM_AGENT_CLI` where no runtime marker
   exists, as for Devin) in the launcher, and run `phm agents bus id register`
   from the session to record the runtime.
3. Turn existing `group:<room>:<topic>` rooms into channels by creating a
   channel with the room's name; posts to any topic of that room reach its members.
4. Drain a `phm bus` mailbox with `phm bus inbox --to <label>` and
   `phm bus ack`, then send new traffic with `phm agents bus dm`. The inbox
   read takes the same filter grammar every other bus read shares —
   `--from`/`--exclude-from` through the identity registry, `--priority`,
   `--job`, `--channel`, `--since`/`--before`, `--contains`, `--in-reply-to`,
   `--thread`, `--id`, `--body-kind` and `--result` — so a large leftover
   mailbox filters to one job's, one sender's or one outcome's mail instead
   of paging raw. `--result` keeps only `work.result` bodies reporting that
   outcome, the same `WORK_RESULT_OUTCOMES` vocabulary and
   `busBodyResultOutcome` own-field match every other bus read's `--result`
   applies. `work
   mine`'s `mailbox` section lists the pending rows for every label of the
   agent's identity (or the literal ref when none resolves) with the `--to`
   each row needs, so leftover mail is discoverable without knowing which
   label holds it; `phm comms inbox`'s `mailbox` source lists every pending
   message across ALL recipient labels fleet-wide — the same store, read
   through `BusMailbox.pendingAll`, never copied or acknowledged by the
   projection. Copying
   mailbox records into the store is not supported: it would duplicate ids and
   lose acknowledgment state.

## Transports and routing

`src/core/fleet/bus-transport.ts` puts every carrier of agent-to-agent traffic
behind one interface, so the local CLI lanes and external agent services are
pluggable transports on this bus rather than separate paths. It is a library:
no daemon or CLI command runs it yet, and it ships no external transport.

**Transport.** A `BusTransport` has `id`, `boundary` (`local` or `external`)
and four calls: `send(envelope)`, `poll(since)`, `ack(id)` and `health()`
(`up`, `degraded` or `down`). The transport envelope has `id`, `from`, `to`,
`kind` (a protocol v1 kind: `task`, `result`, `review`, `status`,
`question`), `priority` (`P0`-`P3`), `body` (opaque untrusted JSON),
`correlationId` and `ttlMs`. On the wire it is an ordinary six-field bus
envelope whose body is `{ protocol: { version: 1, kind }, correlation_id,
payload }`, so it passes the same validation and size cap as any other post.

**File-bus transport.** `createFileBusTransport({ addresses })` in
`bus-transport-file.ts` sends with `appendBusInbox` and polls cursor pages
from the same store; it adds no second message store. `addresses` are the
labels that consumer reads (exact, `*`, or a `prefix*`). Poll returns only
transport-shaped envelopes for those labels that the consumer has not acked.
Acks live in `bus-transport/acks.json` (0600, writer lock, atomic replace),
pruned on each ack to messages the store still keeps alive, so the ledger
never outgrows the store and an id reused after reclaim is not pre-acked.
Health is `down` when the store or ledger is unreadable and `degraded` at 90%
of the store's capacity.

**External adapter shape.** `createExternalAgentTransport({ id, client })` in
`bus-transport-external.ts` wraps a host-supplied `ExternalAgentClient` (the
remote service's own API) as an `external` transport. Each call is bounded by a
timeout that aborts the client's signal. Inbound envelopes are revalidated and
invalid ones dropped. Client error text never reaches a report; a client marks
a failure permanent by throwing `ExternalTransportError(false)`. Tests use a
fake client only.

**Routing.** `createBusRouter({ routes, deadLetter })` takes routes of
`{ transport, roles, priority }`. An agent addresses a role in `to`; the router
probes the health of every transport serving that role (a throw or timeout is
`down`), drops `down` ones, and tries the rest in order: `up` before
`degraded`, then lower `priority`, then registration order. A retryable
failure fails over to the next live transport in the same attempt; a permanent
refusal removes that transport for this message. Between attempts it waits
`base * factor^(attempt-1)` capped at `maxMs` (default 500 ms, x2, 30 s) and
resends with the TTL reduced by elapsed time. Success returns a delivery
receipt: transport id, the transport's own receipt, `duplicate`, and the
attempt log.

**Dead letters.** After `maxAttempts` (default 5) the message is dead-lettered
with reason `exhausted`; `expired` when its TTL runs out first; `no-route` when
no transport serves the role. `createFileDeadLetterSink()` records a `status`
envelope addressed to `bus.dead-letter` in the same store, holding the
original envelope (or only its routing metadata when it would not fit) and the
attempt log; read it with a file transport whose addresses include
`bus.dead-letter`, or with `phm comms bus read --to bus.dead-letter`. The
unified comms inbox (`phm comms inbox`, kind `bus-dead-letter`) lists each
live letter as pending attention — the mail provably never arrived — naming
the reason, attempt count and original routing metadata the letter kept. The
report says `recorded: false` if the sink failed, in
which case the caller still holds the message.

**Egress is off by default.** Outbound to any human or external service needs
an explicit owner decision, enforced twice:

- the router never selects an `external` transport, or probes its health,
  unless it was built with `egress: { ownerApproved: true }` (strictly `true`);
  when only external transports serve a role it returns `held` and nothing is
  sent or stored;
- the external adapter refuses `send`, `poll` and `ack`, and reports `down`,
  without contacting the service unless it was built with the same flag.

The router's `hold` defaults to `localBusHold`: the kill switch and
communications pause that every local bus write already honours. Either one
returns `held` before any transport is touched. The file transport and file
dead-letter sink check the same gate for callers that bypass the router.

## Desktop app

The Bus pane in the desktop app includes a Durable bus tab that reads and
writes the same `~/.ashlr-runs` store the API endpoints target.
The Messages pane shows the same `agent-messages.v1` read as a timeline
grouped by conversation, with an agent filter; clicking a message with a job
opens that job's log. The Org pane draws one line per conversation between
two agents in the last 15 minutes.

## v2

v2 is the contract every provider implements against: Grok Bot agents, OpenAI
Dot, codex-cmp, codex-personal, Devin, Cursor cloud agents, Claude, GLM (z.ai),
Stacksync's agent and local oMLX. It adds meaning to `body`; the six envelope
fields, endpoints, auth and caps above are unchanged, and v1 bodies stay valid.
A body is v2 only when it carries one of the `kind` values below. Schema
version: `agent-bus.v2`. Source of truth: `src/core/agents/bus-v2-schema.ts`.
Supersedes the stale proposals in PR #3057 (RQ-BUS-NEUTRAL-1) and PR #1135
(RQ-BUS-GROKBOT-R); their note/refs/thread ideas are kept below.

Print it: `ashlr agents bus contract --json` (read-only, no bus access).

### 1. Participants

```json
{"participantId":"dot-main","provider":"openai-dot","displayName":"OpenAI Dot",
 "capabilities":["review","code"],"wake":{"kind":"poll","target":"dot-poll"},"status":"active"}
```

- `provider`: `grokbot`, `openai-dot`, `codex-cmp`, `codex-personal`, `devin`,
  `cursor-cloud`, `claude`, `glm`, `stacksync`, `local`.
- `participantId` is a routing label (printable ASCII, 1-128), the same kind
  of label as `from` and `to`. It is not an authenticated identity.
- `wake.kind` is `poll`, `webhook` or `email`. `wake.target` is a label such as
  `dot-poll`: letters, digits, `. _ : -` only. Never a URL, address with
  credentials, or secret; long opaque strings are rejected.
- `status`: `active`, `idle`, `offline`, `disabled`.

### 2. Body kinds

#### Flat mesh observations

`phm agents mesh status --json` reads the identity registry and retained presence
observations without probing apps or writing state. Each row includes a directly
addressable `agent:<handle>`, lane, last-seen time, current task and source.
Unknown providers and unobserved timestamps are `null`. These are observations,
never authentication or execution authority.

The live console publishes local observations once a minute:
desktop roster-hook windows, CLI job claims, and iMessage teammate loop/task
metadata. No message bodies, contact handles, credentials or result tokens are published.
Existing v2 `context` bodies carry JSON observation text on `fleet.mesh`; no new
bus kind or provider is introduced. Observations expire from the bus after ten
minutes and become unknown after two minutes without a refresh. Registered agents
remain visible when observations expire. A healthy source clears departed tasks;
an unavailable source reports unknown. iMessage last-seen means a peer result,
not a successful local poll. Desktop last-seen means a visible window observation.
One row represents each claim owner (aggregating concurrent claims) or desktop
session (keyed by the hook's app/window-title pair). Desktop collection has a five-second deadline; a stalled
desktop source does not prevent CLI or teammate observations.

`phm agentnet peers mesh --json` and `phm agentnet peers work-feed --json` expose
these shared projections to every enrolled, authenticated peer, independent of
lane or role. `peers work-feed` accepts the same filter set every other
work-feed surface serves — `--claims`, `--open`, `--claimable`, `--status`,
`--job`, `--repo`, `--provider`, `--tier`, `--to`, `--owner`, `--channel`,
`--result`, `--id`, `--since`, `--before`, `--contains` and `--limit` —
validated through the shared `parseBusWorkFeedQuery` contract, so a remote
peer's filtered feed reads exactly what `phm fleet work-feed` would; `peers
mesh` stays unfiltered and every other verb refuses the feed flags. Private
inboxes keep their recipient checks. Routine local DMs use
`phm agents bus dm --to <handle> --text <text>`; transport and send gates still apply.
Repeatable `--ref <ref>` on `dm`, `post` and `channel post` records v2 `refs` on the
`note` body; `--thread <label>` records the v2 `thread` conversation label —
the field that ties a question and its answer together — on `dm`, `post`,
`channel post`, and (as a read filter) `inbox` and `channel read`, plus
`comms bus read`/`watch`. A thread read matches that field on `note`/`context` bodies
only; every other body kind never matches. `--reply-to <id>` on `dm`, `post`
and `channel post` records the v2 `inReplyTo` citation — the envelope id the
message answers — the same field `postBusReply`, `comms bus post --reply-to`
and the fleet reply verbs stamp; `agents conversations` threads on it,
`inbox --in-reply-to` and `channel read --in-reply-to` filter on it, and the
`work mine` handoff/awaiting sections credit a routed recipient -> sender
citation as the answer — resolved through the identity registry, so any
label of the two identities (or a member of the addressed channel) counts —
so an agent can close an ask or assignment without
dropping to the fleet reply verbs. The citation names a routing id, never
proof the target existed or was received. `--kind context` on `dm`, `post`
and `channel post` posts the v2 `context` body — reference material rather
than a conversational `note` — instead of the default; every conversational
send accepts the same `note`/`context` choice.

`body.kind` is one of:

| kind | fields |
| --- | --- |
| `note` | `text`, optional `thread`, `refs`, `inReplyTo` |
| `context` | `text`, optional `thread`, `refs`, `inReplyTo` |
| `work.post` | `jobId`, `title`, `repo`, `claimKeys[]`, optional `provider`, `dispatch: {tier, scope, acceptance}` |
| `work.claim` | `op: acquire` with `claimKey`, `owner`, `leaseMs`; or `op: renew` with `claimKey`, `token`, `leaseMs` |
| `work.status` | `jobId`, `status`, optional `detail` |
| `work.result` | `jobId`, `claimKey`, `queueId`, `receiptId`, `outcome: reserved\|admitted\|complete\|failed`, optional bounded `reason` code |
| `work.release` | `claimKey`, `token`, `outcome: released\|completed` |
| `wake` | `target`, `reason`, optional `jobId` |

`work.status` values: `queued`, `running`, `idle`, `rescheduled`, `blocked`,
`done`, `failed`, `terminated`. Text is capped at 16384 characters, `refs` at
32 short references (for example `pr:123`). Bodies are untrusted data.

### 3. Claim protocol

A claim key names one resource:

- `repo:<owner/name>`
- `path:<owner/name>:<glob>` (relative glob, no `..`, no leading `/`)
- `queue:<queue id>`
- `pr:<owner/name>#<n>`

A claim is `{claimKey, owner, leaseMs, token, leaseUntil}`: `owner` is a
`participantId`, `leaseMs` is 1 to 3600000, `token` is 64 lowercase hex chars
issued on acquire, `leaseUntil` is epoch milliseconds.

- Acquire fails with 409 and the holder (`{v:2, status:"conflict", holder:{owner,
  claimKey, leaseUntil}}`, never the token) if any live claim overlaps.
- Overlap: a repo claim overlaps any path claim in the same repo; two path
  claims in one repo overlap when some path matches both globs (exact glob
  intersection under `globMatches` semantics — `*` and `?` stay inside one
  path segment, `**` crosses segments); queue keys overlap on equal id; PR
  keys on equal repo and number. Repo names compare case-insensitively.
  Other pairs never overlap.
- Renew before `leaseUntil`. An expired claim is free: live means `now <
  leaseUntil`.
- Only the token holder may renew, release or complete.
- Claims coordinate; they grant no execution authority. Holding one never
  permits a merge, a push, or spending.

`POST /api/verse/agent-bus` executes these bodies: `work.claim` acquire and
renew, and `work.release` (outcome `released` or `completed`). The response is
the v2 result — `201` acquired, `200` renewed/released/completed, `409`
conflict (with `holder`, never the token) or `mismatched-token`/`expired`,
`404` lost, `400` invalid, `507` full, `503` unavailable. Claim operations do
not append to the inbox; the coordination table row keyed by the envelope id
(`sourceId` `agentbus:<id>:<key-hash>`) is the record, so a retried acquire on
the same key replaces its own lease. That row is bound to its owner: the same
operation id presented by a different owner conflicts with the live holder
instead of replacing the lease and killing its fencing token. Renew `leaseMs` is the new lease length
from now and may not exceed the acquired length. `phm agents bus claim
acquire|renew|release` runs the same core path locally with `--key`,
`--lease-ms`, `--owner` (defaults to `PHM_AGENT_ID`), `--token`, `--outcome`
and optional `--id`; exit 0 on success, 2 on invalid arguments, 1 otherwise.
`phm agents bus claim list [--key <claimKey>] [--owner <label>] [--exclude-owner <label>] [--origin <resource|message|team|board>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--jobs]` is
the read
side: it prints the live coordination claims (owner, origin, lease end, source
id — never tokens) across every origin, narrowed by `--key` to those that
would block an acquire through the same overlap rule, by `--owner` to one
holder — a handle, `agent:<handle>`, stable id or alias resolved through the
identity registry, falling back to the exact owner label when the ref does
not resolve or the registry is unreadable (the JSON `owner` field reports the
`ref`, resolved `identity` or null, and `registry` state) — by
`--exclude-owner` to every holder but one under the same identity-label
rule, inverted (the JSON `excludeOwner` field reports the same resolution,
so "what do the other seats hold" is one read) — by `--contains` to claims
whose `key`, `sourceId` or `repo`/`branch`/`path` target fields carry the
needle as a case-insensitive substring, the same `--contains` rule every
bus read shares — by `--since`/`--before` to claims whose recorded `started`
— the lease's ISO acquisition time, stable across renewals — lands inside
the `[since, before)` window: `since` keeps starts at or after the cutoff
and `before` keeps starts strictly before it, the same inclusive/exclusive
bounds and 15m/2h/1d/epoch-ms/ISO grammar every bus read's time filters
apply and the same field `work mine`'s claims section already bounds, so
"which claims started lately" or "what was held before time T" is one
filtered read of the claim table itself — a claim whose origin keeps no
start stamp (team, message and board claims and pre-stamp resource rows
keep `started` null) is unknown and never matches, the same "unknown stays
out" rule every other section's missing timestamp follows — or by `--origin`
to one claim class (`resource` work leases, `message` message-id claims,
`team` leases, `board` claims; queue path observations are never live and
never list). A missing table
reads as a verified-empty list; an unreadable one stays `unavailable`, never
zero. With `--jobs` each claim also names the announced work-feed jobs its
keys block (`{id, owner, status, title, detail?, postId, statusId}` — the
reverse of `work feed --claims`, with the same retained receipt citations
so a blocked job names its `agents bus show` handles),
and the JSON `feed` field reports the feed read state; a non-`ok` feed leaves
`jobs` absent so blocked work stays unknown, never an empty list.
`fleet_bus_claims` (the isolated fleet MCP tool) serves the same
`listBusClaims` read with `key`, `owner`, `excludeOwner`, `contains`,
`origin`, `since`, `before` and `jobs` as its only
arguments — the same `parseClaimKey` grammar, printable-label owner bound,
shared `--contains` bound, `COORDINATION_ORIGINS` class filter, shared
`--since`/`--before` grammar resolved through `parseSince` onto the claim's
recorded `started` and feed join
the CLI flags share, under
the identical validation — so an MCP-connected agent reads the claim table's
own projection without shelling out. Every coordination and feed root stays
server-owned, `source` keeps `missing` verified-empty and `unavailable` an
unreadable table (never an invented empty list), and the tool never acquires,
renews, releases or completes a claim.

Example (replace `FAKE-TOKEN`):
`curl -X POST -H "Authorization: Bearer FAKE-TOKEN" -H "Content-Type: application/json" http://localhost:8787/api/verse/agent-bus -d '{"id":"claim-0001","from":"dot-main","to":"leaders","priority":"P2","ttl":3600000,"body":{"kind":"work.claim","op":"acquire","claimKey":"path:ashlrai/phantom:docs/**","owner":"dot-main","leaseMs":600000}}'`

The v1 message-id claim (`ashlr fleet bus-claim acquire|renew|release|complete
--id --owner --lease-ms`, or `phm comms bus claim …`; on the unified surface
`phm agents bus work next` claims the next one and `phm agents bus claim
message acquire|renew|release|complete --id <envelope-id>` drives the whole
lifecycle for one named receipt — `acquire` takes `--lease-ms` and an
`--owner` defaulting to `PHM_AGENT_ID`, the other verbs take `--token`, and
the result echoes the id with exit 0 on acquired/renewed/released/completed,
2 on invalid, 1 otherwise) keeps working for
single-message work. Resource claims
are the v2 layer above it. `bus next`/`bus-next --to` — and `agents bus
work next [<agent>]`, which defaults the address to the agent itself —
matches work addressed to
one agent identity under every routing label that resolves to it — handle,
`agent:` address, stable id or alias — or to a `group:<channel>:<topic>`
address of a registry channel the identity belongs to, minus the identity's
own channel posts: the same membership rule the inbox, wake and `work mine`
reads apply, through the same identity registry the message filters use; a
`--to` naming no identity, membership in no channel, or an unreadable registry
keeps exact-label matching and never widens. All four claim surfaces —
`agents bus work next`, `fleet bus-next`, `fleet bus-wait-claim` and
`comms bus next` — take the same `--contains <text>`, `--since
<15m|2h|1d|ISO>`, `--before <15m|2h|1d|ISO>`, `--priority <P0|P1|P2|P3>`,
`--channel <name>`, `--topic <topic>`, `--from <agent>` and `--exclude-from <agent>`
read filters, applied inside
the claim scan under the identical rules the reads use (the scrubbed
one-line summary substring, the inclusive `receivedAt` cutoff, the
exclusive `receivedAt` ceiling composing with `--since` into one
`[since, before)` window, the exact
priority band, the `group:<name>:*` room prefix and the exact topic
component of a well-formed `group:<room>:<topic>` address — each decided
on the raw `to` label under the channel-name grammar, so `--channel` and
`--topic` compose into one room and one topic while a bare `group:<room>`,
a deeper label or a non-group address never resolves a topic — and the
sender identity-label match `agentRefAddressMatcher`
shares — a sender ref resolving through the registry matches every label
of that identity while an unresolvable ref or unreadable registry keeps
exact-label matching, so unknown identity state never widens a claim),
so the claimable set is exactly what the matching read
would list and a filtered claim can never pick work the read would hide —
including work newer than the window it reviewed.
When nothing is acquirable the
result is `{status:'empty', candidates, held}` rather than a bare `empty`:
`candidates` counts every live claimable receipt the bounded scan found
addressed to `--to` and matching the request's filters, and `held` counts
how many answered `conflict` — a live
claim on the message id or an overlapping coordination key, possibly the
requester's own prior claim — so `empty` distinguishes a dry well
(`candidates: 0`) from work that exists but is held without a second
`work mine` read. `candidates - held` failed acquire for other reasons
(completed, expired, lost, missing, or a receipt that changed mid-claim);
expired receipts never reach the scan, so they are never candidates.
`fleet bus-request` and `fleet bus-scatter` correlate replies the same way: a
reply counts when its `from` resolves to the request's `to` identity, its
`to` resolves to the request's `from` identity under any of their labels, and
its body cites the request id through an `inReplyTo` or `replyTo` field — the
same citations `busReplyCitations`, `workerHandoffAnswered`, the conversation
projection and the pending-work sections credit, so a peer answering under
either spelling completes the roundtrip while correlation stays untrusted
routing data; a label that resolves to no identity, and an unreadable
registry, keep exact-label matching. `fleet bus-follow --to` resolves its stream filter the
same way, once when the stream starts: mail addressed under any label of the
named identity — or to a `group:<channel>:<topic>` address of a channel it
belongs to, minus the identity's own channel posts — streams, and an
unresolvable `--to` or an unreadable registry keeps exact-label matching. `phm comms bus read|watch` resolves its `--to`,
`--from` and `--exclude-from` address filters the same way, once per read:
a filter naming any label of a registered identity matches every label of
that identity, and an unresolvable label or an unreadable registry keeps
exact-label matching. `--job <id>` narrows `comms bus read|watch` and
`fleet bus-follow` to envelopes naming one job — a
`work.post`/`work.status`/`work.result`/`wake` body declaring that `jobId`,
a `worker-handoff` assigning that fleet job id through `taskId`, or a
`note`/`context` body carrying the `job:<id>` thread label — the same
`busBodyJobMatch` rule `agents bus inbox --job` and `channel read --job`
apply, so a raw label read (the `leaders` sink that work announcements
default to included) answers one job's traffic without paging the whole
stream. On `bus-follow` only citing envelopes emit message records while
checkpoints still advance past the rest, so a job-scoped stream resumes on
the same cursor an unfiltered one would. `fleet bus-follow` also narrows on
the fields the inbox reads filter by: `--from` keeps envelopes sent under any
registered spelling of one identity — the same `agentRefAddressMatcher` rule
`agents bus inbox --from` applies, resolved once at stream start, with an
unresolvable sender or unreadable registry keeping exact-label matching —
`--exclude-from` drops envelopes sent under any registered spelling of one
identity — the same sender-exclusion rule `comms bus read|watch`'s
`--exclude-from` and `fleet_bus_inbox`'s `excludeFrom` apply —
`--priority` keeps one `P0`–`P3`, `--thread` keeps `note`/`context` bodies
carrying that thread label, `--since <15m|2h|1d|ISO>` keeps rows received
at or after the cutoff, and `--before <15m|2h|1d|ISO>` keeps rows received
strictly before it — the exclusive upper bound composing with `--since`
into one `[since, before)` window. The stream also narrows on the remaining fields the
bus page reads share: `--id` keeps only the envelope carrying that exact id,
`--in-reply-to` keeps only object bodies whose own `inReplyTo` equals it —
the same application convention `comms bus read|watch` and `fleet_bus_inbox`
apply — `--kind`/`--topic` keep only protocol-v1 bodies whose
`protocol.kind`/`protocol.topic` match, `topic` accepting an exact name or a
namespace prefix like `fleet.*`, and `--body-kind <kind>` keeps only
envelopes whose body carries that exact kind discriminator — the same
`busBodyKind` own-field match `agents bus inbox --body-kind`, `channel
read --body-kind`, `wakes --body-kind`, `agents conversations --body-kind`
and `phm messages --body-kind` apply:
the v2 `kind` field, else a bus-transport v1 `protocol.kind`, else the
`type`/`schema` a kindless notice keys on, exact and case-sensitive, a
body carrying no discriminator never matching and an unrecognized but
printable value an honest empty stream. `--result
<reserved|admitted|complete|failed>` keeps only `work.result` bodies whose
own `outcome` strictly equals the code — the same `busBodyResultOutcome`
own-field match and `WORK_RESULT_OUTCOMES` vocabulary `phm messages
--result`, `agents messages --result`, `fleet messages`, `bus recent`,
`fleet_agent_messages`'s `result` and the work feed's `--result` share —
so the envelope-level audit trail a job-scoped follow already narrows by
`--job` answers "stream only this job's failed result receipts" in one
filtered read; every other body kind, including a `work.release` body's
own `released`/`completed` outcome, and a `work.result` carrying no
outcome never match, and a value outside the vocabulary is an invalid
request, never a widened stream. `--body-kind <kind>` and `--result
<reserved|admitted|complete|failed>` narrow `comms bus read|watch` by the
same two own-field body matches — `busBodyKind`'s exact discriminator and
the kind-scoped `busBodyResultOutcome` outcome equality — so the raw page
answers "which retained envelopes are `work.result` receipts reporting
`failed`" in one filtered read, with a `comms bus --checkpoint` consumer
binding both raw values into its filter identity the same way every other
filter binds. As with `--to` and `--job`, filtered rows
still advance checkpoints, so a narrowed stream resumes on the same cursor
an unfiltered one would. `--since <15m|2h|1d|ISO>` narrows
`comms bus read|watch` to rows received at or after the cutoff — the same
inclusive `receivedAt >= since` match `agents bus inbox --since`,
`channel read --since`, `wakes --since` and `phm messages --since` apply,
resolved once when the read starts; a `--checkpoint` consumer binds the raw
`--since` value into its filter identity, so a relative window keeps
resuming while an absolute change fails closed. `--before <15m|2h|1d|ISO>`
narrows `comms bus read|watch` and `fleet_bus_inbox`'s `before` to rows
received strictly before the cutoff — the exclusive `receivedAt < before`
match `fleet bus-follow --before` applies, on the same `parseSince`
grammar, resolved once when the read starts and composing with
`--since`/`since` into one `[since, before)` window where a row stamped
exactly at either bound never matches; a `comms bus --checkpoint` consumer
binds the raw `--before` value into its filter identity the same way.
`--channel <name>` narrows
`comms bus read|watch`, `fleet bus-follow` and `fleet_bus_inbox`'s `channel`
to envelopes addressed to `group:<name>:*` — the room's whole traffic under
every topic, the same raw `to`-prefix rule `channel read`, `wakes --channel`,
`phm messages --channel` and the work feed's `--channel` apply (the addressed
`agents bus inbox --channel` resolves the same prefix only across channels
the agent belongs to),
decided on the `to` label with no registry dependence so unknown channel
state never widens a read; the value takes the strict channel-name grammar,
the filter composes conjunctively with every other read filter, filtered
rows still advance `bus-follow` checkpoints and `comms bus` page cursors
exactly like every other filter, and a `comms bus --checkpoint` consumer
binds the `--channel` value into its filter identity, so a room change
fails closed. `--contains <text>`
narrows `comms bus read|watch` and `fleet bus-follow` to envelopes whose
scrubbed one-line summary carries the needle — the same
`busReadContainsMatch` rule `agents bus inbox --contains`,
`channel read --contains`, `phm messages --contains` and the other bus
reads apply: a case-insensitive substring with whitespace collapsed on
both sides, matched over the rendered summary and never the raw body, so
a secret-shaped value stays unfindable and protocol-v1 payloads stay
opaque to it. The value is bounded free text, up to 512 characters. On
`bus-follow` filtered rows still advance checkpoints exactly like every
other filter, and a `comms bus --checkpoint` consumer binds the raw
`--contains` spelling into its filter identity, so a changed needle fails
closed.

### 4. Work feed

Every job is `{id, owner, to, provider, repo, title, dispatch?, claimKeys[],
status, detail?, updatedAt}` — `title` and the optional `dispatch` spec carry
through from the `work.post` so the feed names the work it lists, and
`detail?` carries the newest accepted `work.status` body's own `detail` text
(why the job sits in its current state — a status that omits `detail` clears
it, so a stale reason never rides a newer state) — and the feed is
`{v:2, jobs:[...]}`. `projectBusWorkFeed` in
`src/core/agents/bus-work-feed.ts` projects a retained receipt snapshot without
I/O. Posts start queued; `owner` is the sender label and `to` is the routing
label the `work.post` announcement was addressed to (the `leaders` sink by
default). Provider comes from the
post, explicit participant metadata, or — in the read layer — the sender
identity's newest registered runtime; absent provider refuses the projection.
Statuses from that owner update retained jobs in cursor order with receipt time
as `updatedAt`; when the read layer supplies `ownerKeyFor`, any sender label
resolving to the job owner's key counts as that owner, while labels it cannot
resolve still require exact label equality. Orphan statuses are ignored.
Duplicate posts and malformed work bodies are refused. A body-level refusal
carries `receipt` — the wire id, receipt time and TTL of the retained envelope
whose processing refused the projection — so a poisoned feed names its cause
(`agents bus show <id>` resolves it) instead of silently hiding every job
until the receipt expires; receipt-shape, participant-metadata and volume
refusals name none. Legacy and unrelated bodies stay opaque. This projection
is neither a historical ledger nor an authentication check; labels grant no
authority.

`phm fleet work-feed --json`, `phm agents bus work feed`, `fleet_work_feed`
(the isolated fleet MCP tool) and GET
`/api/verse/agent-bus/work-feed` serve the same `BusWorkFeedReadResult` as
`{v:1, status, jobs?, receipts, asOf}`; the two CLIs share one status filter,
one announcement-address filter, newest-first order, hold regrouping and
human rendering — each job line names the announcement's title, the newest
status detail when the job carries one, the declared dispatch spec
(`tier=… scope="…" acceptance="…"`) when the post carried one, claim keys and,
on claim-annotated open jobs, `claimable=yes|no|unknown`,
scrubbed, single-lined and display-clipped while JSON keeps the full values.
Every surface can page the filtered view: `--limit` on the two CLIs and
`limit` on the endpoint take an integer in 1–200 (`BUS_WORK_FEED_LIMIT_MAX`)
and run the shared `sliceBusWorkFeedView`, which keeps the newest jobs,
reports `matched` as the true filtered total before the cap and `omitted`
as the rest — the human footer prints `matched=N omitted=M` — and regroups
claims holds under the shown jobs only; without a limit parameter the whole
filtered view answers exactly as before, and `fleet_work_feed` keeps its own
default of 50.
`--to <label>` keeps only jobs whose post was addressed to
that agent — the literal routing label, every label of one agent identity,
and `group:<channel>:<topic>` addresses of registry channels the identity
belongs to, minus channel posts the identity sent itself, the same
addressed-to-agent rule `bus next`, `bus-follow`, handoff receive, the
`work mine` digest and `agents bus inbox` apply; an unresolvable `--to` or
an unreadable registry keeps exact-label matching — the filter narrows the
fleet view, it never widens it. `--owner` keeps jobs announced by that agent
under every label of one agent identity. `--channel <name>` keeps only jobs
whose post was addressed to `group:<name>:*` — the room's whole traffic
under every topic, the same raw address prefix `inbox --channel`,
`channel read` and `phm messages --channel` match, validated by the strict
channel-name grammar with no registry dependence. The
endpoint needs a current read session and accepts `claims=true` plus the
same filter parameters the feed CLIs take — `status`, `job`, `repo`,
`provider`, `tier`, `to`, `owner`, `since`, `before`, `contains`, `channel`,
`result`, `id`, `open`, `claimable` and `limit` — each a single value validated by the shared
`parseBusWorkFeedQuery` rules (`src/core/agents/bus-work-feed-query.ts`) and
applied through the same `projectBusWorkFeedView` the CLIs use, so an HTTP
client gets the identical narrowed, newest-first view: `open`/`claimable`
imply the claims join like the CLI flags, `to`/`owner` resolve through the
server-side identity registry with exact-label fallback, `limit` pages the
view through `sliceBusWorkFeedView` reporting `matched`/`omitted`, and
repeated,
unknown or malformed parameters or values are a 400. `fleet_work_feed`
takes the same dimensions as MCP arguments — the three hold joins as JSON
booleans, every other filter as the string the shared parser validates —
under the identical `parseBusWorkFeedQuery`/`projectBusWorkFeedView`
contract, adds a `limit` slice (1–200, default 50, newest first) through the
same `sliceBusWorkFeedView` that reports `matched` as the true filtered
total before the cap and `omitted` as the rest while claims holds regroup
under the shown jobs only, accepts
no caller root or path, and passes a refused or unavailable feed through
untouched. The endpoint answers 200
for `ok` and `refused` — the projection's own status, reason and blamed
receipt stay in the body — while `unavailable`, `retryable` and `invalid`
storage answer 503. A missing store reads as an empty `ok` feed. Status
filtering stays client-side; a missing provider stays a refusal, never a
fabricated owner. Every refused-feed read names the receipt when the
projection could attribute one: the feed CLIs print it as `receipt=<id>`,
`agents bus status` reports it as `feed.receipt`, `agents bus work mine`
carries it on the refused `jobs`/`announced` sections, the work send verbs
refuse `at receipt <id>`, and the unified comms inbox lists the refusal
itself as a high-severity bus item deep-linking `agents bus show <id>` —
a poisoned feed is pending work, never a silent empty list.

The read resolves an omitted post `provider` and the job `owner` match
through the agent identity registry beside the bus store: a sender label
matching a handle, `agent:<handle>`, stable id or alias takes that
identity's newest runtime provider and its stable id as the owner key, so
a `work.status` posted under any of one identity's labels updates its jobs
instead of refusing the feed (`BusWorkFeedReadOptions.providerFor` and
`ownerKeyFor` replace these fallbacks and `participants` adds explicit
participant metadata). An absent or unreadable registry hints nothing —
provider stays unknown, owner matching stays strict label equality, and
the projection still refuses rather than guessing.

`readBusWorkFeed({claims:true})` and `phm fleet work-feed --claims` join each
job's declared claim keys against the live coordination table in one read:
`claims.holds` lists every live lease blocking a job key (job, key, owner,
lease end, origin, source id; tokens never leave the store), with
`claims.source` of `missing`, `available` or `unavailable`. An unavailable
claim table means holds are unknown, not absent. GET
`/api/verse/agent-bus/work-feed?claims=true` serves the same join to
HTTP-only implementers — as do `open=true` and `claimable=true`, which
imply it; without a claims parameter the response omits `claims`.

### Bounded peer dispatch

`phm agentnet peers post <to> <work-post-json>` posts a directed work proposal
through the existing authenticated peer broker. `phm agentnet peers dispatch
[--after <cursor>] [--apply] [--json]` consumes at most eight proposals per pass;
omit `--apply` to preview with no queue, journal or bus writes. Advance with the
returned `nextCursor`. This claims work for existing queue workers; it does not
launch an executor or change dispatchd.

The host must provision a private 0600 `dispatch.json` beside
`~/.ashlr/agentnet/bindings.json`. Missing or invalid policy refuses dispatch:

```json
{"version":1,"enabled":true,"peers":["leader","specialist"],"repositories":[
  {"repo":"ashlrai/phantom","tierCeiling":"mid","paths":["docs/AGENT-BUS.md"]}
]}
```

Both callsigns must also be allowed `bus` identities in `agent-network.toml`;
`comms.toml` must have `confirmedByMason = true`. KILL and comms pause halt claims
and result sends. Current identity, policy and send gates are rechecked under
the queue lock. The message cannot choose policy files, commands, lanes or credentials.

A work proposal joins the shared work-feed projection, which refuses its whole
read on an unattributable provider or a duplicate job id until the receipt
expires; a work status joins it too, and the projection refuses its whole read
on a status from anyone but the job owner. `peers post` therefore verifies the
live feed before appending either body: a `work.post` must carry `provider` (or
the sender callsign must resolve to a registered identity runtime, the same
hint the feed uses) and its `jobId` must not already be announced; a
`work.status` must name a job the feed shows and only the announcing callsign —
or a callsign resolving to the same registered identity — may move it. An
unreadable feed refuses the send. Refusals are `work-provider-required`,
`work-job-exists`, `work-job-unknown`, `work-status-not-owner` and
`work-feed-<status>`.

Example work body (JSON data, never shell input):

```json
{"kind":"work.post","jobId":"RQ-DOCS","title":"Fix spelling","repo":"ashlrai/phantom",
 "claimKeys":["queue:RQ-DOCS","path:ashlrai/phantom:docs/AGENT-BUS.md"],
 "provider":"codex-cmp",
 "dispatch":{"tier":"fast","scope":"Fix spelling in the bus guide.","acceptance":"Documentation links pass."}}
```

The announcing peer reports feed progress the same way once the job exists:

```json
{"kind":"work.status","jobId":"RQ-DOCS","status":"done","detail":"Optional bounded note."}
```

Dispatch requires one `queue:<jobId>` key and at least one exact file key in the
same repository. Globs, repository-wide claims, traversal, protected/Tier-1 paths,
excess files and tiers above the host ceiling are refused. Scope and acceptance
use the internal queue prompt validator (4000/2000 characters, printable,
secret-free). The schema refuses command/executable fields. Prose is untrusted
worker input and grants no authority beyond the listed files or existing gates.
These file keys bound scope; resource leases still use the v2 coordination table
and overlap protocol above, not this consumer's bookkeeping.

The queue ID is `peer-work-` plus the first 32 hex characters of SHA-256 of JSON
`[lowercaseRepo, jobId]`. It is independent of sender, consumer and envelope ID.
The exclusive QueueStore transaction inserts and claims once as `peer:<callsign>`;
replays with altered content or a different peer conflict. A bounded private
`agentnet/work-dispatch.json` journal under the bus root records peer, claim key,
queue ID, receipt ID, digests and outcome, never prompt text or credentials.
It reserves before admission and recovers a committed claim after a crash.
At 512 receipts it refuses new work rather than forgetting dedupe history.

`work.result` replies use stable per-receipt/per-outcome bus IDs so retries do
not multiply replies. `phm agentnet peers read` admits only the journal's latest
sent outcome per receipt to the addressed callsign, with an exact body match;
earlier outcomes stay bus-local. The raw durable bus cursor API still shows
every retained reply. They carry no claim token. Queue DONE/BLOCKED with a
finished matching claim produces complete/failed, including when the feed
cursor has advanced; peer work.status
does not prove completion — it is the announcing peer's own feed report, sent
through `peers post` under the same owner rule as `updateWorkStatus`, and it
carries no claim token or queue evidence. The read also takes the shared bus
filter flags — `--from`/`--exclude-from`/`--to` on the envelope's own
callsign/topic labels (never registry-resolved), `--since`/`--before` on the
receipt stamp, `--contains` on the scrubbed body summary, `--id`, `--kind`
(the `busBodyKind` discriminator), `--peer-kind` (the inner kind of a
`peer.message` body), `--thread` (a `peer.message` payload's `threadId` or a
note/context body's `thread`), `--job` (the shared job-citation rule) and
`--result` (the `work.result` outcome) — applied to the admitted page only:
they narrow what the caller sees and never admit an envelope the ledger or
journal refused, and `nextCursor` still advances over every scanned row, so a
filtered read is a view of the page rather than a subscription. Uncertain reservations remain visible
and retryable. The unified comms inbox's `peer-dispatch` source lists the same
journal's receipts whose `sent` trails `outcome` — results a peer still awaits
that no other surface enumerates (the dispatch feed page reports only the
current proposals) — each deep-linking `phm agentnet peers dispatch --apply`;
an absent journal reports `missing`, an unreadable one `unavailable`.
Comms-disabled or revoked peers receive no sends. Results stay on the local bus;
Slack delivery is not part of this consumer.

### 5. Ownership table

Outside implementers (Dot included) call only the HTTP contract above.

| Part | Phantom file |
| --- | --- |
| Schemas, claim key parsing, overlap rules | `src/core/agents/bus-v2-schema.ts` |
| Coordination claim and status table | `src/core/agents/claim-store.ts` |
| v2 claim/release body executor | `src/core/agents/bus-claims.ts` |
| Bus store, caps, cursor reads, HTTP endpoints | the v1 store behind `/api/verse/agent-bus` |
| Message-id claims | `src/core/fleet/bus-work-claims.ts` (writes through the coordination table) |
| Team leases and board task claims | `src/core/teams/state.ts`, `src/core/fleet/bus-board.ts` (write through the same table) |
| Channel adapters | `src/core/agents/channel-registry.ts`, `src/core/agents/adapters/` |
| Provider send bridges | `src/core/agents/bridges/` |
| Adapters and fleet bus verbs | `src/cli/fleet-bus-*.ts`, `src/core/fleet/bus-adapters/` |
| Contract printer | `src/cli/agents-bus-contract.ts` |
| Identity and channel registry | `src/core/agents/bus-identity.ts` |
| DM, channel, handoff, inbox and wake API | `src/core/agents/bus-unified.ts`, `src/cli/agents-bus-unified.ts` |
| CLI session adapters (claude, codex, devin, cursor, grok) | `src/core/agents/bus-cli-adapters.ts` |
| Webhook relay | not built; an internet-facing relay must verify signed requests and gets its own security review |

Message-id claims, team leases, and bus-board task claims write their leases
through `src/core/agents/claim-store.ts`, so overlap is decided in one table.
A second live claim on an overlapping key is rejected. A team lease's `path`
is a prefix claim — it covers the path and everything beneath it — so it
overlaps a bus `path:` glob that matches any path in that subtree, in either
acquire order. Characters such as `[` or `{` are literal under `globMatches`,
never wildcards, so a team path like `src/[id]` stays a concrete prefix claim.
`*` and `?` are the glob wildcards but also legal filename characters: a team
path carrying them keeps the same prefix coverage, and the overlap check reads
the path as a glob on top of that, so the answer can err toward a conflict,
never toward a miss.
Queued path claims stay
a read-only view of queue prompt files and can be merged onto that board with
`claimBoard()`. `phm agents roster` reads this table through `readRosterClaims`.
A message-id lease is shown under its bus message id, so a roster session and
a bus claim still share one lease.
GET `/api/verse/agent-bus/work-feed` serves the work-feed projection over
HTTP with the feed CLIs' filter parameters (read session required;
`ok`/`refused` answer 200, storage faults 503).

### Message links in Fleet

The Fleet world shows live local bus messages as directional links. Run
`phm fleet edges --json` for the same `fleet.edges.v1` projection. Each edge
contains routing labels, a message count and the latest receipt time; it never
includes message bodies. `--window-minutes <1..1440>` keeps only edges whose
receipts fall inside the trailing window — the same bound the org map's
`minutes` parameter applies — and `--root <absolute>` reads a non-default
fleet store like the other fleet bus reads. Provider labels come from sender metadata observed on
live receipts. A missing or conflicting provider is `null` (unknown). Labels
are not authenticated identities. Broadcasts to `leaders`, human/external
messages, self-messages, dead-letter notices filed to `bus.dead-letter` and
`group.presence` heartbeats — system traffic with its own read, never
agent-to-agent mail — are excluded. The local bus retains and expires
messages, so these links are not a complete history; A2A events are not yet
included. A missing or unreadable bus reports unknown edges, not an empty list.

Group-chat projection: [Agent group chat](AGENT-CHAT.md) documents the scoped CLI and local read API.

Local-only preparation component: [Owner note draft composer](AGENT-CHAT-DRAFT.md).
