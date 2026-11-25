/** Thin argv adapter for the unified agent bus (src/core/agents/bus-unified.ts). Exit 0 ok, 1 refused, 2 usage. */
import { isAbsolute } from 'node:path';
import {
  agentChannelNameSchema, BUS_CLIS, createAgentChannel, joinAgentChannel, leaveAgentChannel, readAgentRegistry, registerAgentIdentity,
  type BusCli, type BusProvider,
} from '../core/agents/bus-identity.js';
import {
  agentWakeClaimHolderSuffix, agentWakeMessageSuffix, announceWork, busBodyFallbackSummary, busInboxJobMarker, busPageResumeCursor, listBusChannels, postChannelMessage, postLabelMessage,
  readAgentChannel, readAgentInbox, readAgentWakes, readAllWakes, readBusEnvelopeById, sendDirectMessage, sendHandoff, sendWakeRequest,
  updateWorkStatus, INBOX_KINDS, type AllWakesPage, type BusEnvelopeLookupJob, type InboxKind, type UnifiedBusOptions, type WakePage, type WorkStatusInput,
} from '../core/agents/bus-unified.js';
import { PROVIDERS, providerSchema, WORK_RESULT_OUTCOMES, WORK_STATUSES, WORK_TIERS, parseClaimKey, type WorkDispatch, type WorkJob, type WorkResultOutcome } from '../core/agents/bus-v2-schema.js';
import { busWorkFeedOwnerMatcher, busWorkFeedPendingToMatcher, busWorkFeedRepoKey, BUS_WORK_FEED_CONTAINS_MAX, BUS_WORK_FEED_LIMIT_MAX, formatBusWorkFeed, formatBusWorkFeedJob, projectBusWorkFeedView, readBusWorkFeed, sliceBusWorkFeedView } from '../core/agents/bus-work-feed-read.js';
import { attachBusCliSession, busAgentView, detectBusCli, frameBusChannelRead, frameBusInbox, listBusCliAdapters } from '../core/agents/bus-cli-adapters.js';
import { busClaimExitCode, claimBusWorkJob, executeBusClaimBody, listBusClaims, newBusClaimOpId,
  type BusClaimResult, type BusClaimJobRef, type BusWorkJobClaimResult, type BusWorkJobClaimScope } from '../core/agents/bus-claims.js';
import { COORDINATION_ORIGINS, type CoordinationOrigin } from '../core/agents/claim-store.js';
import { formatBusWorkMine } from '../core/agents/bus-work-mine.js';
import { readBusWorkMineWithSeats } from '../core/agents/bus-work-mine-seats.js';
import { readUnifiedBusStatus } from '../core/agents/bus-status.js';
import { claimNextBusWork, type BusNextResult } from '../core/fleet/bus-next-claim.js';
import { mutateBusWorkClaim, type BusClaimRequest, type BusClaimResult as BusMessageClaimResult } from '../core/fleet/bus-work-claims.js';
import { scrubSecrets } from '../core/util/scrub.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { seatParticipants } from '../core/bots/seats.js';

export const AGENTS_BUS_UNIFIED_VERBS = new Set(['id', 'dm', 'post', 'channel', 'handoff', 'wake', 'inbox', 'wakes', 'show', 'adapters', 'claim', 'work', 'status']);

