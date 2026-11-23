# RQ-AGENTNET-PEERBUS-1: authenticated team peers

`src/core/agentnet/peer-bus.ts` owns `PeerRequest`, `PeerBusOptions`, `PeerResult`,
`PeerInboxFilter`, `peerRequestSchema`, `sendPeerMessage(input: unknown, session: PeerSession, options?: PeerBusOptions)`
and `readPeerInbox(session: PeerSession, after?: number, options?: PeerBusOptions, filter?: PeerInboxFilter)`.
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

`readPeerInbox`'s optional `filter` narrows the admitted page with the shared
bus read grammar every other bus read applies, minus the sender/thread filters
a callsign cannot express: `since` keeps messages received at or after the
epoch-ms cutoff (inclusive), `before` keeps only those strictly before it
(exclusive, composing into one `[since, before)` window), `contains` matches
the scrubbed one-line summary as a case-insensitive substring
(`busReadContainsMatch`), `priority` keeps only the exact P0..P3 band, and
`job` keeps only bodies the shared `busBodyJobMatch` rule names — a
`peer.message` cites no job and never matches. The filter only narrows
admission; it never widens it, and the `after`/`nextCursor` paging contract is
unchanged, so a filtered page may be sparse while `nextCursor` still resumes
past every scanned row. An invalid filter field answers `{status:'invalid',
reason}` with the same `workResults` report rather than an empty page passed
off as "no mail".

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
