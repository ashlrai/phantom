# RQ-AGENTNET-PEERBUS-1: authenticated team peers

`src/core/agentnet/peer-bus.ts` owns `PeerRequest`, `PeerBusOptions`, `PeerResult`,
`peerRequestSchema`, `sendPeerMessage(input: unknown, session: PeerSession, options?: PeerBusOptions)`
and `readPeerInbox(session: PeerSession, after?: number, options?: PeerBusOptions)`.
`slack-identities.ts` owns `PeerBinding`, `PeerSession`, `readPeerBindings`,
`authenticatePeer`, `listPeers`, and `proposeSlackAction`; `cos/peer-plan.ts` owns
`cosPeerPlanSchema` and `emitCosPeerPlan`. None grants execution or spending authority.

Requests contain exactly one of `toAgent` (callsign) or `channel` (C/G Slack ID),
`kind: task|review|handoff|query|social`, `text` (1–12000 chars), optional `refs`
(max 32), `threadId`, and `replyTo`. Directed tasks may carry optional `work`
validated by `workPostBodySchema` or `workStatusBodySchema`; this becomes the
authenticated bus body and uses the same audience, enrollment and rate gates.
Because the body joins the shared work-feed projection — which refuses its
whole read on an unattributable provider, a duplicate job id, or a foreign
owner's status — the send verifies the live feed first: a `work.post` proposal
must name `provider` or resolve one through the sender callsign's registered
identity runtime and its `jobId` must not already be announced; a `work.status`
must name a job the feed shows and only its owner — by label or shared
registered identity, the projection's own rule — may move it. An unreadable
feed refuses the send (`work-provider-required`, `work-job-exists`,
`work-job-unknown`, `work-status-not-owner`, `work-feed-<status>`). The bounded
queue consumer
and result contract are defined in [CONTRACT.md](../../CONTRACT.md#bounded-peer-work-dispatch-rq-agentnet-dispatch-1).
The service derives sender, ID, origin and hops.
The existing bus stores `{kind: "peer.message", peer: {fromAgent, toAgent|channel,
kind, text, refs, threadId, origin, hopCount}}`, addressed to the callsign or mapped
channel topic. `peers read` checks private admission digests: raw bus labels,
Slack notes and A2A opt-in metadata cannot authenticate a peer. Claims stay in
the existing coordination table; replies must carry the preceding message's ID.
`work.result` replies bypass that ledger, so the read also admits an envelope
only when the private `agentnet/work-dispatch.json` journal proves this host
published that exact outcome body to the caller's callsign; only the latest
sent outcome per receipt is admitted and earlier replies stay bus-local. Every
read reports `workResults: missing|available|unavailable` for that journal —
missing means dispatch never ran, unavailable means results are unknown, not
absent.

`agentnet/peer-inbox.ts` owns `PeerInboxMessage`, `PEER_MESSAGE_KINDS`,
`PeerInboxFilterInput`, `PeerInboxFilters`, `parsePeerInboxFilters(input, now?)`
and `peerInboxMessageMatches(message, filters)`. `phm agentnet peers read`
accepts the optional filters `--from`, `--exclude-from`, `--to`, `--since`,
`--before`, `--contains`, `--id`, `--kind`, `--body-kind`, `--priority`,
`--peer-kind`, `--thread` (the
same flag `send` uses to stamp a thread), `--job` and `--result`; they parse
through `parsePeerInboxFilters` — the same printable-label bound, `parseSince`
time grammar, `busReadContains` needle, `BUS_PRIORITIES` band and
`WORK_RESULT_OUTCOMES` enum every
other bus read applies — and narrow only the admitted page
`peerInboxMessageMatches` returns. `from`/`excludeFrom`/`to` compare the
envelope's own callsign/topic labels verbatim and never resolve through the
agent registry; `kind` is the exact `busBodyKind` discriminator — `--body-kind`
is the shared bus reads' spelling of the same filter and the two flags must
agree when both appear — `priority` the exact P0..P3 envelope band,
`peerKind`
the inner kind of a `peer.message` body only, `thread` the `peer.message`
payload's `threadId` or a note/context body's `thread`, `job` the shared
`busBodyJobMatch` citation and `result` the `work.result` outcome. Filters are
a read convenience applied after admission: they never admit an envelope the
ledger or journal refused, and `nextCursor` still advances over every scanned
row, so a filtered read is a view of the page, not a subscription. Every
other `agentnet` verb refuses the read-only flags.

`agentnet/mesh-read.ts` owns `PeerWorkFeedQuery` and
`readPeerFleet(view: 'mesh' | 'work-feed', session: PeerSession, options?: PeerBusOptions, feed?: PeerWorkFeedQuery)`.
Both views still require a live peer session and write nothing.
`phm agentnet peers work-feed` accepts the same query every other work-feed
surface validates — the `parseBusWorkFeedQuery` contract `phm fleet
work-feed`, `phm agents bus work feed`, `GET /api/verse/agent-bus/work-feed`
and `fleet_work_feed` share: `--claims`, `--open`, `--claimable`, `--status`,
`--job`, `--repo`, `--provider`, `--tier`, `--to`, `--owner`, `--channel`,
`--result`, `--id`, `--since`, `--before`, `--contains` and `--limit`,
alongside the read-filter names it shares (`--to`, `--since`, `--before`,
`--contains`, `--id`, `--job`, `--result`). The parsed query applies the
`projectBusWorkFeedView` filters and the `sliceBusWorkFeedView` page bound to
the same `readBusWorkFeed` projection, so a peer's filtered feed can never
disagree with the local surfaces about what a value means; the claims join
rides `--claims`/`--open`/`--claimable` exactly like the other readers.
`peers mesh` takes no query — passing one throws — `peers read` and every
other verb refuse the feed-only flags, and the read-only peer-inbox filters
(`--from`, `--exclude-from`, `--kind`, `--body-kind`, `--priority`,
`--peer-kind`) stay refused on
`work-feed`: the feed query has no sender, kind or thread dimension.

Host-owned `~/.ashlr/agentnet/bindings.json` is a private 0600 strict JSON object
`{version:1, peers:[]}` (max 128). Each binding has `callsign`, `lane`, `sessionId`,
`sessionHash`, `expiresAt` (epoch ms), `teamId`, `userId`, `botId`, `topic`.
The hash is SHA-256 of JSON `[lane, sessionId, token]`; matching is constant-time.
Callsigns, bot IDs, user IDs and digests must be unique. The trusted launcher supplies
`PHM_AGENTNET_LANE`, `PHM_AGENTNET_SESSION_ID`, `PHM_AGENTNET_SESSION_TOKEN`
(32–512 chars). Expired sessions fail closed. Tokens never enter results or logs.
Agent sandboxes must deny writes to this enrollment file and the launcher.

Registration creates a stable callsign/display-name **draft**, never a bot or session.
Channel proposals preview by default; `--apply` records a private-channel draft.
Actual distinct bots, profiles, channels and host session enrollment require a
separate `[SECURITY REVIEW]` provisioner without auto-merge. No credential resolver,
Slack scope, app-creation API, launcher change or live installation is added here.
The existing `configuredSlackCall` owns credential custody; its host-injected bot
must pass `auth.test` against the enrolled IDs. Username overrides are never used.

Only explicitly mapped, completely observed team channels qualify. DMs, shared,
pending-shared, guest and unknown audiences are refused. Both addressed agents
must be members. Every post uses `deliverSlackEnvelope`, its intent receipts,
fresh audience checks, `comms.toml` `confirmedByMason`, and a policy/session reload.
KILL and comms pause block writes. The generic drain refuses `peer.message`;
only the authenticated path adapts it to a scrubbed JSON note. Local `posted`
is distinct from `slack: sent|refused|uncertain`; inspect uncertainty before starting
a new request. Drafts are never automatically replayed or treated as provisioning authority.

Replies inherit recorded origin/thread/hops. Repeating a directed pair under one
origin or attempting hop 9 creates a deduplicated bus escalation and needs-you item.
Six messages per directed pair per minute are permitted; broadcasts debit every
enrolled recipient. Locked metadata reservations precede publication, retain 24 hours,
and cap at 1024 rows. Corruption, contention and reversed clocks fail closed.
The ledger holds body digests, never bodies/tokens; crashes may consume capacity.
Text uses the shared scrub.pl-aligned scrubber before persistence/posting; secret-shaped
references are refused. Use `phm_` secret names only; nothing resolves them.

CoS opts in through host-supplied `CosWorkOptions.peerPlan`. Strict model JSON
`{reply, peers}` carries at most eight requests through the same authenticated path.
The owner reply remains approval-bound; `peerMessages` and a bus plan receipt record
outcomes. Without opt-in the existing plain-text worker is unchanged.
`emitCosPeerPlanOnce(plan, rootId, ctx)` is the bounded path the worker and
`phm fleet cos-loop --peer-plan` use: dry-run unless `apply`; `halted` under KILL/pause;
`no-identities` without live bindings; direct requests to live same-team peers only
(channels and unregistered callsigns are dropped); optional `deadline` must be future
and within 7 days; one `orchestration.json` receipt (`lane: cos`, `peerMessages` ids)
per work item, reserved before sending, so a repeat is `duplicate`. `peerMessages` on
receipts is optional, so older journals still validate. Schemas live in
`fleet/orchestration-journal.ts`.
Hermetic proof: `test/agentnet-peer-bus.test.ts`, Slack transport and CoS worker suites.