export const AGENTS_BUS_UNIFIED_HELP = `ashlr agents bus id register [<handle>] [--cli <cli>] [--provider <p>] [--model <m>] [--alias <label>]... [--display <name>]
ashlr agents bus id list
ashlr agents bus id show [<ref>]
ashlr agents bus dm --to <agent> --text <text> [--kind note|context] [--from <agent>] [--priority P0..P3] [--thread <t>] [--ref <ref>]... [--reply-to <id>] [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus post --to <label> --text <text> [--kind note|context] [--from <agent>] [--priority P0..P3] [--thread <t>] [--ref <ref>]... [--reply-to <id>] [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus channel create <name> [--from <agent>] [--member <agent>]...
ashlr agents bus channel join|leave <name> [--agent <agent>]
ashlr agents bus channel post <name> --text <text> [--kind note|context] [--from <agent>] [--topic <t>] [--thread <t>] [--ref <ref>]... [--reply-to <id>] [--priority ..] [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus channel list [--agent <agent>]
ashlr agents bus channel read <name> [--topic <t>] [--from <agent>] [--exclude-from <agent>] [--thread <t>] [--priority P0..P3] [--job <id>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>] [--result <${WORK_RESULT_OUTCOMES.join('|')}>] [--matched] [--after <cursor>] [--limit <1..100>] [--frame <cli>]
ashlr agents bus handoff --to <agent> --task <job id> --prompt <text> [--from <agent>] [--priority ..] [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus wake --to <agent> --reason <text> [--job <id>] [--from <agent>] [--priority P0..P3] [--id <id>] [--ttl <ms>]
ashlr agents bus inbox [<agent>] [--after <cursor>] [--limit <1..100>] [--thread <t>] [--from <agent>] [--exclude-from <agent>] [--with <agent>] [--priority P0..P3] [--kind dm|channel|handoff|legacy] [--job <id>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--channel <name>] [--contains <text>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>] [--result <${WORK_RESULT_OUTCOMES.join('|')}>] [--matched] [--frame <cli>]
ashlr agents bus wakes [<agent>] [--all] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--job <id>] [--from <agent>] [--exclude-from <agent>] [--priority P0..P3] [--channel <name>] [--contains <text>] [--thread <t>] [--in-reply-to <id>] [--id <id>] [--body-kind <kind>] [--result <${WORK_RESULT_OUTCOMES.join('|')}>]
ashlr agents bus show <id>
ashlr agents bus adapters
ashlr agents bus claim acquire --key <claimKey> --lease-ms <1..3600000> [--owner <label>] [--id <opId>]
ashlr agents bus claim renew --key <claimKey> --token <64hex> --lease-ms <1..3600000>
ashlr agents bus claim release --key <claimKey> --token <64hex> --outcome released|completed
ashlr agents bus claim list [--key <claimKey>] [--owner <label>] [--exclude-owner <label>] [--origin <resource|message|team|board>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--jobs]
ashlr agents bus claim message acquire --id <envelope-id> --lease-ms <1..3600000> [--owner <label>]
ashlr agents bus claim message renew|release|complete --id <envelope-id> --token <64hex>
ashlr agents bus work post --job <id> --title <text> --repo <owner/name> [--claim <key>]... [--to <label>]
    [--provider <p>] [--tier <fast|mid|work|frontier> --scope <text> --acceptance <text>]
    [--from <agent>] [--priority P0..P3] [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus work status --job <id> --status <${WORK_STATUSES.join('|')}> [--detail <text>] [--to <label>]
    [--from <agent>] [--priority P0..P3] [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus work feed [--status <${WORK_STATUSES.join('|')}>] [--job <id>] [--repo <owner/name>] [--provider <p>] [--tier <${WORK_TIERS.join('|')}>] [--to <label>] [--owner <agent>] [--channel <name>] [--result <${WORK_RESULT_OUTCOMES.join('|')}>] [--claims] [--open] [--claimable] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--limit <1-${BUS_WORK_FEED_LIMIT_MAX}>]
ashlr agents bus work claim --job <id> --lease-ms <1..3600000> [--key <claimKey>] [--owner <label>] [--id <opId>]
ashlr agents bus work mine [<agent>] [--job <id>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--priority P0..P3] [--channel <name>] [--from <agent>] [--exclude-from <agent>] [--id <id>] [--in-reply-to <id>] [--body-kind <kind>]
ashlr agents bus work next [<agent>] --lease-ms <1..3600000> [--owner <label>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--priority P0..P3] [--channel <name>] [--from <agent>] [--exclude-from <agent>]
ashlr agents bus status
Common: [--root <abs>] [--json]. <agent> is a handle, agent:<handle>, agt_ id or alias;
--from, --agent and a missing <agent> default to PHM_AGENT_ID. Identities are routing
names, never authentication. Messages land in the one local bus store; P0 always
wakes, P1 and handoffs wake by default, and wake always records its hint.
post sends a v2 note (or context with --kind context) to any printable routing
label outside the reserved agent:/group:/dm:/handoff: prefixes — the sink and
topic mail dm, channel post and the work verbs cannot carry; the sender is
still a registered identity under the same scrub and wake rules. --kind on
dm, post and channel post picks the v2 conversational body kind — note by
default, context for reference material; the delivery-kind enum inbox reads
filter by is a different --kind.
--thread on dm, post, channel post, inbox, channel read and wakes is the v2
conversation label carried by note/context bodies; reads match that field
only — on wakes the verdict is the resolved referent's own thread, so a
claim-holder hint's work.status citation never matches. --from on
inbox and channel read narrows to one sender — a handle, agent:<handle>,
stable id or alias; an unresolvable ref keeps exact-label matching.
--reply-to on dm, post and channel post stamps the v2 inReplyTo citation —
the envelope id this message answers — which agents conversations threads on
and the pending-work sections credit when they drop an answered ask or
handoff; it cites a routing id, never proof the target existed.
--exclude-from on inbox and channel read drops mail sent under every
registered spelling of one identity — the same sender-exclusion rule
comms bus read|watch --exclude-from, fleet bus-follow --exclude-from and
fleet_bus_inbox apply — so a room's noisy member or a flooding sender
never reaches the page while every other sender still does; it composes
with --from (a sender both included and excluded matches nothing) and
every other filter. --with on inbox keeps only the two-way exchange the
addressed agent and one peer name — the same pairwise rule phm messages
--with and agents conversations --with apply: the peer's labels on the
sender side against the agent's own labels on the addressed side, so
channel posts and channel-addressed handoffs — whose to is a room
address, never the peer — stay out while every dm, legacy and
label-addressed handoff the peer sent remains; "our private pending
thread" is one filtered read, distinct from --from which also keeps the
peer's room traffic, and the peer ref resolves through the registry
exactly like --from with an unresolvable ref keeping exact-label
matching. --priority
on inbox and channel read keeps only one exact P0..P3 band — the same match
comms bus read --priority applies — so urgent mail is one filtered read, not
a page through the backlog. --kind on inbox keeps only one delivery kind —
dm, channel, handoff or legacy, the same kind each inbox row prints — so an
agent can read just its handoffs or just its direct mail in one filtered
read; it composes with every other inbox filter and --matched counts only
the rows it accepts. --job on inbox keeps only mail that names one job — a
work.post/work.status/work.result/wake body declaring that jobId, a
worker-handoff assigning that fleet job id through taskId, or a
note/context body carrying the job:<id> thread label — and the same flag
on channel read keeps only the channel's posts that name it, so an agent
on one job reads its pending mail and its room's job traffic without
paging the whole store. --job on wakes keeps only the hints that provably
name the job — the same rule applied to the message a hint refers to, or
the citing status's jobId on a claim-holder hint — so job-scoped triage
reads one filtered hint list; matched then counts the proven matches on
the resolved page, an unreadable bus store reports unavailable rather
than an empty page, and truncated still marks queue-tail or row-cap cuts.
--contains on wakes keeps only hints whose resolved referent text — a
bus.send hint's live message summary or a claim-holder hint's citing
work.status detail, the same scrubbed one-line text the row reports —
carries the needle as a case-insensitive substring, so "which wake was
about X" is one filtered read; a hint whose referent cannot be resolved
names no provable text and never matches, and matched counts the proven
matches on the resolved page. --priority on wakes keeps only hints in one
exact P0..P3 band — the same match inbox, channel read and work feed
--priority apply — decided on the resolved referent's own band: the live
message a bus.send hint points at or the citing work.status receipt
behind a claim-holder hint, with an unresolvable referent never matching
and matched counting the proven matches on the resolved page. --channel
on wakes keeps only hints addressed to group:<name>:* of one channel —
the same room prefix inbox --channel and phm messages --channel match —
decided on the hint's own to label, so it composes with the addressee
scope and every other filter and matched counts it with the rest of the
queue-tail match; on --all it answers "which hints concern room X" in one
fleet read.
--since on inbox, channel read and wakes keeps only rows at or after the
cutoff — the phm messages grammar (15m, 2h, 1d, epoch ms or an ISO
time), resolved to epoch ms — so fresh mail, a room's recent posts and
new wake hints are one filtered read without a persisted cursor; inbox
and channel read match receivedAt inclusively, wakes matches hints
after it. --before on the same three reads keeps only rows strictly
before its own cutoff on the same grammar — the exclusive upper bound
composing with --since into one [since, before) window (wakes' own
window is (since, before): its --since boundary is strictly-after and
--before strictly-before on the hint's queue time) — so "what was in my
inbox / what did the room say / which hints were pending before time T"
is one filtered read. --from on wakes keeps only hints whose recorded
sender label
resolves to one agent — a handle, agent:<handle>, stable id or alias
matching every label of that identity, the same rule inbox --from and
channel read --from apply, with an unresolvable ref keeping exact-label
matching; a bus.send hint's sender is the triggering envelope's from, a
claim-holder wh-… hint's the posting identity's agent:<handle>, so
"which agent keeps waking me" is one filtered read. --exclude-from on
wakes drops hints sent under every registered spelling of one identity —
the same matcher and exact-label fallback --from applies — composing
with --from so a sender both included and excluded matches nothing, so
"everyone's wakes except the noisy bot's" is one filtered read. --all on
wakes drops the addressee scope entirely — every hint in the bounded
queue tail, registered identities' and bare coordination labels' alike,
each row's own to naming its addressee — so a leader or comms pass sees
who has pending hints in one read instead of one wakes call per
identity; it takes no agent and the same filters apply. --channel on inbox
keeps only mail addressed to one registry
channel's group:<name>:* addresses — channel posts and channel-addressed
handoffs alike — so an agent in several rooms reads one room's pending
mail in one filtered read; it composes with --kind to separate a room's
direct mail from its assignments, and a channel the agent is not a
member of simply has no mail to show. --contains on inbox and channel
read keeps only rows whose scrubbed one-line summary — the same text
the frame renders per row — carries the needle as a case-insensitive
substring, so "did anyone send me mail about X" and "has anyone posted
about X in this room" are one filtered read; matching runs over the
rendered summary, never the raw body, so a secret-shaped value stays
unfindable even though it sits in the stored envelope. --in-reply-to on
inbox, channel read and wakes keeps only rows whose object body cites that
envelope id through its own inReplyTo field — the same own-property
exact match phm messages --in-reply-to, comms bus read|watch
--in-reply-to, fleet bus-follow --in-reply-to and fleet_bus_inbox's
inReplyTo apply, never the replyTo alias or a substring — so "which of
my pending mail / which room posts answer envelope X" and "did the reply
to envelope X trigger a wake" is one filtered
read, composing with every other filter. --id on inbox, channel read and
wakes keeps only the row whose own id is strictly equal to the value —
the same exact-envelope match comms bus read|watch --id, fleet
bus-follow --id and fleet_bus_inbox's id apply, never a substring or a
body citation — so "is envelope X still pending for me", "did envelope X
reach the room" and "is there still a wake hint for envelope X" are one
filtered read each; on wakes the matched id is the hint's own id — the
triggering envelope's wire id on a bus.send hint, the wh-… claim-holder
id on those — decided on the queue row alone, so it needs no referent
resolution and counts in matched like the other queue-tail filters.
--body-kind on inbox, channel read, wakes and work mine keeps only rows
whose body carries that exact kind discriminator — the v2 kind field
(note, context, work.post, work.claim, work.status, work.result,
work.release, wake), a worker-handoff assignment or a notice kind, a
bus-transport v1 protocol.kind, or a type/schema notice discriminator,
the same discriminator the row summary switches on — matched exactly and
case-sensitively, so "which of my pending mail are work results" or
"which room posts are wake requests" is one filtered read; on wakes the
verdict is the resolved referent's own body kind — a claim-holder
wh-… hint's citing work.status receipt provably carries work.status,
so those hints match only that kind — and on work mine the filter
reaches every section whose items carry a retained body: next, handoffs
and mailbox keep envelopes of that kind, claims keep only message
claims whose resolved leased envelope reports it, inbox, wakes and the
three thread sections pass it to their own reads, jobs and announced
keep the feed jobs citing a receipt of that kind (every job cites its
work.post announcement, so work.post keeps them all), while board,
channels and seats carry no per-item body and stay whole — a body
carrying no discriminator never matches, and an unrecognized but
printable value is an honest empty match, never an error. It composes
with every other filter and counts in matched like the rest.
--result on inbox, channel read and wakes keeps only rows whose body is a
work.result receipt reporting that one outcome — reserved, admitted,
complete or failed, the same WORK_RESULT_OUTCOMES vocabulary the work
feed's --result filter validates — read through the kind-scoped
busBodyResultOutcome own-field match, so every other body kind (a
work.release body's own released/completed outcome included) and a
work.result carrying no outcome never matches: "which of my pending
result receipts failed", "which room posts are failed result
receipts" or "which wakes were triggered by a failed result" is one
filtered read, the envelope-level audit trail the feed's per-job
newest-result --result cannot show. On wakes the verdict is the
resolved referent's own outcome — a claim-holder wh-… hint's citing
receipt is a work.status body, which provably reports no result
outcome, so those hints never match, and an unresolved or unknown
referent names no provable outcome and never matches either. It
composes with every other filter and counts in matched like the rest.
--matched
on inbox and channel read reports matched, the true pending total across the
whole retained store the same filters accept; messages still caps at --limit
and nextCursor then resumes at the newest shown row, so paging never skips
an unshown match. Inbox and channel-read rows annotate what they carry:
claimable work and
worker-handoff bodies report held/holder — whether a taken claim or live
coordination hold already covers the receipt — and bodies naming a job
(work.post/work.status/work.result/wake jobId citations and
worker-handoff taskIds) report job, the live feed state of the job they
name (the same annotation show resolves, read once per page), so an agent
sees hold and job state without a lookup per message.
show
resolves one retained envelope by the wire id wake hints, work mine items
and claim operations cite; an expired id reports not-found, and the read
needs no identity. A body naming a job — a work.post or work.status
jobId citation or a worker-handoff taskId — additionally reports
job — the live work-feed state of the job it names, with claim
coverage, or the feed's own refused/unavailable state when the projection
cannot answer — so the citation resolves to where the job stands in one
read. A claim-holder wh-… hint id resolves through the wake
queue to the live terminal work.status receipt that cites it, returned
with its wakeHint citation; a hint no live receipt reproduces reports
not-found.
A terminal work status also queues a routing-only wake hint for each live claim
holder on the job's keys; --no-wake opts out. Holder labels need not be
registered identities, so wakes (and the work mine wakes section) keep
exact-label matching for a ref that resolves to no identity — JSON reports
scope: label and only hints whose to is that label verbatim match. work feed and claim list are
read-only and need no identity; work feed --to keeps jobs announced to that
agent — the literal routing label, every label of one agent identity, and
group:<channel>:<topic> addresses of registry channels the identity belongs
to, minus that identity's own channel posts — while --owner keeps jobs
announced by that agent under every label of one agent identity, --channel
keeps only jobs announced to group:<channel>:* — the room's traffic under
every topic, the same address prefix inbox --channel and channel read
match —, --repo keeps jobs announced for one
owner/name repo (case-insensitive, the claim-key rule), --provider keeps
jobs announced for one provider, --tier keeps only jobs whose announcement
declared that dispatch tier — a job carrying no dispatch spec declares none
and never matches, so the filter answers "which jobs are for my tier" in one
read — --claimable keeps only open jobs whose
declared claim keys provably include a free key (it implies the claims
join), --open keeps queued/rescheduled candidates with claim keys, including
unknown holds, and implies --claims; --since keeps only jobs whose last activity — the newest accepted
status receipt time, or the announcement's while no status has moved the
job — reaches the cutoff (15m, 2h, 1d, epoch ms or an ISO time, the same
grammar inbox --since takes), --before keeps only jobs whose last activity
is strictly before its own cutoff on the same field so the pair reads one
[since, before) window and older pages stay reachable past the newest-first
--limit cap, while --job keeps one job id. --contains on
work feed keeps only jobs whose title, newest status detail or declared
dispatch scope/acceptance carries the needle as a case-insensitive
substring over the same scrubbed display-clipped text the job line renders
— ids, keys, statuses and labels stay structured fields with their own
filters, and a secret-shaped value stays unfindable. --limit pages the
filtered view newest-first (1..200) and reports matched as the true
filtered total before the cap and omitted as the rest, with claims holds
regrouped under the shown jobs only — the same page fleet_work_feed's
limit argument and work-feed?limit= serve. --result keeps only jobs whose
newest retained work.result citation carries that outcome — reported
evidence that never moved the job's status, so a complete result on a
still-running job is the divergence it surfaces, and a job with no result
never matches. A job line
also cites the newest retained work.result receipt — the outcome a
worker reported with its receipt id — as evidence only: it never moves
the job's status, which only the announcer's work.status does. work claim
takes one of
a shown job's declared claim keys — queue:<jobId> preferred, --key picks
another declared key — into the shared coordination table, reporting live
holds on the job's other declared keys; claims coordinate,
never authenticate. work mine is a read-only per-agent digest — the live
claims it holds under any of its labels, where a message-id claim also
names the retained envelope it leases (id, cursor, kind, sender,
recipient, scrubbed summary and any live job citation; the claims
journal's receipt pin decides resolved vs not-found and reports
pinned=false/unknown on drift), the open feed jobs still claimable
for it, the feed jobs it announced that have not finished (done and
terminated drop off; failed stays listed because only the announcer may
move it) — each carrying the per-key hold coverage of its declared
claim keys plus the shown holders (owner label, lease expiry, claim
class) naming who blocks each key, so a live worker reads differently
from a stale lease — the claimable work envelopes addressed to it or a
channel it
belongs
to in bus-next order with their hold state, the worker-handoff assignments
addressed the same way (each item carries the to label handoff-receive and
handoff-reply take verbatim), the conversation threads waiting on its
answer — asks and handoffs whose latest message it or a channel it belongs
to still owes, each citing the envelope id show resolves — the
conversation threads it is waiting on — its own asks and handoffs nobody
has answered yet, each naming who owes the reply — its
pending wake hints, the next page of mail addressed
to it, pending legacy phm bus mailbox mail addressed to any of its
labels and the shared task board's pending digest (phm bus board pending)
under the same labels, plus the bot-seat handoff work the agent's seats
still hold — the same planSeatHandoffs read phm bots handoffs serves,
listing only eligible seats with pending records under any of the agent's
labels or a literal seat/participant ref — capped sections carry matched
(or open for jobs) as their true
pending total — where every section reports its own read state and unknown
stays unknown. --job on work mine narrows the whole digest to one job id —
the same citation rule inbox --job applies plus the feed-id and board
itemId joins: feed jobs and announced jobs match by id, claims by
declared-key overlap with an announced job or a leased body's job
citations, next and handoffs by body citation (claimable work names none,
so next is empty under --job), threads/awaiting/blocked by
the conversations job query, wakes and inbox by their own job filters,
mailbox by body citation, the board by its job-carrying-thread rule, and
the seats section by node-job handoff refs — with every count the
filtered total. --contains on work mine narrows the whole digest to the
rows whose displayed descriptive text carries the needle as a
case-insensitive substring — the same rule every other bus --contains
read applies: feed and announced jobs match the feed's job search text,
claims match a blocked job's title/detail or a resolved leased message's
summary, next/handoffs/mailbox match the body summary,
threads/awaiting/blocked match member-message subjects through the
conversations read, wakes match the resolved referent's summary or
citing status detail, inbox matches the inbox read's own contains rule,
the board matches delivery post text and task/thread titles inside
pendingFor, and seats match the held-work ref/branch/pr a handoff
record carries — while ids, claim keys as keys, statuses and routing
labels keep their own filters and channels, registry context rather
than pending work, stays unfiltered; a row whose text cannot be proven
never matches and every count stays the filtered total. --since on work
mine keeps only pending items whose recorded time reaches the cutoff —
15m, 2h, 1d, epoch ms or an ISO time, the same grammar inbox --since
takes — so a polling agent reads the delta since its last check instead
of the whole pending set: claims match the lease's recorded started (a
null start never matches), feed jobs and announced jobs match
updatedAt, next/handoffs/inbox match the envelope receipt, mailbox
matches acceptance, threads/awaiting/blocked and wakes inherit their own
reads' since rules on latest activity, board deliveries match createdAt
while board tasks — which keep no timestamp — never match, and seats
stay unfiltered — a pending handoff record's createdAt stamps the plan
read instant, not the held work's age, so no per-record recency exists
to filter on; a pending item older than the
cutoff is still pending but is not new, channels and seats stay
unfiltered, and
every count stays the filtered total. --before on work mine keeps only
pending items whose recorded time is strictly before its own cutoff —
the exclusive upper bound on the same grammar --since takes, so the
pair reads one [since, before) window and "what was pending before
time T" is one filtered digest: claims match the lease's recorded
started, feed jobs and announced jobs match updatedAt, next/handoffs
match the envelope receipt, threads/awaiting/blocked inherit the shared
conversations read's lastAt bound, mailbox matches acceptance, inbox
matches receivedAt and wakes the hint's queue time inside their own
reads' exclusive upper bounds, and board deliveries match createdAt
while board tasks — which keep no timestamp — never match; an item
stamped exactly at the cutoff never
matches, channels and seats stay unfiltered, and every count stays the
filtered total. --priority on work mine keeps only
pending items stamped with that exact P0..P3 band — the same match inbox
--priority and every other bus read applies, so "what urgent work is
pending for me" is one filtered digest: next and handoffs keep envelopes
of that band, inbox and mailbox keep mail of that band, wakes keep hints
whose resolved referent reports it (unresolved or unknown referents
never match), and claims keep only message claims whose resolved leased
envelope reports that band — a claim naming no provable band never lists;
feed jobs, announced jobs, the thread sections, board rows, channels and
seats carry no per-item band and stay unfiltered, and every count stays
the filtered total. --channel on work mine keeps only pending items
provably addressed to group:<name>:* of one bus channel — the same room
prefix every bus read's --channel matches, so "what is pending for me in
this room" is one filtered digest: feed jobs and announced jobs keep
announcements whose to carries the prefix, next, handoffs and mailbox
keep envelopes whose to carries it, claims keep only message claims whose
resolved leased envelope sits in the room (a claim naming no resolved
message never lists), the thread sections keep threads whose latest
message is addressed to the room, and wakes and inbox pass the name to
their own reads' channel filters; board, channels and seats carry no
per-item room and stay unfiltered, and every count stays the filtered
total. --from on work mine keeps only pending items provably sent by the
named agent — the same sender rule every bus read's --from applies, so
"what is pending for me from X" is one filtered digest: feed jobs and
announced jobs keep announcements whose owner resolves to the ref, next,
handoffs and mailbox keep envelopes whose from the identity-label
matcher accepts, claims keep only message claims whose resolved leased
envelope's from matches (a claim naming no resolved message never
lists), the thread sections pass the ref into the shared conversations
read's own from filter, and wakes and inbox pass it to their own reads'
sender filters; board deliveries keep only posts whose sender label
matches while board tasks — which record no author — never match, and
seats and channels carry no per-record sender and stay unfiltered, and
every count stays the filtered total. --exclude-from inverts the same
match — a section keeps an item unless its sender evidence resolves to
the excluded ref, so a sender that cannot be proven excluded is never
dropped while board tasks stay listed under it; the two compose so a
sender both included and excluded matches nothing. --id on work mine keeps
only pending items that ARE the retained envelope the value names — the
same exact-envelope match every bus read's --id applies, so "is envelope X
still pending for me, and where" is one filtered digest: feed jobs and
announced jobs keep the jobs whose cited wire ids the value equals (the
work.post announcement, newest work.status receipt or newest work.result
receipt the job line prints as post=/status=/result=), next, handoffs and
mailbox keep envelopes whose own id equals it, claims keep only message
claims whose resolved leased envelope's id equals it (a claim naming no
resolved message never lists), inbox, wakes and the thread sections pass
the value to their own reads' id filters (inbox and wakes the item
envelope, conversations the thread envelope a member message belongs to),
and board, channels and seats carry no per-item envelope citation the
digest can prove and stay unfiltered; an id nothing on the bus carries is
an honest empty match and every count stays the filtered total.
--in-reply-to on work mine keeps only pending items whose body cites the
retained envelope the value names through its own inReplyTo field — the
same own-property exact match every bus read's --in-reply-to applies,
never the replyTo alias or a substring, so "what is pending that answers
envelope X" is one filtered digest: next, handoffs and mailbox keep
envelopes whose body the citation rule accepts, claims keep only message
claims whose resolved leased envelope's own inReplyTo equals it (a claim
naming no resolved message or no citation never lists), and inbox, wakes
and the thread sections pass the value to their own reads' in-reply-to
filters; feed jobs, announced jobs, board rows, channels and seats carry
no retained body citation in their projections and stay unfiltered, and
every count stays the filtered total. --body-kind on work mine keeps only
pending items whose body carries that exact kind discriminator — the same
busBodyKind match every bus read's --body-kind applies, so "which pending
items for me are work results" or "which are handoffs" is one filtered
digest: next, handoffs and mailbox keep envelopes whose body reports that
kind (claimable work under work or task, worker-handoff assignments under
worker-handoff, kindless legacy mail never), claims keep only message
claims whose resolved leased envelope reports it (a claim naming no
resolved message never lists), inbox, wakes and the thread sections pass
the value to their own reads' body-kind filters, jobs and announced keep
the feed jobs citing a retained receipt of that kind — every job cites
its work.post announcement so work.post keeps them all, work.status keeps
jobs a status receipt has moved, work.result keeps jobs a result receipt
cites, and any other kind is an honest empty match — while board,
channels and seats carry no per-item retained body and stay whole; a kind
nothing on the bus carries is an honest empty match and every count stays
the filtered total. work next claims the next claimable
work envelope addressed to the agent — the same kind:'work'/protocol-task
receipts work mine's next section lists, walked in bus-next order
(priority band, then cursor) under the same addressed-to rule: any label
of the resolved identity or a member channel's group:<channel>:<topic>
address, minus the agent's own channel posts. <agent> defaults to
PHM_AGENT_ID and --owner to PHM_AGENT_ID then the agent ref; --contains,
--since, --before, --priority, --channel, --from and --exclude-from narrow
the claimable set under the same rules the bus reads apply — the scrubbed
one-line summary substring, the inclusive receivedAt cutoff, the exclusive
receivedAt ceiling composing with --since into one [since, before) window,
the exact P0..P3 band, the group:<name>:* room prefix, and the sender
identity-label match —
so "claim the next work
about X" or "claim the next urgent one" is one atomic step, and empty's
{candidates, held} totals count only the filtered scan. acquired
returns the live receipt with its fencing token and lease expiry — the
token feeds the message-claim verbs claim message renew|release|complete
on this surface (the same journal comms bus claim spends) — while empty
reports
the observed {candidates, held} scan totals so a dry well reads
differently from held work. Claims coordinate scope only; bodies are
never executed. status is a read-only probe of the store, registry, wake queue, coordination
table, message-id claim journal, work feed, owner-chat share receipts, the
legacy mailbox, the shared task board with its fleet queue, the claim-drift
verdict comparing the claim journal with the coordination table, and the
outbound send gate every write verb passes through — its sendGate section
reports open, blocked or unknown plus the kill-switch and comms-pause
verdicts separately, so an agent learns sends are gated before a write
refuses; a section that cannot be read reports unavailable or unknown,
never zero. id show [<ref>] resolves one ref — or PHM_AGENT_ID when the
ref is omitted — to its registered identity: the agt_ id, agent:<handle>
address, aliases, runtimes and member channels, plus the detected session
CLI on the self view; an unresolvable ref reports unknown, a malformed one
invalid, an unreadable registry unavailable and a missing PHM_AGENT_ID
unset — never a guessed identity.
No network, no engine runs. Spec: docs/AGENT-BUS.md.`;

