# RQ-AGENTNET-PEERBUS-1: authenticated team peers

`src/core/agentnet/peer-bus.ts` owns `PeerRequest`, `PeerBusOptions`, `PeerResult`,
`peerRequestSchema`, `sendPeerMessage(input: unknown, session: PeerSession, options?: PeerBusOptions)`
and `readPeerInbox(session: PeerSession, after?: number, options?: PeerBusOptions)`.
`slack-identities.ts` owns `PeerBinding`, `PeerSession`, `readPeerBindings`,
`authenticatePeer`, `listPeers`, and `proposeSlackAction`; `cos/peer-plan.ts` owns
`cosPeerPlanSchema` and `emitCosPeerPlan`. None grants execution or spending authority.

Requests contain exactly one of `toAgent` (callsign) or `channel` (C/G Slack ID),
`kind: task|review|handoff|query|social`, `text` (1–12000 chars), optional `refs`
(max 32), `threadId`, and `replyTo`. The service derives sender, ID, origin and hops.
The existing bus stores `{kind: "peer.message", peer: {fromAgent, toAgent|channel,
kind, text, refs, threadId, origin, hopCount}}`, addressed to the callsign or mapped
channel topic. `peers read` checks private admission digests: raw bus labels,
Slack notes and A2A opt-in metadata cannot authenticate a peer. Claims stay in
the existing coordination table; replies must carry the preceding message's ID.

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
Hermetic proof: `test/agentnet-peer-bus.test.ts`, Slack transport and CoS worker suites.