const VALUE_FLAGS = new Set(['--from', '--to', '--text', '--priority', '--thread', '--id', '--ttl', '--cli', '--provider',
  '--model', '--alias', '--display', '--member', '--agent', '--topic', '--task', '--prompt', '--after', '--limit',
  '--frame', '--since', '--before', '--root', '--key', '--owner', '--origin', '--lease-ms', '--token', '--outcome', '--reason',
  '--job', '--title', '--repo', '--claim', '--tier', '--scope', '--acceptance', '--status', '--detail', '--ref',
  '--result', '--with',
  '--kind', '--channel', '--contains', '--exclude-from', '--exclude-owner', '--reply-to', '--in-reply-to', '--body-kind']);
const MULTI = new Set(['--alias', '--member', '--claim', '--ref']);
const BOOL_FLAGS = new Set(['--json', '--wake', '--no-wake', '--claims', '--open', '--claimable', '--jobs', '--matched', '--all']);
const MESSAGE_CLAIM_ACTIONS = ['acquire', 'renew', 'release', 'complete'] as const;
const MESSAGE_CLAIM_OK = new Set(['acquired', 'renewed', 'released', 'completed']);

class UsageError extends Error {}

interface Parsed { positionals: string[]; values: Map<string, string[]>; bools: Set<string> }

function parse(argv: string[]): Parsed {
  const parsed: Parsed = { positionals: [], values: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    const equal = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = equal > 0 ? token.slice(0, equal) : token;
    if (VALUE_FLAGS.has(flag)) {
      const value = equal > 0 ? token.slice(equal + 1) : argv[++i];
      if (value === undefined || (equal < 0 && value.startsWith('--'))) throw new UsageError(`${flag} requires a value.`);
      const list = parsed.values.get(flag) ?? [];
      if (list.length && !MULTI.has(flag)) throw new UsageError(`Duplicate ${flag}.`);
      parsed.values.set(flag, [...list, value]);
    } else if (BOOL_FLAGS.has(token)) {
      if (parsed.bools.has(token)) throw new UsageError(`Duplicate ${token}.`);
      parsed.bools.add(token);
    } else if (token.startsWith('-')) {
      throw new UsageError(`Unknown option ${token.slice(0, 32)}.`);
    } else parsed.positionals.push(token);
  }
  if (parsed.bools.has('--wake') && parsed.bools.has('--no-wake')) throw new UsageError('Use --wake or --no-wake, not both.');
  return parsed;
}

function integer(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new UsageError(`${name} must be a non-negative integer.`);
  return Number(raw);
}

/** `RQ-1(running) "Fix the feed" detail="why" post=<id> [status=<id>]` — the
 * blocked job named by its announcement title, newest status detail and the
 * retained receipts behind it, display-clipped. */
function claimJobLabel(job: BusClaimJobRef): string {
  // eslint-disable-next-line no-control-regex
  const flat = (value: string): string => scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const clip = (value: string, max: number): string => {
    const text = flat(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const title = clip(job.title, 80);
  const detail = job.detail === undefined ? '' : clip(job.detail, 80);
  return `${job.id}(${job.status})${title === '' ? '' : ` "${title}"`}` +
    `${detail === '' ? '' : ` detail="${detail}"`}` +
    ` post=${job.postId}${job.statusId === null ? '' : ` status=${job.statusId}`}`;
}

function claimHuman(result: BusClaimResult): string {
  if (result.status === 'acquired') {
    return `acquired ${result.claim.claimKey} owner=${result.claim.owner} leaseMs=${result.claim.leaseMs} leaseUntil=${result.claim.leaseUntil} token=${result.claim.token}`;
  }
  if (result.status === 'renewed') return `renewed ${result.claim.claimKey} leaseUntil=${result.claim.leaseUntil}`;
  if (result.status === 'released' || result.status === 'completed') return `${result.status} ${result.claimKey}`;
  if (result.status === 'conflict') return `conflict ${result.holder.claimKey} held by ${result.holder.owner} until ${result.holder.leaseUntil}`;
  return result.status;
}

/** `work claim` human lines: the job named by its announcement title, the fencing token only on acquire. */
function claimScopeSuffix(scope: BusWorkJobClaimScope): string {
  if (scope.source === 'unavailable') return ' scope=unknown';
  if (scope.holds.length === 0) return '';
  return ` scope-held=${scope.holds.map(hold => `${hold.claimKey}@${hold.owner}`).join(',')}`;
}

function workJobClaimHuman(result: BusWorkJobClaimResult): string {
  if (result.status === 'acquired') {
    return `acquired ${result.claim.claimKey} for ${claimJobLabel(result.job)} owner=${result.claim.owner} ` +
      `leaseUntil=${new Date(result.claim.leaseUntil).toISOString()} token=${result.claim.token}${claimScopeSuffix(result.scope)}`;
  }
  if (result.status === 'conflict') {
    return `conflict ${result.holder.claimKey} for ${claimJobLabel(result.job)} held by ${result.holder.owner} ` +
      `until ${new Date(result.holder.leaseUntil).toISOString()}${claimScopeSuffix(result.scope)}`;
  }
  return `${result.status}: ${result.reason}${result.job === undefined ? '' : ` (${claimJobLabel(result.job)})`}`;
}

/** `claim message` human lines: the envelope id leads; the fencing token prints only on acquire. */
function messageClaimHuman(result: BusMessageClaimResult, id: string): string {
  if (result.status === 'acquired' || result.status === 'renewed') {
    return `${result.status} ${id} leaseUntil=${new Date(result.leaseUntil!).toISOString()}` +
      `${result.status === 'acquired' ? ` token=${result.token}` : ''}`;
  }
  return `${result.status} ${id}`;
}

/** work claim exit codes mirror claim acquire: acquired 0, invalid 2, every other refusal 1. */
function workJobClaimExitCode(result: BusWorkJobClaimResult): number {
  return result.status === 'acquired' ? 0 : result.status === 'invalid' ? 2 : 1;
}

/** `work next` human lines: the claimed receipt's id, lease and token, then its routing and scrubbed summary. */
function workNextHuman(result: BusNextResult, owner: string): string {
  if ('receipt' in result) {
    const { envelope } = result.receipt;
    const summary = busBodyFallbackSummary(envelope.body);
    return `acquired ${envelope.id} owner=${owner} leaseUntil=${new Date(result.leaseUntil).toISOString()} ` +
      `token=${result.token}\n  ${envelope.priority} from ${envelope.from} -> ${envelope.to}` +
      `${summary === '' ? '' : `: ${summary}`}`;
  }
  if ('candidates' in result) return `empty candidates=${result.candidates} held=${result.held}`;
  return result.status;
}

/** One human line for the live feed state `show` resolved beside a work envelope. */
function showJobLine(job: BusEnvelopeLookupJob): string {
  if (job.feed === 'ok') {
    return job.job === null ? `  job ${job.jobId} feed=ok job=absent` : `  job ${formatBusWorkFeedJob(job.job)}`;
  }
  if (job.feed === 'refused') {
    return `  job ${job.jobId} feed=refused:${job.reason}` +
      `${job.receipt === undefined ? '' : ` receipt=${job.receipt.id}`}`;
  }
  return `  job ${job.jobId} feed=${job.feed}`;
}

export async function runAgentsBusUnified(argv: string[], out: (text: string) => void, err: (text: string) => void,
  env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const json = argv.includes('--json');
  try {
    if (argv.some(arg => arg === '--help' || arg === '-h')) { out(AGENTS_BUS_UNIFIED_HELP); return 0; }
    const p = parse(argv);
    const one = (flag: string): string | undefined => p.values.get(flag)?.[0];
    const root = one('--root');
    if (root !== undefined && (!isAbsolute(root) || root.includes('\0'))) throw new UsageError('--root must be an absolute path.');
    const options: UnifiedBusOptions = root ? { root } : {};
    const self = env['PHM_AGENT_ID'] || undefined;
    const actor = (flag: string): string => {
      const value = one(flag) ?? self;
      if (!value) throw new UsageError(`${flag} is required when PHM_AGENT_ID is not set.`);
      return value;
    };
    const required = (flag: string): string => {
      const value = one(flag);
      if (value === undefined) throw new UsageError(`${flag} is required.`);
      return value;
    };
    const wake = p.bools.has('--wake') ? true : p.bools.has('--no-wake') ? false : undefined;
    const send = {
      priority: one('--priority') as BusPriority | undefined, ttl: integer(one('--ttl'), '--ttl'), id: one('--id'), wake,
    };
    // Read-side --priority is an enum like --frame/--status: a bad band is a
    // usage error here and an 'invalid' result inside the core read.
    const priorityArg = (): BusPriority | undefined => {
      const value = one('--priority');
      if (value !== undefined && !(BUS_PRIORITIES as readonly string[]).includes(value)) {
        throw new UsageError('--priority must be P0, P1, P2 or P3.');
      }
      return value as BusPriority | undefined;
    };
    // Read-side --kind on inbox is the delivery-kind enum: a bad value is a
    // usage error here and an 'invalid' result inside the core read.
    const kindArg = (): InboxKind | undefined => {
      const value = one('--kind');
      if (value !== undefined && !(INBOX_KINDS as readonly string[]).includes(value)) {
        throw new UsageError('--kind must be dm, channel, handoff or legacy.');
      }
      return value as InboxKind | undefined;
    };
    // Read-side --result is the work.result outcome enum the work feed's
    // --result filter validates: a bad value is a usage error here and an
    // 'invalid' result inside the core read.
    const resultArg = (): WorkResultOutcome | undefined => {
      const value = one('--result');
      if (value !== undefined && !(WORK_RESULT_OUTCOMES as readonly string[]).includes(value)) {
        throw new UsageError(`--result must be one of ${WORK_RESULT_OUTCOMES.join(', ')}.`);
      }
      return value as WorkResultOutcome | undefined;
    };
    // Send-side --kind on dm, post and channel post is the v2 body-kind enum:
    // a bad value is a usage error here and an 'invalid' result inside the
    // core send, the same split the read-side enum keeps.
    const bodyKindArg = (): 'note' | 'context' | undefined => {
      const value = one('--kind');
      if (value !== undefined && value !== 'note' && value !== 'context') {
        throw new UsageError('--kind must be note or context.');
      }
      return value as 'note' | 'context' | undefined;
    };
    // Read-side --origin on claim list is the claim-origin enum: a bad
    // value is a usage error here and an 'invalid' result inside the core read.
    const originArg = (): CoordinationOrigin | undefined => {
      const value = one('--origin');
      if (value !== undefined && !(COORDINATION_ORIGINS as readonly string[]).includes(value)) {
        throw new UsageError('--origin must be resource, message, team or board.');
      }
      return value as CoordinationOrigin | undefined;
    };
    // Read-side --since takes the phm messages grammar — 15m, 2h, 1d, epoch
    // ms or an ISO time — resolved to epoch ms; anything else is a usage
    // error here and an 'invalid' result inside the core read.
    const sinceArg = (): number | undefined => {
      const raw = one('--since');
      if (raw === undefined) return undefined;
      const ms = parseSince(raw);
      if (ms === null) throw new UsageError('--since takes 15m, 2h, 1d, epoch ms or an ISO time.');
      return ms;
    };
    // --before is the exclusive upper bound on the same updatedAt field
    // --since bounds inclusively below — the feed's [since, before) window
    // and its older-page bound past the newest-first --limit cap.
    const beforeArg = (): number | undefined => {
      const raw = one('--before');
      if (raw === undefined) return undefined;
      const ms = parseSince(raw);
      if (ms === null) throw new UsageError('--before takes 15m, 2h, 1d, epoch ms or an ISO time.');
      return ms;
    };
    const [verb, sub, arg, ...extra] = p.positionals;
    const finish = (result: { status: string; reason?: string }, human: string): number => {
      const ok = !('reason' in result) || result.reason === undefined;
      out(json ? JSON.stringify(result) : ok ? human : `${result.status}: ${result.reason}`);
      return ok ? 0 : 1;
    };
    const noExtra = (count: number): void => {
      if (p.positionals.length > count) throw new UsageError('Unexpected operand.');
    };

    if (verb === 'status') {
      noExtra(1);
      const result = readUnifiedBusStatus(options);
      if (json) { out(JSON.stringify(result)); return 0; }
      const unknown = 'unknown';
      out([
        `store ${result.store.source} retained=${result.store.retainedCount ?? unknown}/${result.store.maxMessages} ` +
          `bytes=${result.store.retainedBytes ?? unknown}/${result.store.maxBytes} ` +
          `live=${result.store.liveCount ?? unknown} expired=${result.store.expiredCount ?? unknown}`,
        `registry ${result.registry.source} identities=${result.registry.identities ?? unknown} channels=${result.registry.channels ?? unknown}`,
        `wakes ${result.wakes.state} hints=${result.wakes.hints ?? unknown} truncated=${result.wakes.truncated ?? unknown}`,
        `coordination ${result.coordination.source} liveClaims=${result.coordination.liveClaims ?? unknown} statuses=${result.coordination.statuses ?? unknown}`,
        `workClaims ${result.workClaims.source} claims=${result.workClaims.claims ?? unknown}`,
        `claimDrift ${result.claimDrift.state} matched=${result.claimDrift.matched ?? unknown} ` +
          `busOnly=${result.claimDrift.busOnly ?? unknown} coordOnly=${result.claimDrift.coordOnly ?? unknown} ` +
          `ownerMismatch=${result.claimDrift.ownerMismatch ?? unknown}`,
        `feed ${result.feed.status}${result.feed.reason === undefined ? '' : `:${result.feed.reason}`} jobs=${result.feed.jobs ?? unknown}`,
        `mailbox ${result.mailbox.source} pending=${result.mailbox.pending ?? unknown}`,
        `ownerChat ${result.ownerChat.source} receipts=${result.ownerChat.receipts ?? unknown}`,
        `board ${result.board.source} threads=${result.board.threads ?? unknown} ` +
          `tasks=${result.board.tasks ?? unknown} pending=${result.board.pendingDeliveries ?? unknown} ` +
          `claims=${result.board.claims ?? unknown}`,
        `seats ${result.seats.source} seats=${result.seats.seats ?? unknown} ` +
          `states=${result.seats.states ?? unknown} handoffs=${result.seats.handoffs ?? unknown} ` +
          `notices=${result.seats.notices ?? unknown}`,
        `peerDispatch ${result.peerDispatch.source} receipts=${result.peerDispatch.receipts ?? unknown} ` +
          `unpublished=${result.peerDispatch.unpublished ?? unknown}`,
        `peerLedger ${result.peerLedger.source} liveRows=${result.peerLedger.liveRows ?? unknown}`,
        `sendGate ${result.sendGate.state} kill=${result.sendGate.kill.state}:${result.sendGate.kill.reason} ` +
          `pause=${result.sendGate.pause.state}` +
          `${result.sendGate.pause.reason === null ? '' : `:${result.sendGate.pause.reason}`}` +
          `${result.sendGate.pause.since === null ? '' : ` since=${result.sendGate.pause.since}`}`,
        `as-of=${result.asOf}`,
      ].join('\n'));
      return 0;
    }
    if (verb === 'adapters') {
      noExtra(1);
      const adapters = listBusCliAdapters();
      out(json ? JSON.stringify({ adapters }) : adapters.map(a =>
        `${a.cli.padEnd(7)} providers=${a.providers.join(',')} engine=${a.engine?.entry ?? 'session'}  ${a.note}`).join('\n'));
      return 0;
    }
    if (verb === 'id' && sub === 'list') {
      noExtra(2);
      const read = readAgentRegistry(options);
      if (read.status !== 'ok') return finish(read, '');
      const participants = await seatParticipants();
      const lines = [
        ...read.registry.identities.map(i => `${i.handle.padEnd(16)} ${i.id}  runtimes=${i.runtimes.map(r => `${r.cli}/${r.provider}${r.model ? `/${r.model}` : ''}`).join(',') || '-'}${i.aliases.length ? `  aliases=${i.aliases.join(',')}` : ''}`),
        ...participants.map(p => `${p.participantId.padEnd(16)} ${p.provider}  seat=${p.status}`),
      ];
      out(json ? JSON.stringify({ status: 'ok', identities: read.registry.identities, channels: read.registry.channels, participants })
        : lines.join('\n') || 'No identities registered.');
      return 0;
    }
    if (verb === 'id' && sub === 'register') {
      noExtra(3);
      const cli = one('--cli');
      if (cli !== undefined && !(BUS_CLIS as readonly string[]).includes(cli)) throw new UsageError(`--cli must be one of ${BUS_CLIS.join(', ')}.`);
      const aliases = p.values.get('--alias') ?? [];
      const displayName = one('--display');
      const handle = arg ?? self;
      if (!handle) throw new UsageError('A handle or PHM_AGENT_ID is required.');
      const runtime = cli !== undefined || one('--model') !== undefined || one('--provider') !== undefined || detectBusCli(env) !== null;
      const result = runtime
        ? attachBusCliSession({ handle, cli: cli as BusCli | undefined, provider: one('--provider') as BusProvider | undefined,
          model: one('--model'), aliases, displayName }, env, options)
        : registerAgentIdentity({ handle, aliases, displayName }, options);
      return finish(result, 'identity' in result ? `${result.status}: ${result.identity.handle} ${result.identity.id}` : '');
    }
    if (verb === 'id' && sub === 'show') {
      noExtra(3);
      const result = busAgentView(arg, env, options);
      if (result.status !== 'ok') return finish(result, '');
      const runtimes = result.identity.runtimes
        .map(r => `${r.cli}/${r.provider}${r.model ? `/${r.model}` : ''}`).join(',') || '-';
      // displayName is stored text: control characters flatten before it reaches a line.
      // eslint-disable-next-line no-control-regex
      const display = result.identity.displayName.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
      out(json ? JSON.stringify(result) : [
        `${result.identity.handle} ${result.identity.id} ${result.address}` +
          (result.self ? ` cli=${result.cli ?? '-'}` : ''),
        `  display=${display === '' ? '-' : display} created=${new Date(result.identity.createdAt).toISOString()}`,
        `  runtimes=${runtimes}`,
        ...(result.identity.aliases.length ? [`  aliases=${result.identity.aliases.join(',')}`] : []),
        `  channels=${result.channels.join(',') || '-'}`,
      ].join('\n'));
      return 0;
    }
    if (verb === 'dm') {
      noExtra(1);
      const result = await sendDirectMessage({ ...send, from: actor('--from'), to: required('--to'), text: required('--text'),
        kind: bodyKindArg(), thread: one('--thread'), refs: p.values.get('--ref'), replyTo: one('--reply-to') }, options);
      return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
    }
    if (verb === 'post') {
      noExtra(1);
      const result = await postLabelMessage({ ...send, from: actor('--from'), to: required('--to'), text: required('--text'),
        kind: bodyKindArg(), thread: one('--thread'), refs: p.values.get('--ref'),
        replyTo: one('--reply-to') }, options);
      return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
    }
    if (verb === 'channel' && sub === 'list') {
      noExtra(2);
      const result = listBusChannels(one('--agent'), options);
      if (result.status !== 'ok') return finish(result, '');
      out(json ? JSON.stringify(result) : [
        ...result.channels.map(c => `#${c.name}  members=${c.members.join(',') || '-'}  createdBy=${c.createdBy}  createdAt=${new Date(c.createdAt).toISOString()}`),
        `channels=${result.channels.length} source=${result.source}${result.agent === null ? '' : ` agent=${result.agent}`}`,
      ].join('\n'));
      return 0;
    }
    if (verb === 'channel' && arg !== undefined && extra.length === 0) {
      if (sub === 'create') {
        const result = createAgentChannel({ name: arg, createdBy: actor('--from'), members: p.values.get('--member') ?? [] }, options);
        return finish(result, 'channel' in result ? `${result.status}: #${result.channel.name} ${result.channel.members.join(',')}` : '');
      }
      if (sub === 'join' || sub === 'leave') {
        const result = (sub === 'join' ? joinAgentChannel : leaveAgentChannel)(arg, actor('--agent'), options);
        return finish(result, 'channel' in result ? `${result.status}: #${result.channel.name} ${result.channel.members.join(',')}` : '');
      }
      if (sub === 'post') {
        const result = await postChannelMessage({ ...send, from: actor('--from'), channel: arg, topic: one('--topic'),
          text: required('--text'), kind: bodyKindArg(), thread: one('--thread'), refs: p.values.get('--ref'),
          replyTo: one('--reply-to') }, options);
        return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
      }
      if (sub === 'read') {
        const frame = one('--frame');
        if (frame !== undefined && !(BUS_CLIS as readonly string[]).includes(frame)) throw new UsageError(`--frame must be one of ${BUS_CLIS.join(', ')}.`);
        const result = readAgentChannel(arg, { topic: one('--topic'), from: one('--from'), excludeFrom: one('--exclude-from'),
          thread: one('--thread'), priority: priorityArg(), job: one('--job'), since: sinceArg(), before: beforeArg(),
          contains: one('--contains'), inReplyTo: one('--in-reply-to'), id: one('--id'), bodyKind: one('--body-kind'),
          result: resultArg(),
          matched: p.bools.has('--matched'),
          after: integer(one('--after'), '--after'), limit: integer(one('--limit'), '--limit') }, options);
        if (result.status !== 'ok') return finish(result, '');
        // --matched scans the whole store, so the core nextCursor is the store's
        // end — resuming there would skip unshown matches. The honest resume
        // point is the newest shown row's cursor (the same rule inbox applies).
        const nextCursor = busPageResumeCursor(result);
        const shown = { ...result, nextCursor };
        if (frame) { out(json ? JSON.stringify({ ...shown, framed: frameBusChannelRead(frame as BusCli, shown.channel, result.messages) }) : frameBusChannelRead(frame as BusCli, shown.channel, result.messages)); return 0; }
        out(json ? JSON.stringify(shown) : [
          ...shown.messages.map(m => `${m.cursor} ${m.priority} #${shown.channel}:${m.topic} ${m.envelope.id} from ${m.fromAgent ?? m.envelope.from}` +
            (m.held === undefined ? '' : ` held=${m.held === null ? 'unknown' : m.held ? 'yes' : 'no'}` +
              (m.holder ? ` holder=${m.holder}` : '')) +
            (m.job === undefined ? '' : ` ${busInboxJobMarker(m.job)}`)),
          ...(result.matched === undefined ? [] : [`matched ${result.matched}`]),
          `nextCursor ${nextCursor}`,
        ].join('\n'));
        return 0;
      }
    }
    if (verb === 'handoff') {
      noExtra(1);
      const result = await sendHandoff({ ...send, from: actor('--from'), to: required('--to'), taskId: required('--task'),
        prompt: required('--prompt') }, options);
      return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
    }
    if (verb === 'wake') {
      noExtra(1);
      if (p.bools.has('--wake') || p.bools.has('--no-wake')) {
        throw new UsageError('wake always records its hint; --wake and --no-wake do not apply.');
      }
      const result = await sendWakeRequest({ ...send, from: actor('--from'), to: required('--to'),
        reason: required('--reason'), jobId: one('--job') }, options);
      return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
    }
    if (verb === 'inbox') {
      noExtra(2);
      const frame = one('--frame');
      if (frame !== undefined && !(BUS_CLIS as readonly string[]).includes(frame)) throw new UsageError(`--frame must be one of ${BUS_CLIS.join(', ')}.`);
      const agent = sub ?? self;
      if (!agent) throw new UsageError('An agent or PHM_AGENT_ID is required.');
      const page = readAgentInbox(agent, { after: integer(one('--after'), '--after'), limit: integer(one('--limit'), '--limit'),
        thread: one('--thread'), from: one('--from'), excludeFrom: one('--exclude-from'), with: one('--with'), priority: priorityArg(),
        kind: kindArg(), job: one('--job'), since: sinceArg(), before: beforeArg(), channel: one('--channel'),
        contains: one('--contains'), inReplyTo: one('--in-reply-to'), id: one('--id'), bodyKind: one('--body-kind'),
        result: resultArg(),
        matched: p.bools.has('--matched') }, options);
      if (page.status !== 'ok') return finish(page, '');
      // --matched scans the whole store, so the core nextCursor is the store's
      // end — resuming there would skip unshown matches. The honest resume
      // point is the newest shown row's cursor: every unshown match sits
      // beyond it and every shown one at or before it (the same rule the
      // work mine inbox section applies).
      const nextCursor = busPageResumeCursor(page);
      const shown = { ...page, nextCursor };
      if (frame) { out(json ? JSON.stringify({ ...shown, framed: frameBusInbox(frame as BusCli, page.messages) }) : frameBusInbox(frame as BusCli, page.messages)); return 0; }
      out(json ? JSON.stringify(shown) : [
        ...shown.messages.map(m => `${m.cursor} ${m.priority} ${m.kind === 'channel' ? `#${m.channel}` : m.kind} ${m.envelope.id} from ${m.fromAgent ?? m.envelope.from}` +
          (m.held === undefined ? '' : ` held=${m.held === null ? 'unknown' : m.held ? 'yes' : 'no'}` +
            (m.holder ? ` holder=${m.holder}` : '')) +
          (m.job === undefined ? '' : ` ${busInboxJobMarker(m.job)}`)),
        ...(page.matched === undefined ? [] : [`matched ${page.matched}`]),
        `nextCursor ${nextCursor}`,
      ].join('\n'));
      return 0;
    }
    if (verb === 'show') {
      noExtra(2);
      if (sub === undefined) throw new UsageError('A message id is required.');
      const result = readBusEnvelopeById(sub, options);
      if (result.status !== 'ok') {
        if (result.status === 'not-found') {
          out(json ? JSON.stringify(result) : `not-found: ${result.id}`);
          return 1;
        }
        return finish(result, '');
      }
      const m = result.message;
      out(json ? JSON.stringify(result) : [
        `${m.cursor} ${m.envelope.priority} ${m.envelope.id} from ${m.fromAgent ?? m.envelope.from} -> ${m.envelope.to}`,
        `  ${busBodyFallbackSummary(m.envelope.body)}`,
        ...(result.held === undefined ? [] : [`  held=${result.held === null ? 'unknown' : result.held ? 'yes' : 'no'}` +
          (result.holder ? ` holder=${result.holder}` : '')]),
        ...(result.wakeHint === undefined ? [] : [`  via claim-holder wake hint ${result.id}` +
          ` to=${result.wakeHint.to} job=${result.wakeHint.jobId} status=${result.wakeHint.status}`]),
        ...(result.job === undefined ? [] : [showJobLine(result.job)]),
      ].join('\n'));
      return 0;
    }
    if (verb === 'wakes') {
      noExtra(2);
      const filter = { job: one('--job'), from: one('--from'), excludeFrom: one('--exclude-from'),
        channel: one('--channel'), contains: one('--contains'), priority: priorityArg(), before: beforeArg(), id: one('--id'),
        thread: one('--thread'), inReplyTo: one('--in-reply-to'), bodyKind: one('--body-kind'), result: resultArg() };
      const since = sinceArg();
      let page: WakePage | AllWakesPage;
      if (p.bools.has('--all')) {
        if (sub !== undefined) throw new UsageError('wakes --all lists every wake hint and takes no agent.');
        page = readAllWakes(since, options, filter);
      } else {
        const agent = sub ?? self;
        if (!agent) throw new UsageError('An agent or PHM_AGENT_ID is required.');
        page = readAgentWakes(agent, since, options, filter);
      }
      if (page.status !== 'ok') return finish(page, '');
      out(json ? JSON.stringify(page) : [
        ...(page.truncated ? [`${page.matched} wake hint(s) matched; the bounded queue tail is truncated — showing the newest ${page.wakes.length}`] : []),
        ...page.wakes.map(w => `${w.at} ${w.id} ${w.from} -> ${w.to}` + agentWakeClaimHolderSuffix(w) + agentWakeMessageSuffix(w)),
      ].join('\n') || 'No wakes.');
      return 0;
    }
    if (verb === 'work' && sub === 'feed') {
      noExtra(2);
      const status = one('--status');
      if (status !== undefined && !(WORK_STATUSES as readonly string[]).includes(status)) {
        throw new UsageError(`--status must be one of ${WORK_STATUSES.join(', ')}.`);
      }
      const labelArg = (flag: string): string | undefined => {
        const value = one(flag);
        if (value !== undefined && !/^[\x21-\x7e]{1,128}(?![\s\S])/.test(value)) {
          throw new UsageError(`${flag} must be a printable routing label of 1-128 characters.`);
        }
        return value;
      };
      const to = labelArg('--to'), owner = labelArg('--owner'), jobId = labelArg('--job');
      const repoRaw = one('--repo');
      const repo = repoRaw === undefined ? undefined : busWorkFeedRepoKey(repoRaw);
      if (repoRaw !== undefined && repo === undefined) {
        throw new UsageError('--repo must be an owner/name repo slug.');
      }
      const providerRaw = one('--provider');
      if (providerRaw !== undefined && !providerSchema.safeParse(providerRaw).success) {
        throw new UsageError(`--provider must be one of ${PROVIDERS.join(', ')}.`);
      }
      const tierRaw = one('--tier');
      const tier = tierRaw === undefined ? undefined : WORK_TIERS.find(item => item === tierRaw);
      if (tierRaw !== undefined && tier === undefined) {
        throw new UsageError(`--tier must be one of ${WORK_TIERS.join(', ')}.`);
      }
      const channel = one('--channel');
      if (channel !== undefined && !agentChannelNameSchema.safeParse(channel).success) {
        throw new UsageError('--channel takes a bus channel name (a-z, 0-9, _ -; 1-32 chars).');
      }
      const contains = one('--contains');
      if (contains !== undefined && (contains.trim() === '' || contains.length > BUS_WORK_FEED_CONTAINS_MAX)) {
        throw new UsageError(`--contains takes a non-empty search text of at most ${BUS_WORK_FEED_CONTAINS_MAX} characters.`);
      }
      const resultOutcome = resultArg();
      const limitRaw = one('--limit');
      const limit = limitRaw === undefined ? undefined : integer(limitRaw, '--limit');
      if (limit !== undefined && (limit < 1 || limit > BUS_WORK_FEED_LIMIT_MAX)) {
        throw new UsageError(`--limit must be an integer from 1 to ${BUS_WORK_FEED_LIMIT_MAX}.`);
      }
      const claimable = p.bools.has('--claimable');
      const open = p.bools.has('--open');
      const result = projectBusWorkFeedView(
        readBusWorkFeed({ root: options.root, claims: p.bools.has('--claims') || claimable || open }),
        { status: status as WorkJob['status'] | undefined, jobId, repo,
          provider: providerRaw as WorkJob['provider'] | undefined, tier,
          open: open || undefined, claimable: claimable ? true : undefined, since: sinceArg(), before: beforeArg(), contains, channel, result: resultOutcome,
          toMatch: to === undefined ? undefined : busWorkFeedPendingToMatcher(to, { root: options.root }),
          ownerMatch: owner === undefined ? undefined : busWorkFeedOwnerMatcher(owner, { root: options.root }) });
      const paged = limit === undefined ? result : sliceBusWorkFeedView(result, limit);
      out(json ? JSON.stringify(paged) : formatBusWorkFeed(paged).join('\n'));
      return paged.status === 'ok' ? 0 : 1;
    }
    if (verb === 'work' && sub === 'claim') {
      noExtra(2);
      const owner = one('--owner') ?? self;
      if (!owner) throw new UsageError('--owner is required when PHM_AGENT_ID is not set.');
      const leaseMs = integer(one('--lease-ms'), '--lease-ms');
      if (leaseMs === undefined) throw new UsageError('--lease-ms is required.');
      const key = one('--key');
      if (key !== undefined && parseClaimKey(key) === undefined) {
        throw new UsageError('--key must be a v2 claim key (repo:, path:, queue: or pr:).');
      }
      const opId = one('--id');
      const result = claimBusWorkJob({ job: required('--job'), owner, leaseMs, root: options.root,
        ...(key === undefined ? {} : { key }), ...(opId === undefined ? {} : { id: opId }) });
      out(json ? JSON.stringify(result) : workJobClaimHuman(result));
      return workJobClaimExitCode(result);
    }
    if (verb === 'work' && sub === 'mine') {
      noExtra(3);
      const agent = arg ?? self;
      if (!agent) throw new UsageError('An agent or PHM_AGENT_ID is required.');
      const job = one('--job');
      const contains = one('--contains');
      const since = sinceArg();
      const before = beforeArg();
      const priority = priorityArg();
      const channel = one('--channel');
      if (channel !== undefined && !agentChannelNameSchema.safeParse(channel).success) {
        throw new UsageError('--channel takes a bus channel name (a-z, 0-9, _ -; 1-32 chars).');
      }
      const senderArg = (flag: '--from' | '--exclude-from'): string | undefined => {
        const value = one(flag);
        if (value !== undefined && !/^[\x21-\x7e]{1,128}(?![\s\S])/.test(value)) {
          throw new UsageError(`${flag} must be a printable routing label of 1-128 characters.`);
        }
        return value;
      };
      const from = senderArg('--from');
      const excludeFrom = senderArg('--exclude-from');
      const id = one('--id');
      const inReplyTo = one('--in-reply-to');
      const bodyKind = one('--body-kind');
      const result = await readBusWorkMineWithSeats(agent,
        { ...options, ...(job === undefined ? {} : { job }),
          ...(contains === undefined ? {} : { contains }),
          ...(since === undefined ? {} : { since }),
          ...(before === undefined ? {} : { before }),
          ...(priority === undefined ? {} : { priority }),
          ...(channel === undefined ? {} : { channel }),
          ...(from === undefined ? {} : { from }),
          ...(excludeFrom === undefined ? {} : { excludeFrom }),
          ...(id === undefined ? {} : { id }),
          ...(inReplyTo === undefined ? {} : { inReplyTo }),
          ...(bodyKind === undefined ? {} : { bodyKind }) });
      if (result.status !== 'ok') {
        out(json ? JSON.stringify(result) : `${result.status}: ${result.reason}`);
        return 2;
      }
      out(json ? JSON.stringify(result) : formatBusWorkMine(result).join('\n'));
      return 0;
    }
    if (verb === 'work' && sub === 'next') {
      noExtra(3);
      const agent = arg ?? self;
      if (!agent) throw new UsageError('An agent or PHM_AGENT_ID is required.');
      const owner = one('--owner') ?? self ?? agent;
      const leaseMs = integer(one('--lease-ms'), '--lease-ms');
      if (leaseMs === undefined) throw new UsageError('--lease-ms is required.');
      const channel = one('--channel');
      if (channel !== undefined && !agentChannelNameSchema.safeParse(channel).success) {
        throw new UsageError('--channel takes a bus channel name (a-z, 0-9, _ -; 1-32 chars).');
      }
      const senderArg = (flag: '--from' | '--exclude-from'): string | undefined => {
        const value = one(flag);
        if (value !== undefined && !/^[\x21-\x7e]{1,128}(?![\s\S])/.test(value)) {
          throw new UsageError(`${flag} must be a printable routing label of 1-128 characters.`);
        }
        return value;
      };
      const result = claimNextBusWork({ to: agent, owner, leaseMs, root: options.root,
        contains: one('--contains'), since: sinceArg(), before: beforeArg(), priority: priorityArg(),
        channel, from: senderArg('--from'), excludeFrom: senderArg('--exclude-from') });
      out(json ? JSON.stringify(result) : workNextHuman(result, owner));
      return result.status === 'acquired' || result.status === 'empty' ? 0 :
        result.status === 'invalid' ? 2 : 1;
    }
    if (verb === 'work' && (sub === 'post' || sub === 'status')) {
      noExtra(2);
      const from = actor('--from');
      const routed = { ...send, from, to: one('--to') };
      if (sub === 'post') {
        const tier = one('--tier'), scope = one('--scope'), acceptance = one('--acceptance');
        if ([tier, scope, acceptance].some(value => value !== undefined) &&
            [tier, scope, acceptance].some(value => value === undefined)) {
          throw new UsageError('--tier, --scope and --acceptance are required together.');
        }
        if (tier !== undefined && !(WORK_TIERS as readonly string[]).includes(tier)) {
          throw new UsageError(`--tier must be one of ${WORK_TIERS.join(', ')}.`);
        }
        const result = await announceWork({ ...routed, jobId: required('--job'), title: required('--title'),
          repo: required('--repo'), claimKeys: p.values.get('--claim') ?? [],
          provider: one('--provider') as BusProvider | undefined,
          dispatch: tier === undefined ? undefined : { tier: tier as WorkDispatch['tier'],
            scope: scope!, acceptance: acceptance! } }, options);
        return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
      }
      const status = required('--status');
      if (!(WORK_STATUSES as readonly string[]).includes(status)) {
        throw new UsageError(`--status must be one of ${WORK_STATUSES.join(', ')}.`);
      }
      const result = await updateWorkStatus({ ...routed, jobId: required('--job'),
        status: status as WorkStatusInput['status'], detail: one('--detail') }, options);
      const holders = 'id' in result ? result.claimHoldersWoken : undefined;
      const holderNote = holders === undefined ? '' :
        ` claim-holders=${holders === null ? 'unknown' : holders}`;
      return finish(result, 'id' in result ?
        `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})${holderNote}` : '');
    }
    if (verb === 'claim') {
      if (sub === 'message') {
        noExtra(3);
        const action = arg;
        if (action === undefined || !(MESSAGE_CLAIM_ACTIONS as readonly string[]).includes(action)) {
          throw new UsageError('claim message requires acquire, renew, release or complete.');
        }
        const id = required('--id');
        let request: BusClaimRequest;
        if (action === 'acquire') {
          const owner = one('--owner') ?? self;
          if (!owner) throw new UsageError('--owner is required when PHM_AGENT_ID is not set.');
          const leaseMs = integer(one('--lease-ms'), '--lease-ms');
          if (leaseMs === undefined) throw new UsageError('--lease-ms is required.');
          request = { action, id, owner, leaseMs, root: options.root };
        } else {
          request = { action: action as BusClaimRequest['action'], id, token: required('--token'), root: options.root };
        }
        const result = mutateBusWorkClaim(request);
        out(json ? JSON.stringify({ ...result, id }) : messageClaimHuman(result, id));
        return MESSAGE_CLAIM_OK.has(result.status) ? 0 : result.status === 'invalid' ? 2 : 1;
      }
      noExtra(2);
      if (sub === 'list') {
        const result = listBusClaims({ root: options.root, key: one('--key'), owner: one('--owner'),
          excludeOwner: one('--exclude-owner'), contains: one('--contains'), origin: originArg(),
          since: sinceArg(), before: beforeArg(), jobs: p.bools.has('--jobs') });
        if (result.status === 'invalid') {
          out(json ? JSON.stringify(result) : 'invalid: --key must be a v2 claim key (repo:, path:, queue: or pr:); --owner and --exclude-owner must be printable labels; --origin must be resource, message, team or board; --contains must be non-empty text of at most 512 characters; --since and --before must resolve to non-negative epoch-ms cutoffs');
          return 2;
        }
        if (result.status !== 'ok') {
          out(json ? JSON.stringify(result) : `${result.status} claims=unknown as-of=${result.asOf}`);
          return 1;
        }
        const ownerNote = result.owner === undefined ? '' :
          ` owner=${result.owner.ref} identity=${result.owner.identity ?? 'label'} registry=${result.owner.registry}`;
        const excludeNote = result.excludeOwner === undefined ? '' :
          ` excludeOwner=${result.excludeOwner.ref} identity=${result.excludeOwner.identity ?? 'label'} registry=${result.excludeOwner.registry}`;
        const feedNote = result.feed === undefined ? '' : ` feed=${result.feed}`;
        out(json ? JSON.stringify(result) : [
          ...result.claims.map(row => {
            const base = `${row.key} owner=${row.owner} origin=${row.origin} until=${new Date(row.leaseUntil).toISOString()} source=${row.sourceId}`;
            if (result.feed === undefined) return base;
            if (result.feed !== 'ok') return `${base} jobs=unknown`;
            const blocked = row.jobs ?? [];
            return `${base} jobs=${blocked.length === 0 ? 'none' : blocked.map(claimJobLabel).join(',')}`;
          }),
          `claims=${result.claims.length} source=${result.source}${ownerNote}${excludeNote}${feedNote} as-of=${result.asOf}`,
        ].join('\n'));
        return 0;
      }
      const claimKey = required('--key');
      const leaseMsRaw = one('--lease-ms');
      const leaseMs = leaseMsRaw === undefined ? undefined : integer(leaseMsRaw, '--lease-ms');
      let body: Record<string, unknown>;
      if (sub === 'acquire') {
        const owner = one('--owner') ?? self;
        if (!owner) throw new UsageError('--owner is required when PHM_AGENT_ID is not set.');
        if (leaseMs === undefined) throw new UsageError('--lease-ms is required.');
        body = { kind: 'work.claim', op: 'acquire', claimKey, owner, leaseMs };
      } else if (sub === 'renew') {
        if (leaseMs === undefined) throw new UsageError('--lease-ms is required.');
        body = { kind: 'work.claim', op: 'renew', claimKey, token: required('--token'), leaseMs };
      } else if (sub === 'release') {
        body = { kind: 'work.release', claimKey, token: required('--token'), outcome: required('--outcome') };
      } else {
        throw new UsageError('claim requires acquire, renew, release or list.');
      }
      const result: BusClaimResult = executeBusClaimBody(body, one('--id') ?? newBusClaimOpId(), { root: options.root })
        ?? { v: 2, status: 'invalid' };
      out(json ? JSON.stringify(result) : claimHuman(result));
      return busClaimExitCode(result);
    }
    throw new UsageError('Unknown agents bus command.');
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(json ? JSON.stringify({ error: 'invalid-argument', reason: error.message }) : `${error.message}\n${AGENTS_BUS_UNIFIED_HELP}`);
    return 2;
  }
}
