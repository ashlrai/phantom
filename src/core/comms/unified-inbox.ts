/**
 * RQ-SWE3-COMMS-DEPTH-1: the unified comms inbox — one prioritized view over
 * every pending comms item, each carrying the deep-link command that acts on it.
 *
 *   readUnifiedInbox(opts) — aggregates forty local, read-only sources:
 *
 *   needs-you   NEEDS-MASON.md ledger lines still unresolved
 *               (`phm fleet needs`), classified by the same
 *               `classifyNeedsYou` verdict `phm needs-you` reports: only a
 *               hard-limit item (secrets, money, an outside send, destroyed
 *               data, a sign-in, or unclear wording) blocks Mason; an auto
 *               item is ordinary work the fleet clears with
 *               `phm needs-you resolve --auto`, so it lists non-blocking
 *               with that verb as its first act. Act:
 *               `phm fleet needs-resolve`.
 *   needs-you-delivery  recorded needs-you answers whose planner-inbox relay
 *               is not confirmed — the delivery side of needs-you, the same
 *               `readNeedsMasonReplyDeliveries` read `phm fleet needs`
 *               reports as `replyDeliveries`. A resolved item leaves every
 *               open-item list, so a failed or unrecorded append would be
 *               invisible here without this source; each pending receipt
 *               lists as a warn whose retry is resolving the same id again
 *               (the recorded reply is reused, never re-asked), and each
 *               receipt that failed validation lists as unreadable — its
 *               delivery state stays unknown, never delivered. Act:
 *               `phm fleet needs-resolve`, `phm fleet needs`.
 *   imessage    unanswered allowlisted teammate texts in teammates.jsonl
 *               (`phm fleet teammate-texts`), act: mark answered or claim the
 *               mirrored bus envelope `imessage-teammate-<rowid>`.
 *   teammate-tasks  unsettled Dot/Instinct teammate tasks in the
 *               `imessage.teammate-tasks.v1` ledger (`phm fleet
 *               imessage-tasks list`) — queued, sending, pending, replied
 *               and expired rows the drain still owes work on; cancelled
 *               and settled rows never list. A replied task's RESULT text
 *               stays under this source rather than listing twice, so one
 *               pending thing is one item. Act: `phm fleet
 *               imessage-tasks dispatch --apply`.
 *   owner-thread  live inbound owner-thread messages no recorded outbound
 *               reply cites (`phm comms thread`), the same awaiting-reply mark
 *               `comms status` counts, act: `phm comms send-owner --reply-to`.
 *   owner-delivery  recorded owner-thread replies whose fanout is not fully
 *               delivered — the delivery side of the awaiting-reply mark,
 *               which counts a reply answered even when every channel
 *               refused it (`readOwnerUndeliveredReplies`, the same read
 *               `comms status` counts as `undeliveredReplies`). A destination
 *               the thread's sent-mark or the latest receipt cannot confirm
 *               lists as failed, pending or unknown — never delivered — and
 *               resending the same text under the reply's own key and the
 *               answered inbound's key (`--reply-to`, `--idempotency-key`)
 *               retries only the unconfirmed destinations. Act:
 *               `phm comms thread`, `phm comms send-owner --reply-to`.
 *   owner-pair  a live iMessage owner-pairing wait — the one pairing text
 *               `phm owner pair imessage` or the owner-live self-tick sent
 *               to Mason's own handles is still inside its YES window
 *               (`readOwnerPairPending`, the same `comms/owner-pair.json`
 *               `phm owner pair status` reads, minus the handles — only the
 *               sent count ever leaves the store). Only Mason can finish it:
 *               the first own handle answering YES binds, anything else
 *               binds nothing. An expired window is a closed wait, not
 *               pending work; a bound owner makes any leftover record inert
 *               residue; a verified-absent state file is 'missing' and a
 *               file that cannot be read or parsed 'unavailable' — never an
 *               empty wait passed off as fact. `since` is the send time and
 *               `expiresAt` the real YES-window deadline. Act:
 *               `phm owner pair status`, `phm owner pair imessage` (a
 *               waiting pair is checked first, so re-running it after the
 *               YES finishes the binding).
 *   drafts      outbound email drafts still pending approval
 *               (`phm drafts list --status pending`), act: show/approve/reject —
 *               plus pending Comms-agent reply drafts that have no cos mirror
 *               (every non-email transport, or an email mirror that failed to
 *               write; a mirrored copy already lists through the cos draft, so
 *               one pending reply is one item), act: `phm comms-agent drafts`.
 *   comms-mail  mail in the Comms agent's inbox (`<runsDir>/comms-agent/
 *               inbox.json`, the document `phm comms-agent run` triages)
 *               that no reply-draft record covers — kept mail still
 *               awaiting a pass, plus mail whose send the policy refused
 *               and mail no sender identity let the triage draft, the
 *               pending work `phm comms-agent status` counts as `inbox`
 *               depth but no item-level surface ever listed. A Comms
 *               draft — pending (the reply waits on the owner, already
 *               listed under `drafts`) or sent (the reply was delivered;
 *               archiving the row is the next pass's own bookkeeping) —
 *               covers its `messageId`, so one pending reply stays one
 *               item. The schema keeps no timestamp and `from` is a
 *               handle, so `since`/`expiresAt` stay null and items carry
 *               the transport plus the scrubbed subject only — never
 *               `from`, body or labels. An unreadable or malformed inbox
 *               reports 'unavailable' — the pending set is unknown,
 *               never an empty inbox; an unreadable drafts store degrades
 *               the read, coverage then unproven so every message lists
 *               rather than suppressing on a guess. Act:
 *               `phm comms-agent run`, `phm comms-agent drafts`.
 *   bus         live envelopes whose body the claim contract accepts
 *               (`isClaimableWork`: a `kind:'work'` body, or a protocol-v1
 *               transport `task` body) with no live claim row — an expired
 *               lease is free again and counts as unclaimed — act:
 *               `phm fleet bus-claim acquire`. A live
 *               coordination-table row on the envelope's `queue:<id>` key
 *               (resource, lane or board claims share the one table the
 *               message-id claim consults) also counts as held. The same
 *               section also lists open agent-bus v2 work-feed jobs (queued or
 *               rescheduled `work.post` announcements with at least one claim
 *               key not fully held), jobs the feed shows `blocked` or
 *               `failed`, jobs that declare no claim keys at all, and
 *               `running`/`idle` announcements whose declared keys provably
 *               lost every live hold — stalled work only the announcer can
 *               move — read
 *               through the same projection `phm agents bus work feed` serves —
 *               act: `phm agents bus claim acquire` — and every live
 *               `worker-handoff` envelope (`isWorkerHandoffBody`, the exact
 *               contract `fleet handoff-receive`/`handoff-reply` accept), so a
 *               pending assignment surfaces here instead of only in
 *               `agents bus work mine` — act: `phm fleet handoff-receive`.
 *               Every envelope addressed to the transport dead-letter sink
 *               (`bus.dead-letter`, the router's delivery-failure report —
 *               docs/AGENT-BUS.md "Dead letters") lists too, as
 *               `bus-dead-letter`: the mail provably never arrived, so it is
 *               pending attention even though the conversations, messages
 *               and edges projections deliberately exclude it as "not agent
 *               mail" — act: `phm agents bus show`, `phm agents bus
 *               dead-letters`, `phm comms bus read --to bus.dead-letter`.
 *               When the claims table itself
 *               cannot be read the section reports 'degraded' and still lists
 *               candidates rather than hiding possibly unclaimed work; a
 *               refused or unreadable feed degrades it the same way.
 *   mailbox     pending (unacked, unexpired) mail in the legacy `phm bus`
 *               mailbox store (`$ASHLR_HOME/bus-mailbox`, the records
 *               `phm bus inbox --to <label>` reads and `phm bus ack` clears)
 *               across EVERY recipient label — the fleet-wide read
 *               `BusMailbox.pendingAll` serves, where `work mine`'s mailbox
 *               section still needs the agent's labels ahead of time. The
 *               unified bus store never carried these records, so without
 *               this source leftover mail is invisible to the one pending
 *               view; each item keeps its own `to` label — the `--to`
 *               `phm bus inbox`/`ack` take — in the mailbox's own
 *               priority/acceptance/id drain order, with `since` the store
 *               acceptance time and `expiresAt` acceptance plus TTL. An
 *               absent store is 'missing' (verified empty); an unreadable
 *               one 'unavailable', never an empty list passed off as fact.
 *               Act: `phm bus inbox --to`, `phm bus ack`.
 *   board       pending work on the shared task board
 *               (`phm bus thread`/`task`/`board`, docs/BUS-THREADS.md)
 *               across EVERY peer — the fleet-wide read
 *               `BusBoard.pendingAll` serves, where `work mine`'s board
 *               section still needs the agent's labels and `phm bus board
 *               pending` one `--peer` at a time. Every unacknowledged
 *               delivery lists as board mail awaiting `thread ack` (`since`
 *               the recorded `createdAt`; the wire TTL bounds live
 *               observers only, so `expiresAt` stays null), and every task
 *               whose observed hold is not `held` lists — `open` claimable,
 *               `ambiguous` an expired claim record the claim path never
 *               auto-reclaims, `unknown` a hold the unreadable queue could
 *               not prove; tasks carry no timestamp, so `since`/`expiresAt`
 *               stay null. An absent board is 'missing' (verified empty —
 *               the read never creates the store a write would leave); an
 *               unreadable one 'unavailable'; an unreadable claim index or
 *               truncated item list degrades the source. Act:
 *               `phm bus thread pending|ack`, `phm bus task claim|list`,
 *               `phm bus board pending`.
 *   work-board  the coordination work board's (`fleet work-board`,
 *               `listWorkBoard` — the Nov12 `classifyWorkItem` projection
 *               `phm fleet work-board`, `fleet_work_board` and the cloud
 *               work-board route all serve) requests still needing a
 *               decision: every durable bus request envelope classified
 *               RECEIVED (no named owner or durable claim receipt yet),
 *               ASSIGNED (owned but its running evidence is stale or
 *               absent) or BLOCKED (a reply named what it waits on). Items
 *               the board shows RUNNING (fresh running evidence) or
 *               VERIFIED (proof of completion) are done or provably
 *               progressing and never list — this is the board's pending
 *               surface, not a second copy of the conversations or bus
 *               sources, which carry no ownership classification. An
 *               envelope the bus source already represents — claimable work,
 *               a worker handoff or a `work.post` feed announcement — stays
 *               under `bus`: one pending thing, one item. `since`
 *               is the request's recorded `receivedAt`; `expiresAt` stays
 *               null because a retained receipt has no deadline. An
 *               unreadable inbox scan is 'unavailable' with a null pending
 *               — never an empty board passed off as fact — and an
 *               unreadable claims or coordination table degrades the item
 *               evidence the same way the board itself reports it (owners
 *               stay unknown, never guessed). Items name the envelope id,
 *               channel, owner, claim receipt and missing-evidence list —
 *               never message bodies — and carry no provable job citation,
 *               so `--job` never matches. Severity is warn for RECEIVED and
 *               BLOCKED, info for ASSIGNED; all are agent coordination
 *               work, never Mason-blocking. Act: `phm fleet work-board
 *               --state <state>`, `phm fleet work-trace --id <id>`.
 *   conversations  agent-to-agent conversation threads still needing a
 *               person — the same `state:'waiting'` and `state:'blocked'`
 *               threads the one shared conversations projection computes,
 *               fleet-wide: a waiting thread names who must answer and how
 *               long it has waited, a blocked thread names who reported the
 *               block, who was told and how long it has stood. A thread
 *               whose latest message is already a pending bus item (an
 *               unclaimed work envelope or a live worker-handoff) or whose
 *               `job:` thread the feed already lists stays under the bus
 *               source: one pending thing, one item. Act: `phm agents
 *               conversations`, `phm agents bus show`, `phm agents bus
 *               post --thread`.
 *   wakes       pending wake hints fleet-wide — the same `readAllWakes`
 *               projection `phm agents bus wakes --all` and `fleet_agent_wakes`
 *               serve, grouped by addressee so the bounded queue tail never
 *               floods the view with one item per hint. A wake is the bus's
 *               notification layer — "go read your inbox" — never pending
 *               work itself and never Mason-blocking, so items are warn and
 *               non-blocking; `since` is the newest hint's queue time and
 *               `expiresAt` stays null because a hint carries no deadline —
 *               it ages out of the bounded tail, unknown. Each addressee's
 *               `jobIds` are the jobs its hints provably cite (a claim-holder
 *               hint's `jobId` or a resolved referent's feed citation), so
 *               `--job` finds the hint under the same job it belongs to.
 *               Addressees group by resolved identity when the `to` label
 *               resolves through the registry and by the literal label
 *               otherwise, so unknown identity state never merges distinct
 *               addressees. An unreadable queue, registry, bus store or hold
 *               table is 'unavailable', never an empty page passed off as
 *               "no wakes". Act: `phm agents bus wakes`, `--all`.
 *   seats       bot seats whose projected handoff plan still has work to
 *               move — the same `planSeatHandoffs` read `phm bots handoffs`
 *               serves, so the inbox and that surface can never disagree.
 *               Only eligible seats (draining, or idle while still holding
 *               work or handoff history) with pending — not yet journaled —
 *               handoff records list: a draining seat with nothing left to
 *               release is already on its way to idle, not pending work.
 *               Seat handoffs are agent work, never Mason-blocking, so items
 *               are warn and non-blocking; `since` stays null because the
 *               plan's record timestamps are the read instant, not a real
 *               age. An empty roster is 'missing' (no seats configured); an
 *               unreadable roster, coordination table, node store or quota
 *               read is 'unavailable', never an empty plan passed off as
 *               fact. Act: `phm bots handoff --seat`, `phm bots handoffs`.
 *   peer-dispatch  unpublished peer work results — the private
 *               `agentnet/work-dispatch.json` journal's `work.result`
 *               receipts whose latest recorded outcome was never confirmed
 *               sent to the proposing peer (`sent` trails `outcome`, or was
 *               never written — the same `sent !== outcome` rule
 *               `consumePeerWork`'s publish pass and the peer-bus admission
 *               check apply, so a peer cannot see a result the journal does
 *               not prove was published). The proposing peer waits on the
 *               bus for that result and no other surface lists the backlog —
 *               `peers dispatch` reports only the current feed page — so each
 *               receipt lists as a warn whose act is the
 *               `phm agentnet peers dispatch --apply` pass that publishes it.
 *               `since`/`expiresAt` stay null: the journal stamps receipt
 *               creation, not the last outcome move, so the pending age is
 *               unknown — never invented. `jobIds` carries the peer-announced
 *               job id, so `--job` finds the result under the same job it
 *               belongs to. An absent journal is 'missing' (dispatch never
 *               ran); an unreadable one 'unavailable', never an empty plan
 *               passed off as fact.
 *   peer-inbox  peer mail this host's live-enrolled callsigns are admitted
 *               to read — the same admission proofs `phm agentnet peers
 *               read` runs per session and the `peerInbox` section of
 *               `phm agents bus status` counts fleet-wide: a retained bus
 *               envelope counts when a live coordination-ledger row proves
 *               this host sent it to an enrolled callsign (id, target, send
 *               instant, 24h window and body digest all matching) or when
 *               the private dispatch journal proves this host published
 *               that work.result outcome to the addressed callsign. Until
 *               now the only surfaces were that bare count and the
 *               sessioned `peers read`, so admitted mail — a peer's
 *               question, review ask or task — was invisible to the one
 *               pending view. Each admitted envelope whose body the bus
 *               source does not already own (claimable work, a worker
 *               handoff or a `work.post`/`work.status`/`work.claim`/
 *               `work.release`/`wake` feed body — those pending things
 *               list under `bus`/`wakes`, one pending thing one item;
 *               `work.result` stays, since the feed reads it as job
 *               evidence and the peer-dispatch source lists only
 *               unpublished outcomes) lists as a warn `peer-message` naming the enrolled
 *               callsigns whose session admits it, the sender and a
 *               scrubbed body summary, with `since` the store receipt
 *               time and `expiresAt` the envelope's own TTL deadline;
 *               `jobIds` carries the body's own job citations. Act:
 *               `phm agentnet peers read --id`, `phm agents bus show`,
 *               `phm agentnet peers read`. An absent bindings file or bus
 *               store is 'missing' (no peer can hold admitted mail), an
 *               unreadable bindings, ledger, journal or bus store
 *               'unavailable' — an unreadable journal leaves work.result
 *               mail unprovable, so the total is unknown rather than a
 *               ledger-only undercount — and a bounded scan that could not
 *               cover every retained receipt degrades the source, pending
 *               a stated floor, never a complete count passed off as fact.
 *   session-handoff  open session-handoff checkpoints — the same
 *               `listSessionHandoffs` bounded journal scan
 *               `phm checkpoint handoff list`, `fleet_session_handoffs`,
 *               the bus-status probe's `sessionHandoffs` section and
 *               `work mine`'s `sessions` digest serve, so a checkpointed
 *               session waiting for a resume or failover pass lists beside
 *               seat handoffs and feed jobs instead of behind a third
 *               command. Each open journal lists one warn, non-blocking
 *               item — checkpointed work is agent work, never
 *               Mason-blocking — carrying the journal's job id as its
 *               `--job` citation, `since` the latest revision's recorded
 *               time and `expiresAt` the 24-hour resume bound
 *               `planSessionResume` refuses past; a pressure signal —
 *               rate-limit, quota-exhausted or a budget at its threshold,
 *               the same `handoffPressure` verdict `planSessionFailover`
 *               applies — marks the item for failover. Journals that fail
 *               validation or sit past the bounded scan could hide open
 *               checkpoints, so the read's `unreadable`/`truncated` flags
 *               degrade the source — pending stays a stated floor, never a
 *               complete count passed off as fact. An absent store is
 *               'missing' (no handoff was ever checkpointed); an
 *               uninspectable one 'unavailable'. Act:
 *               `phm checkpoint handoff show`, `phm checkpoint handoff list`.
 *   org-outbox  org.membership bus events the org plane still owes the bus —
 *               `<runsDir>/org/agents.json` ledger entries with
 *               `busDelivered:false`, the exact set `previewOrgOutbox`
 *               replays and `phm fleet org-sync --apply` posts (one event
 *               per distinct `(revision, role)` edit, stable id
 *               `org-<storeId>-<revision>-<roleId>`). Until the apply pass
 *               runs, the bus cannot see a staffing change the chart already
 *               recorded and `org-board` reports only a pending count, so
 *               each event lists as a warn whose acts are the org-sync apply
 *               and the org-board inspect. `since` is the ledger entry's
 *               recorded application time; `expiresAt` stays null — the
 *               event waits for the next sync pass, never a guessed deadline.
 *               The read applies `readAgentPlane`'s whole acceptance —
 *               absent store 'missing', any refusal 'unavailable' — and the
 *               store schema is mirrored locally for the Tier-1 closure, so
 *               this source and the org-sync/org-board reads can never
 *               disagree about whether the store is trustworthy.
 *   gmail       one item per inbox in the saved Gmail archive plan whose unread
 *               count is over its target (`phm fleet gmail-archive-plan`). A
 *               read of the saved plan only: no mail is read, moved or deleted.
 *   linkedin    unanswered LinkedIn messages saved as JSON files in the local
 *               drop folder `<runsDir>/comms/linkedin/inbox/` (see
 *               linkedin-drop.ts). Replies stay drafts (`phm drafts list
 *               --status pending`); nothing is sent from here.
 *   requests    live comms questions and approvals from the request queue
 *               (`~/.ashlr/comms/requests.jsonl`, the same store `phm comms
 *               status` counts): a sent one is the single outstanding slot
 *               Mason's numbered reply or button tap resolves, a pending
 *               one is queued behind it. Informational reports never await
 *               a reply and never list. `expiresAt` is the real TTL deadline
 *               `expireStaleRequests` applies — never invented.
 *   email-outbox  `.reply.eml` artifacts the email send pass marked `stuck`
 *               in the reply outbox (`<runsDir>/queue/email-drop.json` →
 *               `outboxDir`, else the sibling of `inboxDir`) — interrupted
 *               send claims, oversized or unreadable files, malformed
 *               drafted rows. A stuck reply is a recorded delivery failure
 *               the owner is waiting on, so each lists as warn with the
 *               fixed reason and a `phm fleet email-outbox` deep link; a
 *               stuck artifact is never auto-resent. Entries carry no
 *               timestamp, so `since`/`expiresAt` stay null. Missing or
 *               invalid config, a missing outbox and an unreadable one keep
 *               their own source state — never an empty outbox passed off
 *               as fact.
 *   email-inbox  `*.eml` files still sitting in the email-drop inbox dir
 *               (`<runsDir>/queue/email-drop.json` → `inboxDir`) — inbound
 *               mail the drop pass has not recorded yet, the mirror of the
 *               email-outbox source on the receive side. A file leaves only
 *               when `runEmailDropOnce` moves it into `processedDir`, so a
 *               stalled cycle, a paused config or an unsafe folder leaves
 *               real pending comms invisible to every recorded-receipt
 *               source; each backlog lists as ONE warn item naming the real
 *               file count (filenames never leave the directory — they can
 *               carry addresses), `since` the newest entry's filesystem
 *               mtime — the last arrival on the pending set, never a parsed
 *               header — and `expiresAt` null. An other-writable inbox
 *               degrades the source state (the pass refuses the folder, so
 *               the files cannot move until permissions are fixed); a config
 *               with `enabled:false` only annotates the detail — polling is
 *               paused by owner choice while the files stay pending. Missing
 *               config or a missing inbox dir is 'missing'
 *               (verified empty — the pass treats it as an empty pass too);
 *               invalid config 'degraded'; a non-directory or unreadable
 *               inbox 'unavailable', never an empty listing passed off as
 *               fact. Act: `phm comms email-cycle`, `phm comms diagnose`.
 *   team-approvals  pending team approvals — access requests and
 *               consequential handoffs only an owner/admin can decide — from
 *               the team event log, the same `readTeamApprovals` section
 *               `phm approvals` and the desktop Approvals panel project,
 *               scoped to DEFAULT_TEAM like the bare command. The requested
 *               action is held until `phm team approve|deny` records the
 *               decision, so each lists as a blocking warn; the projection
 *               carries no timestamp, so `since`/`expiresAt` stay null. A
 *               throwing or refused read reports 'unavailable', never an
 *               empty approvals list passed off as fact.
 *   proposals  pending inbox proposals (`~/.ashlr/inbox`), the same
 *               `readPendingProposals` section — proposed outward actions
 *               that never auto-apply and wait on review. Info items
 *               deep-link `phm inbox show|approve|reject`; a partial capture
 *               can be rejected but never approved, so its acts drop
 *               `approve`. A truncated or incomplete read reports 'degraded'
 *               with the items it did find — never an empty list passed off
 *               as fact.
 *   slack      Slack requests whose local bus append failed — a
 *               pending-comms class no other source can see. The same
 *               `readSlackJournal` the `phm fleet slack-trace` and
 *               `phm channels slack status` projections read: a journaled
 *               `ingested` row with `bus: 'failed'` is an authenticated,
 *               validated Slack event whose bus append never landed (the
 *               exact condition the trace calls `bus-failed` — send
 *               receipts only bind replies for the other outcomes), so it
 *               has no bus envelope (the bus and conversations sources),
 *               no owner-thread record (`noteUnifiedOwner` runs only on
 *               durable ingest) and no claim — the journal is the only
 *               durable evidence. Posted, duplicate, legacy (`bus` absent)
 *               and ignored rows either have a durable envelope another
 *               source already lists or cannot be proven pending, so only
 *               failed appends list here. Rows carry ids and timestamps
 *               only — channel, thread and message ts, never text — with
 *               `since` the journal receive time and `expiresAt` null: the
 *               request is lost until re-ingested, never a guessed
 *               deadline. Repeated failed ingests of one message collapse
 *               to the newest row — one pending thing, one item. Source
 *               state is the journal read's own: `ok`, `missing` or
 *               `degraded`, never fabricated. Act: `phm fleet slack-trace`,
 *               `phm channels slack status`.
 *   slack-sends  outbound Slack sends still unconfirmed — send-store
 *               receipts the transport journaled as `attempted` and never
 *               proved. The same `readSlackSendReceipts` the
 *               `phm channels slack status` `uncertainSends` count and the
 *               `phm fleet slack-trace` reply binding read: an `attempted`
 *               receipt is a post whose outcome the transport could not
 *               prove, kept precisely so a later pass reconciles by
 *               history scan instead of risking a duplicate post — until
 *               that lands the recipient may never have seen the message,
 *               and every other surface reports only the count. Each
 *               unconfirmed send lists as a warn naming channel and thread
 *               ids only, never text; receipts keep no attempt timestamp,
 *               so `since`/`expiresAt` stay null — the send waits until
 *               reconciled, never a guessed deadline. Reconciliation is a
 *               bounded `phm channels slack run` pass, which re-drives the
 *               delivery and marks the receipt `sent` without reposting.
 *               `sent` receipts are proved deliveries and never list; a
 *               missing store is verified empty, a degraded one still lists
 *               the receipts it could read. Act: `phm channels slack
 *               status`, `phm fleet slack-trace`, `phm channels slack run`.
 *   leader-delivery  Leader-thread messages whose Telegram delivery the
 *               drain can no longer finish — `failed` after its retries or
 *               `pending` past the 72 h offer window — from
 *               `readLeaderThreadUndelivered`, the read-only scan of the
 *               same thread log and delivery index `drainLeaderThread`
 *               drains (every listing path syncs memos first — a write —
 *               so the inbox reads the store directly). A stuck delivery
 *               means Mason may never have seen a memo, question, update or
 *               reply on his phone; until now only the comms cycle's
 *               one-line outcome for the newest memo and the Verse thread
 *               showed it. Each lists as a warn naming the message kind and
 *               state with a scrubbed text snippet, `since` the recorded
 *               post time and `expiresAt` null — a failed send waits for a
 *               decision, never a guessed deadline; fresh pending messages
 *               are the drain's own queue and never list. Source state is
 *               the read's own — `missing` a verified-absent thread,
 *               `degraded` a truncated log, `unavailable` an unreadable or
 *               malformed store — never an empty list passed off as fact.
 *               Act: `phm channels`, `phm comms cycle`, `phm comms send-owner`.
 *   leader-network  the leader network's durable route/digest state
 *               (`<runsDir>/leader/network-state.json`) through
 *               `readLeaderNetworkState` — the same bounded anchored read
 *               `readRouteReplyFacts` applies, never the locking
 *               `pending()` recovery pass. Verified owner requests fully
 *               ingested for the leader (inbox append and bus mirror
 *               proven, no delivered or attempted reply) list as warn
 *               `leader-request` items — the leader's own pending queue,
 *               invisible to the owner-thread source because network
 *               replies record to MASON-OUTBOX.md, never the thread store;
 *               a reply recorded whose delivery failed non-ambiguously
 *               stays in that queue (the network retries it) and the item
 *               says "awaiting retry", never "awaiting reply".
 *               A leader-bound route missing its inbox append or bus
 *               mirror — or any route whose bus publish never landed —
 *               lists as `leader-request-incomplete`: the request
 *               provably did not reach every store the leader reads. A
 *               reply or away-digest whose delivery attempt ended
 *               ambiguous (`attempted` without `delivered`/`sent`) lists
 *               as `leader-reply-unconfirmed`/`leader-digest-unconfirmed`:
 *               the network never retries an ambiguous attempt —
 *               "reconcile before retry" — so the owner may never have
 *               seen the answer and nothing else reported it. Items name
 *               channel, routing label, timestamps and job citations
 *               only — owner recipient ids and channel refs never leave
 *               the reader; request text is scrubbed like every other
 *               source. `missing` is a verified-absent store,
 *               `unavailable` any refusal — never an empty backlog passed
 *               off as fact. Act: `phm leader inbox`, `phm comms thread`.
 *   leader-replies  leader replies to Mason still owed a proven iMessage
 *               delivery — the send ledger `<imessageStateDir>/
 *               leader-sent.jsonl` `sendLeaderReplies` appends
 *               (`{at, hash, status}` per attempted reply; the hash is a
 *               content fingerprint, never text) read through
 *               `readLeaderRepliesLedger`, the same last-status-per-hash
 *               fold `readClaimed` applies so the projection can never
 *               disagree with what the next pass does. A hash whose last
 *               row is `failed` lists as warn `leader-reply-failed` — the
 *               send provably did not land and the next live `phm
 *               imessage replies` pass retries it; a hash whose last row
 *               is `pending` older than the one-hour in-flight bound
 *               lists as warn `leader-reply-orphaned` — the process died
 *               between the claim and the outcome append, `readClaimed`
 *               counts it as sent forever, and no pass ever retries it, so
 *               the reply is a dead letter until re-posted. Fresh pending
 *               rows may be in flight and never list; `sent`/`baseline`
 *               rows are resolved claims. Each item resolves its reply
 *               text through the same bounded `readOutboxEntries` read the
 *               sender uses — the ledger claims by text hash, so identical
 *               texts share one pending unit and the newest posting is the
 *               identifier — and shows a scrubbed snippet with its outbox
 *               stamp when the bounded read still holds it, saying "reply
 *               text not in the current outbox read" when it does not;
 *               `since` is the first recorded attempt (first pending row,
 *               else first failed row, else the last row — a truncated
 *               tail can only raise it, never invent it) and `expiresAt`
 *               stays null: a failed or orphaned send waits for a pass or
 *               a decision, never a guessed deadline. `missing` is a
 *               verified-absent ledger, `degraded` a tail-truncated read
 *               (older rows unseen — pending is a stated lower bound),
 *               `unavailable` an unreadable store — never an empty backlog
 *               passed off as fact. Act: `phm imessage replies`, `phm
 *               leader replies`, `phm comms send-owner`.
 *   coordination  the advisory coordination ledger's (`fleet.coordination.v1`,
 *               `~/.ashlr/fleet/coordination.jsonl`) whole pending surface
 *               through `readFleetCoordinationPending` — the same replay
 *               `readFleetBoard` runs, projected fleet-wide in one read:
 *               live ledger messages (`post` events, addressed to one
 *               coordination label or `all`, live until their TTL) list as
 *               `coordination-message` info items — coordination mail no
 *               bus, mailbox or board source can see, since the ledger is a
 *               separate store `phm fleet coordination inbox --agent` and
 *               `board` read; live assignment proposals (`assign` events,
 *               `executionAuthorized:false` — they propose work and never
 *               spawn anything) list as `coordination-assignment` info items;
 *               and durable RESULT intents whose receipt publish never
 *               landed — the `released-unposted` class `returnFleetClaim`
 *               reports once and nothing else surfaces, since the claim is
 *               already released and the intent is invisible on the board
 *               read until its expiry deletes it — list as warn
 *               `coordination-return-unposted` items naming claim id,
 *               returning agent and receipt expiry, with the owner-held
 *               lease-verified retry as the detail (lease material never
 *               leaves the store). Items carry coordination labels,
 *               timestamps and scrubbed body/task/receipt text only.
 *               `missing` is a verified-absent ledger, `unknown` any
 *               refusal — never an empty backlog passed off as fact.
 *               Act: `phm fleet coordination board`,
 *               `phm fleet coordination inbox --agent`.
 *   claim-drift  the claim-store drift verdict's (`fleet.claim-drift.v1`)
 *               disagreeing rows — live bus work claims against the live
 *               `queue:<id>` coordination leases they are dual-written to,
 *               through `readClaimStoreDrift`, the same read `phm fleet
 *               claim-drift` and the bus-status probe's `claimDrift`
 *               section serve. The verdict's counts were the only surface:
 *               `agents bus status` reports numbers, and an agent had to
 *               already know the verb to see WHICH claims disagree. A
 *               bus-only row is a live lease the coordination overlap
 *               check cannot see (a second acquire could double-grant), a
 *               coord-only row a `queue:<id>` lease the bus claims journal
 *               never recorded, and an owner-mismatch pair the same lease
 *               showing two different holders — each lists as a warn,
 *               agent work to reconcile before the lease lapses, never
 *               Mason-blocking. `since` is the claim coordinate's recorded
 *               receipt time (null when a coord row's sourceId tail cannot
 *               be parsed — unknown stays unknown) and `expiresAt` the
 *               lease deadline that ends the disagreement; items name the
 *               envelope id, owner labels, cursor and stamps only — no job
 *               citation is provable from a drift row, so `--job` never
 *               matches. UNKNOWN — a claim store that could not be read —
 *               reports 'unavailable' with a null pending, never an empty
 *               verdict passed off as fact; VERIFIED with both stores
 *               absent is 'missing' (verified-empty). Act:
 *               `phm fleet claim-drift`, `phm agents bus show`,
 *               `phm agents bus claim list --key`.
 *   send-gate   the outbound send gate every local bus write, claim and
 *               send passes through — the kill-switch sentinel and the
 *               comms soft-pause flag `localWriteGate`/`localBusHold`
 *               consult, read through the same `readKillSwitch` and
 *               `probePauseState` inspections `agents bus status`'s
 *               `sendGate` section serves, so the two surfaces can never
 *               disagree. Until now the gate was invisible here: pending
 *               items kept listing while every write verb refused, and an
 *               agent had to already know `agents bus status` to learn
 *               why nothing could drain. An engaged kill switch lists as
 *               `send-gate-kill`, a set pause flag as `send-gate-pause` —
 *               each naming the gate and its verdict, since claims, sends
 *               and bus writes refuse until it clears; an uninspectable
 *               or unsafe gate file lists the same kind one band lower,
 *               because the send path fails closed and refuses as if
 *               engaged while the probe honestly reports unknown rather
 *               than calling it a decision someone made. `since` is the
 *               pause flag's recorded start — the sentinel keeps no
 *               provable time, so kill items and unparseable flags stay
 *               null — and `expiresAt` stays null: a gate waits for its
 *               release, never a guessed deadline. Both gates clear is a
 *               verified-open source with a real zero; either probe's own
 *               unknown verdict degrades the source — unknown stays
 *               unknown, never an open gate passed off as fact. The reads
 *               are total by contract and each keeps its own try, matching
 *               the bus-status probe, so one throwing read cannot hide the
 *               other's verdict — a throw synthesizes the same 'unknown'
 *               verdict the fail-closed send path applies. Act: `phm agents bus status --json`, `phm fleet
 *               status`, `phm fleet resume` (the kill item's release —
 *               the pause flag clears through the owner 'resume' comms
 *               command or `setPause(false)`, which no CLI verb wraps).
 *   router-queue  READY jobs in the dispatch router queue
 *               (`<runsDir>/queue/router-queue.md`) that no recorded
 *               LAUNCH in `dispatch-events.log` proves ever started —
 *               the same `readStuckQueue` read `phm queue stuck` and the
 *               desktop Queue view serve. Until now the dispatch queue's
 *               stuck backlog had no inbox surface: work an agent could
 *               claim through every bus, board, feed and coordination
 *               read still sat READY forever while the unified view —
 *               the one place an agent looks for work — never named it.
 *               Each unlaunched READY row lists as a warn
 *               `router-queue-job` naming the job id — the same label
 *               `phm queue` verbs take — `since` the enqueue epoch or
 *               first dispatch-event time the wait is measured from
 *               (null when neither exists — age unknown stays unknown)
 *               and `expiresAt` null: a queued job waits for a lane,
 *               never a guessed deadline. When the events log cannot be
 *               read the source degrades — every READY row still lists
 *               but its launch state is unproven, and the detail says
 *               so — an absent queue file is 'missing' (verified-empty:
 *               no READY rows can exist) and an unreadable one
 *               'unavailable', never an empty queue passed off as fact.
 *               The job id is the item's own citation, so `--job` matches.
 *               Act: `phm queue stuck`, `phm fleet unfed --json`,
 *               `phm queue`.
 *   jobs-stuck  running jobs that are not really running — the same
 *               `readStuckJobs`/`jobs.stuck.v1` read `phm jobs stuck` and
 *               the `--stuck` pass of `phm fleet stray-stop` serve, over
 *               the dispatchd run markers (`queue/run/<job>.line` open,
 *               `.fin` absent): a GHOST — the recorded pid is gone while
 *               the marker still claims the lane's running slot — and
 *               STUCK — started over 90 minutes ago with the log silent
 *               for 30. Until now a dead or hung job held its lane's
 *               running count — every status, vitals and capacity read
 *               inflated — while no pending surface named it: the bus,
 *               feed, board, queue and channel sources all look at work
 *               not yet claimed or refused, never at markers that claim
 *               a run which is not happening. Each row lists as a warn
 *               `stuck-ghost`/`stuck-job` naming the job id — the same
 *               label `phm jobs stuck` prints — `since` the recorded
 *               start reconstructed at the report's whole-minute
 *               precision (null when the marker kept none — age unknown
 *               stays unknown) and `expiresAt` null: a lying marker
 *               waits for stray-stop or a finish, never a guessed
 *               deadline. The job id is the item's own citation, so
 *               `--job` matches. The marker directory unreadable is
 *               'unavailable' — the stuck set is unknown, never an
 *               empty list passed off as fact — unless `queue/run` is
 *               verified absent, which is 'missing' (no job can count
 *               as running, so nothing can be stuck). The stray-stop /
 *               self-tick remediation is the act, never this read.
 *               Act: `phm jobs stuck`, `phm fleet stray-stop --stuck
 *               --apply`.
 *   channel-health  owner-channel transport health — the slack and
 *               iMessage bridges through `readChannelHealth` (the same
 *               projection `phm fleet channel-health` and `phm channels`
 *               serve) and the Telegram poller through `telegramEnabled` +
 *               `readTelegramHealth` (the same read `phm comms health
 *               --json` serves). Until now a dead bridge or a stale poller
 *               was invisible here: `phm channels` could show a channel
 *               ready while its process was gone, and an agent had to
 *               already know which diagnostic to run to learn owner traffic
 *               was not flowing. A configured bridge that is BLOCKED lists
 *               as `channel-blocked` (high — the transport is provably
 *               down), DEGRADED as `channel-degraded` and UNKNOWN as
 *               `channel-unknown` (warn — evidence incomplete or a receipt
 *               overdue, never called a decision); a channel nobody
 *               configured (`BLOCKED` with `configured:false`, the
 *               overview's 'not-set-up' row) and a LIVE one never list —
 *               setup state is not pending work. The telegram leg lists
 *               only when `telegramEnabled` — the same gate the comms
 *               cycle's poll applies — as one `channel-degraded` item
 *               naming each failed check (a recorded poll error, no poll
 *               inside the 7-minute liveness window, no successful poll
 *               yet); an unreadable main config or a throwing poll read
 *               lists `channel-unknown` instead. `since`/`expiresAt` stay
 *               null throughout: health keeps no condition-start time and
 *               a degraded channel waits for repair, never a guessed
 *               deadline; no item names a job. Either leg's own failure
 *               degrades the source — a throwing bridge read proves
 *               nothing about slack/imessage while the telegram verdicts
 *               still list, and a throwing config or poll read is itself
 *               the `channel-unknown` evidence — so 'unavailable' and
 *               'missing' never apply: this is a live probe of running
 *               transports, not a store that can be absent. Act: `phm fleet channel-health`, `phm channels
 *               slack status`, `phm imessage doctor`, `phm comms health
 *               --json`, `phm comms cycle`, `phm channels`.
 *   queue-parked  PARKED-DEP rows in the dispatch ready queue
 *               (`<runsDir>/queue/ready.tsv`) — dependency-gated jobs the
 *               same `readFleetQueue` projection `phm fleet queue-parked`,
 *               `phm fleet parked` and the autopilot's `stale-parked-deps`
 *               gap serve, so this source and those surfaces can never
 *               disagree. Until now the parked dependency backlog had no
 *               inbox surface: the router-queue source lists only READY
 *               rows in `queue/router-queue.md`, so a job parked on
 *               `DEPENDENCY GATE` ids was invisible to the one view an
 *               agent checks for work. Each parked row lists once under
 *               its own state: gates still lacking a MERGED outcome in
 *               `metrics/jobs.jsonl` list as info `parked-dep-waiting`
 *               naming the unmet gate ids — queued work correctly
 *               waiting on named jobs — while a row whose gate ids ALL
 *               show MERGED yet was never unparked lists as warn
 *               `parked-dep-stale` — the auto-unpark pass should have
 *               freed it already, so it is stuck work, not a wait.
 *               `jobIds` carries the parked job's own id plus the gate
 *               ids its detail names, so `--job` finds the row under the
 *               parked job and under every job it waits on. Every OTHER
 *               parked reason — BYHAND, HOLD, MERGERATE, QUOTA and the
 *               rest of the free-form `PARKED-<reason>` vocabulary — had
 *               no inbox surface either: `phm fleet queue-parked` prints
 *               them as `parked REASON (lane): count [jobs]` groups, so
 *               each non-dependency reason+lane group now lists once as
 *               info `parked-group` carrying the group's true count, its
 *               lane and the projection's own eight-job cap named as a
 *               floor (`+N more` when the group is larger), with `jobIds`
 *               the listed ids so `--job` finds a listed member — parked
 *               under a non-dependency reason is a hold, never a proven
 *               gate wait or stale park, so it stays info rather than
 *               borrowing the dep kinds' verdicts. `since`/
 *               `expiresAt` stay null throughout: ready.tsv rows keep no
 *               park timestamp and a parked job waits for its gates, its
 *               reason's resolution or an unpark pass, never a guessed
 *               deadline; no item is Mason-blocking. A missing `ready.tsv`
 *               is 'missing' (verified-empty — no parked rows can exist),
 *               an unreadable or malformed one 'degraded' — the listed
 *               rows are a floor, never a complete set — and a throwing
 *               read 'unavailable', never an empty queue passed off as
 *               fact. Act: `phm fleet queue-parked`, `phm fleet parked`,
 *               `phm fleet autopilot --once`.
 *   stuck-fixes  guardian FIXUP-MAIN jobs whose published pull request
 *               never reached a terminal outcome — the same
 *               `findStuckFixes`/`readStuckFixes` fold `phm fleet
 *               stuck-fixes`, `phm fleet main-health`, the verse
 *               runs-history `stuck-fixes` route and the web-ui
 *               needs-you strip serve, over `<runsDir>/metrics/jobs.jsonl`,
 *               so this source and those surfaces can never disagree.
 *               Until now a fix PR sitting open past the 20-minute
 *               terminal-outcome bound had no item-level surface here:
 *               the jobs-stuck source reads run markers, the queue
 *               sources read ready/router rows, and every bus/feed/board
 *               read looks at work not yet claimed — while a guardian
 *               fix that published and then stalled was invisible to the
 *               one view an agent checks for work. Each stuck row lists
 *               once as a warn `stuck-fix` — 'high' once the PR has been
 *               stuck an hour, the same escalation the needs-you strip
 *               applies — naming the repo ('unknown repo' when no repo
 *               is on record), the PR url and the job id, `since` the
 *               recorded publish time and `expiresAt` null: a stuck fix
 *               waits for a merge or close decision, never a guessed
 *               deadline; the job id is the item's own citation, so
 *               `--job` matches. `phm fleet main-health`'s own rule
 *               applies — a verified-absent ledger means no fix PR was
 *               ever published, so 'missing' (verified-empty); a ledger
 *               that exists but cannot be folded, or a path that cannot
 *               be inspected, is 'unavailable' — the stuck set is
 *               unknown, never an empty list passed off as fact; the
 *               fold itself never throws and skips torn lines by
 *               contract. Act: `phm fleet stuck-fixes`, `phm fleet
 *               main-health`.
 *   stranded-work  finished work in kept worktrees that never became a
 *               pull request — the same `readStrandedWork`/
 *               `findStrandedWork` fold `phm fleet stranded` serves,
 *               over `<runsDir>/queue/status.json`'s kept list, the
 *               `metrics/jobs.jsonl` finish events, each job's
 *               `.publish` sidecar and the queue run markers, so this
 *               source and that surface can never disagree. Until now
 *               finished-but-unshipped work had no item-level surface
 *               here: the jobs-stuck source reads open run markers,
 *               the queue sources read ready/router rows, the
 *               stuck-fixes source reads published fix PRs, and every
 *               bus/feed/board read looks at work not yet claimed —
 *               while a job that finished with real changes and then
 *               stopped short of a PR (a publish abort, a safety-gate
 *               stop, an unexplained result) sat invisible in a kept
 *               worktree, its diff at risk of being reaped or
 *               forgotten. Each unrecovered stranded row lists once as
 *               a warn `stranded-worktree` naming the job id, `since`
 *               the recorded finish time (null when the ledger kept
 *               none — unknown stays unknown) and `expiresAt` null: a
 *               stranded job waits for a republish or re-run, never a
 *               guessed deadline; the job id is the item's own
 *               citation, so `--job` matches. Rows a later job already
 *               recovered — or a verify already proved on main — never
 *               list: their own next step says there is nothing to do.
 *               The kept-list rule `phm fleet stranded` itself reports
 *               applies — a verified-absent `queue/status.json` is
 *               'missing' (no kept worktree can be listed, so no
 *               finished work can be stranded), a kept list that
 *               exists but cannot be read, or a throwing read, is
 *               'unavailable' — the stranded set is unknown, never an
 *               empty list passed off as fact — and a known read with
 *               gaps (an unreadable metrics ledger leaves finish times
 *               and sizes unknown, so the listed rows are a floor) is
 *               'degraded'. Act: `phm fleet stranded`, `phm fleet
 *               republish`, `phm fleet kept-worktrees`.
 *   dispatch-stuck  queued jobs dispatch keeps refusing or failing —
 *               the same `findStuckJobs`/`readDispatchStuckJobs` fold
 *               `phm fleet stuck` and the `fleet.stuck.v1` row of `phm
 *               fleet vitals` serve, over the tail of
 *               `dispatch-events.log` (`*_REFUSED`/`*_FAILED` lines naming
 *               a job, two or more since its last LAUNCH, still active
 *               inside the one-hour quiet window) plus the ready list's
 *               lane attribution, so this source and those surfaces can
 *               never disagree. Until now a job the dispatcher could
 *               never place — a lane refusing its size or repo every
 *               tick, a worktree cleanup that keeps failing — had no
 *               item-level surface here: the router-queue source lists
 *               only READY rows in `queue/router-queue.md`, the
 *               queue-parked source lists only PARKED rows, the
 *               jobs-stuck source reads run markers for jobs already
 *               launched, and every bus/feed/board read looks at work
 *               not yet claimed — while the refused job sat in the queue
 *               generating refusal events an agent had to already know to
 *               look for. Each stuck row lists once as a warn
 *               `dispatch-stuck` naming the job id — the same label
 *               `phm fleet stuck` prints — `since` the first recorded
 *               refusal or failure (the moment the stuck condition
 *               began) and `expiresAt` null: a refused job waits for a
 *               lane move or a queue edit, never a guessed deadline; the
 *               job id is the item's own citation, so `--job` matches.
 *               Lane-refusal causes deep-link `phm queue lane <id>
 *               <lane>` — the steer that moves the row — a worktree
 *               cleanup failure deep-links `phm fleet worktrees`, and an
 *               unrecognised cause deep-links `phm fleet
 *               dispatch-events` to read the raw lines, every item
 *               leading with `phm fleet stuck`. The event log is the
 *               only witness a job is being refused, so `phm fleet
 *               stuck`'s own rule applies — a missing or unreadable log
 *               leaves the stuck set unknown, 'unavailable' (pending
 *               null), never an empty list passed off as fact; a
 *               degraded ready read still lists every event-proven job
 *               but marks the source 'degraded' — lane attribution is a
 *               floor, never a complete set.
 *
 * Ordering is the same deterministic contract the Needs-you surfaces use
 * (decide/needs-you.ts): severity band first, then the pure priority
 * heuristic, then expiry, then newest. `options.filter` narrows the returned
 * items by stored source, severity, blocking, job citation or appearance
 * time while every
 * per-source report stays unfiltered. Never a model call, never throws, and
 * never mutates: a degraded store reports its source state and the remaining
 * sources still list. Bus work bodies are untrusted data — titles are scrubbed
 * and single-lined, never dispatched. Deep links are command text only;
 * claiming coordinates work and grants no execution authority.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { busWorkFeedHoldIndex, BUS_FEED_OPEN_STATUSES, readBusWorkFeed, type BusWorkFeedJob, type BusWorkFeedReadResult } from '../agents/bus-work-feed-read.js';
import { busBodyFallbackSummary, busBodyJobIds, busBodySummary, readAllWakes,
  type AgentWakeRow, type AllWakesPage } from '../agents/bus-unified.js';
import { coordinationRowBlocks, listCoordination } from '../agents/claim-store.js';
import { readPendingProposals, readTeamApprovals, type ProposalApprovalItem, type TeamApprovalItem } from '../approvals/surface.js';
import { listDrafts, type Draft } from '../cos/drafts.js';
import { commsRunsRoot, listDrafts as listCommsAgentDrafts, readInbox as readCommsAgentInbox, type CommsDraft, type InboxRead } from '../comms-agent/store.js';
import { compareRanked, needsYouPriorityHeuristic, type AttentionItem, type NeedsYouPriority, type RankedAttentionItem } from '../decide/needs-you.js';
import { BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter, type BusInboxInspection, type BusInboxOptions, type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { createBusMailbox, type BusMailboxPendingMessage } from '../fleet/bus-mailbox.js';
import { readBusBoardPending, type BusBoardPendingRead } from '../fleet/bus-board.js';
import { busBoardDeliveryText } from '../fleet/bus-delivery.js';
import { BUS_PROTOCOL_KEY, isClaimableWork, type BusPriority } from '../fleet/bus-envelope.js';
import { busReplyCitations, handoffAnswerScope, isWorkerHandoffBody, workerHandoffAnswered, type BusReplyCitation, type HandoffAnswerScope } from '../fleet/handoff-body.js';
import { readAgentRegistry, resolveAgent } from '../agents/bus-identity.js';
import { inspectBusWorkClaims, type BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import { readNeedsMason, type NeedsMasonItem, type NeedsMasonReadResult } from '../fleet/needs-mason-resolve.js';
import { readNeedsMasonReplyDeliveries, type NeedsMasonReplyDeliveryReport } from '../fleet/needs-mason-relay.js';
import { loadConfigReadOnly, loadConfigReadOnlyStrict } from '../config.js';
import type { AshlrConfig } from '../types.js';
import { assertMetadata } from '../connectors/profile.js';
import { readEmailDropConfig, readEmailDropInbox } from './email-drop-config.js';
import { probeOutboxDir, readEmailOutbox, type EmailOutboxEntry, type EmailOutboxListing } from './email-outbox.js';
import { gmailArchivePlanLatestPath, readGmailArchivePlanLatest } from './gmail-archive-plan-latest.js';
import { readLinkedInDrop, type LinkedInMessage } from './linkedin-drop.js';
import { readOwnerAwaitingReplies, readOwnerUndeliveredReplies, type OwnerAwaitingReplies, type OwnerUndeliveredReplies } from './owner-thread.js';
import { fixedOwnerConfigDir } from './owner-channel.js';
import { readOwnerPairPending, type OwnerPairPendingRead } from './owner-pair-pending.js';
import { commsRequestAgeStartMs, commsRequestTtlMs, DEFAULT_REQUEST_TTL_HOURS, readCommsRequests, type CommsRequestsRead } from './requests.js';
import { probePauseState, type PauseProbe } from './pause.js';
import { readAgentConversations, plainAge, type AgentConversations } from '../fleet/agent-conversations.js';
import { readSlackJournal, type SlackJournalRead, type SlackObservation } from '../agents/slack-journal.js';
import { readSlackSendReceipts, type SlackSendReceiptRead } from '../agents/slack-send-receipts.js';
import type { SentReceipt } from '../agents/slack-reply-binding.js';
import { isSlackChannelId, isSlackTs } from '../agents/slack-network.js';
import { JOB_THREAD_PREFIX } from '../fleet/agent-messages.js';
import { classifyNeedsYou } from '../needs-you/classify.js';
import { planSeatHandoffs, type SeatHandoffsPlan } from '../bots/seats.js';
import type { WorkDispatchJournal } from '../agentnet/work-dispatch-journal.js';
import { busBodyKind, workResultBodySchema } from '../agents/bus-v2-schema.js';
import { realHome } from '../real-home.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { z } from 'zod';
import { DEFAULT_TEAM } from '../teams/tools.js';
import { scrubSecrets } from '../util/scrub.js';
import { classifyTeammateIntent, readTeammateTexts, type TeammateText } from './imessage-teammate-inbox.js';
import { listTeammateTasks } from './imessage-teammate-tasks.js';
import { imessageStateDir } from '../integrations/imessage.js';
import { readLeaderThreadUndelivered, type LeaderThreadUndeliveredRead } from '../vision/leader-thread.js';
import { readLeaderNetworkState, type LeaderNetworkStateRead } from '../agents/leader-network-read.js';
import { readLeaderRepliesLedger, type LeaderRepliesLedgerRead } from './leader-replies-ledger.js';
import { readFleetCoordinationPending, type FleetCoordinationPending } from '../fleet/coordination.js';
import { readClaimStoreDrift, type ClaimDriftRow, type ClaimStoreDrift } from '../fleet/claim-store-drift.js';
import { listSessionHandoffs, type SessionHandoffList } from '../agents/session-handoff.js';
import { handoffPressure } from '../agents/session-handoff-schema.js';
import { ashlrHome } from '../cloud/store.js';
import { listWorkBoard, WORK_BOARD_MAX_LIMIT, type WorkBoardResult } from './work-board.js';
import type { WorkItemState } from './work-item-state.js';
import { readKillSwitch, type KillSwitchReadResult } from '../sandbox/policy.js';
import { readStuckQueue, type StuckJob } from '../queue/stuck.js';
import { readStuckJobs, type StuckJob as RunningStuckJob, type StuckJobsReport } from '../fleet/running-stuck.js';
import { readStuckFixes, type StuckFixRow } from '../fleet/stuck-fixes.js';
import { readStrandedWork, type StrandedItem } from '../fleet/stranded-work.js';
import { readDispatchStuckJobs, type DispatchStuckRead } from '../fleet/dispatch-stuck.js';
import type { StuckJob as DispatchStuckJob } from '../fleet/stuck-jobs.js';
import { isDependencyParkedReason, readFleetQueue, type FleetQueueV1, type ParkedGroup, type ParkedMetDep, type ParkedUnmetDep } from '../fleet/runs-parked-queue.js';
import { readChannelHealth } from '../fleet/channel-health.js';
import { readTelegramHealth, telegramEnabled } from '../integrations/telegram.js';

export const UNIFIED_INBOX_MAX_ITEMS = 200;
/** Longest `--contains` needle the unified view accepts; the title/detail text it matches is already bounded far shorter. */
export const UNIFIED_INBOX_CONTAINS_MAX = 512;
const TITLE_MAX = 160;
const DETAIL_MAX = 300;
const SUGGESTED_LEASE_MS = 600_000;

/** Every pending-work source the unified view can report, in display order. */
export const UNIFIED_INBOX_SOURCES = [
  'needs-you', 'needs-you-delivery', 'imessage', 'teammate-tasks', 'owner-thread',
  'owner-delivery', 'owner-pair', 'drafts', 'comms-mail', 'bus', 'mailbox', 'board', 'work-board', 'conversations', 'wakes', 'seats',
  'peer-dispatch', 'peer-inbox', 'session-handoff', 'org-outbox', 'gmail', 'linkedin', 'requests', 'email-inbox', 'email-outbox', 'team-approvals', 'proposals', 'slack',
  'slack-sends', 'leader-delivery', 'leader-network', 'leader-replies', 'coordination', 'claim-drift',
  'send-gate', 'router-queue', 'jobs-stuck', 'channel-health', 'queue-parked',
  'stuck-fixes', 'stranded-work', 'dispatch-stuck',
] as const;
export type UnifiedInboxSource = (typeof UNIFIED_INBOX_SOURCES)[number];
export const isUnifiedInboxSource = (value: string): value is UnifiedInboxSource =>
  (UNIFIED_INBOX_SOURCES as readonly string[]).includes(value);
export type UnifiedInboxSourceState = 'healthy' | 'missing' | 'degraded' | 'unavailable';
export type UnifiedInboxSeverity = 'info' | 'warn' | 'high';
const UNIFIED_INBOX_SEVERITIES: readonly UnifiedInboxSeverity[] = ['info', 'warn', 'high'];
export const isUnifiedInboxSeverity = (value: string): value is UnifiedInboxSeverity =>
  (UNIFIED_INBOX_SEVERITIES as readonly string[]).includes(value);
/** Every pending-item kind the unified view can report. Most kinds are 1:1
 * with their source; the `bus` source splits into
 * `bus-work`/`bus-handoff`/`bus-dead-letter`, the `board` source into
 * `board-delivery`/`board-task`, `work-board` into its three pending
 * states and `claim-drift` into its three row
 * classes, the `queue-parked` source into its dependency-gate
 * waiting/stale split plus one `parked-group` item per non-dependency
 * parked reason and lane, so `kind` is the finer classification
 * `--kind` filters on. */
export const UNIFIED_INBOX_KINDS = [
  'needs-you', 'needs-you-delivery', 'teammate-text', 'teammate-task', 'owner-message',
  'owner-reply-undelivered', 'owner-pair-waiting', 'draft-approval', 'comms-mail', 'bus-work', 'bus-handoff', 'bus-dead-letter', 'mailbox-message',
  'board-delivery', 'board-task', 'work-board-received', 'work-board-assigned', 'work-board-blocked',
  'agent-thread', 'wake-hint', 'seat-handoff', 'peer-dispatch-result', 'peer-message', 'session-handoff', 'org-membership', 'gmail-over-target',
  'linkedin-message', 'comms-request', 'email-inbound', 'email-stuck', 'team-approval',
  'inbox-proposal', 'slack-request', 'slack-send-unconfirmed', 'leader-message-undelivered',
  'leader-request', 'leader-request-incomplete', 'leader-reply-unconfirmed', 'leader-digest-unconfirmed',
  'leader-reply-failed', 'leader-reply-orphaned',
  'coordination-message', 'coordination-assignment', 'coordination-return-unposted',
  'claim-drift-bus', 'claim-drift-coordination', 'claim-drift-owner',
  'send-gate-kill', 'send-gate-pause', 'router-queue-job',
  'stuck-ghost', 'stuck-job',
  'channel-blocked', 'channel-degraded', 'channel-unknown',
  'parked-dep-waiting', 'parked-dep-stale', 'parked-group', 'stuck-fix',
  'stranded-worktree', 'dispatch-stuck',
] as const;
export type UnifiedInboxKind = (typeof UNIFIED_INBOX_KINDS)[number];
export const isUnifiedInboxKind = (value: string): value is UnifiedInboxKind =>
  (UNIFIED_INBOX_KINDS as readonly string[]).includes(value);

export interface UnifiedInboxItem extends AttentionItem {
  /** Stable, namespaced: `<source>:<ref>` (e.g. `drafts:d-0123…`). */
  readonly id: string;
  readonly source: UnifiedInboxSource;
  readonly kind: UnifiedInboxKind;
  readonly severity: UnifiedInboxSeverity;
  readonly priority: NeedsYouPriority;
  readonly blocking: boolean;
  readonly title: string;
  readonly detail: string | null;
  /** ISO time the item appeared; null when the store keeps none. */
  readonly since: string | null;
  /** ISO time it stops being actionable (a bus TTL); null when none. */
  readonly expiresAt: string | null;
  /**
   * Every job id the item provably names, sorted — the citation set each
   * source's own `--job` rule keys on: a bus or mailbox envelope's
   * `busBodyJobIds` body citation, a feed job's own id, a board task's
   * `itemId` (a delivery carries the itemIds of the tasks on its thread,
   * the job-carrying-thread rule `BusBoard.pendingFor` applies), a
   * conversation thread's `jobs`, a teammate task's `jobId`, a seat handoff's
   * node-job refs, a peer-dispatch receipt's peer-announced `jobId`, a
   * session-handoff journal's job id, a router-queue row's own READY id, a
   * jobs-stuck marker's own job id, a queue-parked row's own job id plus
   * the gate ids it names, a stuck-fix row's own job id, a
   * stranded-work row's own job id, or a dispatch-stuck row's own job id.
   * Absent when the item names no job — unknown stays out of a
   * `--job` match rather than being guessed in.
   */
  readonly jobIds?: readonly string[];
  /** Deep-link commands that act on this item, most direct first. */
  readonly act: readonly string[];
}

export interface UnifiedInboxSourceReport {
  state: UnifiedInboxSourceState;
  /** Pending items the source found (before the global cap), never narrowed
   * by a view `filter`: it is the store-health report, so a filtered read
   * cannot hide a busy or degraded source behind an empty match set. Null
   * when `state` is 'unavailable' — an unreadable store's pending total is
   * unknown, never a fabricated 0; 'missing' is a verified-empty store, so
   * its real total is 0, and 'degraded' still counts the items found while
   * the state flags the partial read. */
  pending: number | null;
}

/**
 * Optional narrowing of the returned item list. Every dimension is a stored
 * item field — never a derived guess — and the dimensions AND together. An
 * empty or absent filter is an unfiltered read.
 */
export interface UnifiedInboxFilter {
  /** Keep only items this source contributed. */
  source?: UnifiedInboxSource;
  /** Keep only items of this kind — the item's own classification, finer
   * than `source` where one source emits several kinds (the `bus` source's
   * `bus-work`/`bus-handoff`/`bus-dead-letter` split, the `board` source's
   * `board-delivery`/`board-task` split). */
  kind?: UnifiedInboxKind;
  /** Keep only items at this severity band. */
  severity?: UnifiedInboxSeverity;
  /** Keep only blocking items when true, only non-blocking when false. */
  blocking?: boolean;
  /** Keep only items that provably name this job id — the same citation
   * rule every `--job` bus read shares, joined with the feed-id, board
   * `itemId`, conversation-thread, teammate-task, seat node-job,
   * peer-dispatch `jobId` and session-handoff journal citations each
   * source already records in `jobIds`. */
  job?: string;
  /** Keep only items whose recorded `since` (ISO appearance time) parses to
   * at or after this epoch-ms cutoff — the same inclusive `>=` match every
   * bus read `--since` applies. An item whose store keeps no timestamp
   * (`since` null) or whose recorded time cannot be parsed never matches:
   * unknown stays out of the match rather than being counted as recent. */
  since?: number;
  /** Keep only items whose recorded `since` (ISO appearance time) parses to
   * strictly before this epoch-ms cutoff — the exclusive `<` upper bound
   * composing with `since` into one `[since, before)` window, the same rule
   * every bus read `--before` applies. An item exactly on the cutoff, whose
   * store keeps no timestamp (`since` null) or whose recorded time cannot be
   * parsed never matches: unknown stays out of the match rather than being
   * counted as old. */
  before?: number;
  /** Keep only items whose displayed text carries this search string — a
   * case-insensitive substring over the item's scrubbed `title` and `detail`,
   * whitespace collapsed on both sides the same way every other bus read's
   * `--contains` applies, so a phrase typed across the title/detail boundary
   * still finds its item and a match is always visible in the row it
   * selects. The `act` deep links are commands, never item content, and
   * stay out of the match; source/kind labels have their own dimensions.
   * Callers bound the raw value to UNIFIED_INBOX_CONTAINS_MAX. */
  contains?: string;
}

export interface UnifiedInbox {
  v: 1;
  generatedAt: string;
  sources: Record<UnifiedInboxSource, UnifiedInboxSourceReport>;
  /** Pending items across every source, before the display cap — the items
   * matching `filter` when one is applied. */
  total: number;
  /** Pending items left off `items` by UNIFIED_INBOX_MAX_ITEMS (matching
   * `filter` when one is applied). */
  omitted: number;
  /** The applied view filter; absent on an unfiltered read. */
  filter?: UnifiedInboxFilter;
  items: UnifiedInboxItem[];
}

/** The resolved email-drop inbox read: a unified source state plus the real pending-file count, the freshest arrival the directory listing proved, and the two conditions that explain a stuck backlog. */
export interface EmailInboxSourceRead {
  state: UnifiedInboxSourceState;
  /** `.eml` entries awaiting the drop pass — the real directory count. */
  pending: number;
  /** Newest entry mtime (ISO) — filesystem evidence of the last arrival on the pending set; null when no entry stat succeeded. */
  since: string | null;
  /** The inbox folder is other-writable: the pass refuses it, so these files cannot move until permissions are fixed. */
  unsafe: boolean;
  /** The saved config sets `enabled:false` — polling is paused by owner choice while files stay pending. */
  paused: boolean;
}

/** One reply artifact as the email-outbox source reports it: name, state and the fixed stuck reason — never a recipient, subject, body or path. */
export type EmailOutboxSourceEntry = Pick<EmailOutboxEntry, 'name' | 'state' | 'reason'>;

/** The resolved email-outbox read: a unified source state plus every artifact row, stuck included. */
export interface EmailOutboxSourceRead {
  state: UnifiedInboxSourceState;
  entries: readonly EmailOutboxSourceEntry[];
}

/** The resolved legacy-mailbox read: `BusMailbox.pendingAll`'s own result —
 * `matched` is the true pending total, null when the store cannot be read. */
export interface MailboxPendingRead {
  source: 'missing' | 'available' | 'unavailable';
  messages: readonly BusMailboxPendingMessage[];
  matched: number | null;
}

/** The resolved router-queue stuck read: `readStuckQueue`'s READY-without-
 * launch rows mapped onto the unified source states — 'missing' a
 * verified-absent queue file (no READY rows can exist), 'unavailable' an
 * unreadable one, 'degraded' a missing dispatch-events log (every READY row
 * then lists with its launch state unproven — the read may over-report),
 * 'healthy' the full read. `jobs` stays empty whenever the state is not
 * 'healthy'/'degraded'. */
export interface RouterQueueStuckRead {
  state: UnifiedInboxSourceState;
  jobs: readonly StuckJob[];
}

/** The resolved jobs-stuck read: `readStuckJobs`'s ghost/stuck rows mapped
 * onto the unified source states — 'missing' a verified-absent run-marker
 * directory (`queue/run` itself missing: no job can count as running, so
 * nothing can be stuck), 'unavailable' any other read failure (the stuck
 * set is unknown, never an empty list), 'healthy' the full read. `jobs`
 * stays empty whenever the state is 'missing'/'unavailable'. */
export interface JobsStuckSourceRead {
  state: UnifiedInboxSourceState;
  jobs: readonly RunningStuckJob[];
}

/** The resolved queue-parked read: `readFleetQueue`'s parked rows mapped
 * onto the unified source states — 'missing' a verified-absent
 * `queue/ready.tsv` (no parked rows can exist), 'unavailable' any read
 * failure (the parked set is unknown, never an empty queue), 'degraded' a
 * partial read (listed rows are a floor), 'healthy' the full read.
 * `waiting`/`stale` stay empty whenever the state is 'missing'/
 * 'unavailable'. `groups` carries the parked groups whose reason is NOT a
 * dependency gate — the `DEP`/`DEPENDENCY` rows stay on `waiting`/`stale`
 * so no row lists twice — each the projection's own reason+lane rollup
 * with its true count and up to eight listed job ids. */
export interface QueueParkedRead {
  state: UnifiedInboxSourceState;
  waiting: readonly ParkedUnmetDep[];
  stale: readonly ParkedMetDep[];
  groups: readonly ParkedGroup[];
}

/** The resolved stuck-fixes read: `readStuckFixes`'s ledger fold mapped onto
 * the unified source states — 'missing' a verified-absent
 * `metrics/jobs.jsonl` (no job rows can exist, so no fix PR can be on
 * record — `phm fleet main-health`'s own rule), 'unavailable' a ledger
 * that exists but cannot be folded or a path that cannot be inspected
 * (the stuck set is unknown, never an empty list), 'healthy' the full
 * read. `stuck` stays empty whenever the state is 'missing'/
 * 'unavailable'. */
export interface StuckFixesSourceRead {
  state: UnifiedInboxSourceState;
  stuck: readonly StuckFixRow[];
}

/** The resolved stranded-work read: `readStrandedWork`'s kept-worktree
 * fold mapped onto the unified source states — 'missing' a
 * verified-absent `queue/status.json` (no kept worktree can be listed,
 * so no finished work can be stranded), 'unavailable' a kept list that
 * exists but cannot be read or a throwing read (the stranded set is
 * unknown, never an empty list), 'degraded' a known read carrying gaps
 * (an unreadable metrics ledger leaves finish times and sizes unknown —
 * the listed rows are a floor), 'healthy' the full read. `items` stays
 * the projection's own stranded rows — recovered and already-on-main
 * rows included — so the item builder, not the seam, decides which rows
 * list as pending. */
export interface StrandedWorkSourceRead {
  state: UnifiedInboxSourceState;
  items: readonly StrandedItem[];
}

/** The resolved dispatch-stuck read: `readDispatchStuckJobs`'s
 * `fleet.stuck.v1` rows mapped onto the unified source states —
 * 'unavailable' an event log that is missing or cannot be read (the
 * stuck set is unknown — `phm fleet stuck`'s own `count:null` rule —
 * never an empty list), 'degraded' a healthy log whose ready read is
 * partial (every event-proven job still lists; lane attribution is a
 * floor), 'healthy' the full read. `jobs` stays empty whenever the
 * state is 'unavailable'. */
export interface DispatchStuckSourceRead {
  state: UnifiedInboxSourceState;
  jobs: readonly DispatchStuckJob[];
}

/** The resolved shared-board read: `BusBoard.pendingAll`'s fleet-wide digest
 * when the store could be read — 'missing' is a verified-empty board (no
 * `state.json` ever written), 'unavailable' an unreadable one, never an
 * empty list passed off as fact. */
export type BoardPendingRead = BusBoardPendingRead;

/** One org.membership bus event the org-plane ledger recorded but `phm fleet org-sync --apply` has not yet confirmed posted — the same stable envelope id the apply pass would post. */
export interface OrgOutboxEvent {
  /** Stable bus envelope id (`org-<storeId>-<revision>-<roleId>`) the apply pass dedupes on. */
  readonly id: string;
  /** Ledger revision the event belongs to (contiguous, 1-based). */
  readonly revision: number;
  readonly roleId: string;
  /** The proposing actor recorded on the ledger entry. */
  readonly actor: string;
  /** The role's bus-facing tier and status — `edit.after?.status ?? 'retired'`, the same rule `envelopes` applies. */
  readonly tier: string;
  readonly status: string;
  /** ISO time the ledger entry was applied. */
  readonly at: string;
}

/** The resolved org-plane outbox read: 'missing' is a verified-absent store, 'unavailable' any refusal `readAgentPlane` would raise — never an empty backlog passed off as fact. */
export interface OrgOutboxRead {
  status: 'missing' | 'unavailable' | 'ok';
  events: readonly OrgOutboxEvent[];
}

/** One bus envelope the peer-inbox admission proofs accept for at least one
 * live-enrolled callsign — the itemization detail behind the `peerInbox`
 * count `phm agents bus status` reports. Fields are the stored envelope's
 * own untrusted values plus the sorted callsigns whose `peers read` session
 * admits it; bodies stay opaque here and are summarized only at item build. */
export interface PeerInboxPending {
  /** The original envelope's wire id — `peers read --id` and `agents bus show` take it. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** The envelope's own P0..P3 band, carried for severity mapping. */
  readonly priority: string;
  /** Store receipt time (epoch ms) — the same stamp `peers read` reports. */
  readonly receivedAt: number;
  /** The envelope's own TTL in ms — `receivedAt + ttl` is its real expiry. */
  readonly ttl: number;
  readonly body: unknown;
  /** Live-enrolled callsigns this envelope is admitted for, sorted. */
  readonly admittedFor: readonly string[];
}

/** The resolved peer-inbox read: 'missing' a verified-empty peer plane or
 * bus store (no enrolled callsign can hold admitted mail), 'available' the
 * full admitted set, 'unavailable' any input the admission proofs cannot
 * read — an unreadable journal leaves work.result mail unprovable, so the
 * total is unknown rather than a ledger-only undercount. `truncated` marks
 * a bounded bus scan that could not cover every retained receipt: `messages`
 * is then a floor, never a complete list passed off as fact. */
export interface PeerInboxRead {
  state: 'missing' | 'available' | 'unavailable';
  messages: readonly PeerInboxPending[];
  truncated: boolean;
}

export interface UnifiedInboxOptions {
  /** Shared runs context (`~/.ashlr-runs`): needs-you, teammate text/task and draft stores. */
  runsDir?: string;
  /** Private bus store root (`~/.ashlr/fleet` by default). */
  busRoot?: string;
  now?: () => number;
  /** Trusted test seams; defaults read the real stores. */
  readNeeds?: (options: { runsDir?: string }) => NeedsMasonReadResult;
  /** Reply-delivery seam; default reads the same receipts `phm fleet needs` reports. */
  readNeedsDeliveries?: typeof readNeedsMasonReplyDeliveries;
  readTexts?: typeof readTeammateTexts;
  /** Teammate-task ledger seam; default reads `<imessageStateDir>/teammate-tasks.json` like `phm fleet imessage-tasks list`. */
  readTeammateTasks?: (options: { runsDir?: string }) => TeammateTaskLedgerRead;
  listPendingDrafts?: typeof listDrafts;
  /** Comms-agent draft store seam; default reads `<runsDir>/comms-agent/drafts.jsonl`. */
  listCommsDrafts?: (runsDir: string) => Promise<CommsDraft[]>;
  /** Comms-agent inbox seam; default reads `<runsDir>/comms-agent/inbox.json`
   * through `readInbox` — the same document `phm comms-agent run` triages. */
  readCommsInbox?: (runsDir: string) => Promise<InboxRead>;
  listBus?: typeof listBusInboxAfter;
  inspectBus?: typeof inspectBusInbox;
  /** Legacy `phm bus` mailbox seam; default reads `pendingAll` under the fleet root's parent. */
  readMailbox?: (options: { busRoot?: string; now?: () => number }) => MailboxPendingRead;
  /** Shared task board seam; default reads `BusBoard.pendingAll` through the shared `readBusBoardPending` under the same `busBoardStoragePaths` derivation `phm bus board`, `work mine` and `agents bus status` share. */
  readBoard?: (options: { busRoot?: string; now?: () => number }) => BoardPendingRead;
  /** Coordination work-board seam; default reads `listWorkBoard` — the same `classifyWorkItem` projection `phm fleet work-board`, `fleet_work_board` and the cloud work-board route serve — under the same bus root the board's own readers derive. */
  readWorkBoard?: typeof listWorkBoard;
  readClaims?: (root?: string) => BusWorkClaimsInspection;
  readCoordination?: typeof listCoordination;
  readFeed?: typeof readBusWorkFeed;
  readGmailPlans?: typeof readGmailArchivePlanLatest;
  readLinkedIn?: typeof readLinkedInDrop;
  readOwnerAwaiting?: (options: { runsDir: string }) => OwnerAwaitingReplies;
  /** Undelivered-reply seam; default reads the same owner thread plus its delivery receipts. */
  readOwnerUndelivered?: (options: { runsDir: string }) => OwnerUndeliveredReplies;
  /** Owner-pair seam; default reads `<fixedOwnerConfigDir()>/comms/owner-pair.json`
   * through `readOwnerPairPending` — the same state file `phm owner pair status`
   * and the owner-live self-tick consult, minus the handles (only the sent count
   * ever leaves the store). */
  readOwnerPair?: (options: { configDir: string }) => OwnerPairPendingRead;
  readConversations?: typeof readAgentConversations;
  /** Wake-hint seam; default reads `readAllWakes` fleet-wide under the same
   * bus root and runs dir `agents bus wakes --all`/`fleet_agent_wakes` use. */
  readWakes?: (options: { root?: string; runsRoot?: string; now?: () => number }) => AllWakesPage;
  readSeatHandoffs?: typeof planSeatHandoffs;
  /** Peer-dispatch journal seam; default reads `agentnet/work-dispatch.json` under the bus root like `phm agentnet peers dispatch`. */
  readPeerDispatch?: (options: { busRoot?: string }) => WorkDispatchJournal;
  /** Peer-inbox seam; default applies `readPeerInbox`'s admission proofs fleet-wide — the same bindings, coordination-ledger, dispatch-journal and bus-store reads `phm agentnet peers read` and the `peerInbox` section of `phm agents bus status` resolve. */
  readPeerInbox?: (options: { busRoot?: string; bindings?: string; now?: () => number }) => PeerInboxRead;
  /** Peer bindings path override — the same `PeerBusOptions.bindings`/`agentnetBindings` resolution the peer verbs and the bus-status probe apply (`<realHome>/.ashlr/agentnet/bindings.json`); a `busRoot` override never relocates it. */
  agentnetBindings?: string;
  /** Session-handoff seam; default reads `<runsDir>/handoffs` through `listSessionHandoffs` — the same bounded journal scan `phm checkpoint handoff list`, `fleet_session_handoffs`, the bus-status probe and `work mine`'s sessions section serve. */
  readSessionHandoffs?: (options: { runsDir?: string }) => SessionHandoffList;
  /** Org-plane outbox seam; default reads `<runsDir>/org/agents.json` like `phm fleet org-sync`/`org-board`. */
  readOrgOutbox?: (options: { runsDir?: string }) => OrgOutboxRead;
  readRequests?: typeof readCommsRequests;
  /** Test seam: the request TTL `expiresAt` uses; default resolves cfg.comms.requestTtlHours like dispatch. */
  requestTtlMs?: number;
  readEmailInbox?: (options: { runsDir?: string }) => Promise<EmailInboxSourceRead>;
  readEmailOutbox?: (options: { runsDir?: string }) => Promise<EmailOutboxSourceRead>;
  /** Team-approvals seam; default reads the DEFAULT_TEAM event log like `phm approvals`. */
  readTeamApprovals?: typeof readTeamApprovals;
  /** Pending-proposals seam; default reads the inbox store like `phm approvals`. */
  readInboxProposals?: typeof readPendingProposals;
  /** Slack journal seam; default reads the same bounded journal `phm fleet slack-trace` and `phm channels slack status` project. */
  readSlackJournal?: typeof readSlackJournal;
  /** Slack send-store seam; default reads the same receipts `phm channels slack status` counts as `uncertainSends` and `phm fleet slack-trace` binds replies from. */
  readSlackSends?: typeof readSlackSendReceipts;
  /** Leader-thread delivery seam; default reads the same thread log and delivery index `drainLeaderThread` drains — the read-only scan, never the memo-syncing list paths. */
  readLeaderUndelivered?: typeof readLeaderThreadUndelivered;
  /** Leader-network seam; default reads `<runsDir>/leader/network-state.json` through the same bounded anchored read `readRouteReplyFacts` applies — never the locking `pending()` recovery pass. */
  readLeaderNetwork?: (options: { runsDir?: string }) => LeaderNetworkStateRead;
  /** Leader-reply ledger seam; default reads `<imessageStateDir>/leader-sent.jsonl` through the same last-status-per-hash fold `readClaimed` applies and resolves reply text through the bounded outbox read the sender uses. */
  readLeaderReplies?: (options: { runsDir?: string; now?: () => number }) => Promise<LeaderRepliesLedgerRead>;
  /** Coordination-ledger seam; default reads the advisory `fleet.coordination.v1` ledger through `readFleetCoordinationPending` — the same replay `readFleetBoard` runs, never its reaping mutation path. */
  readFleetCoordination?: typeof readFleetCoordinationPending;
  /** Claim-drift seam; default reads the same `fleet.claim-drift.v1` verdict `phm fleet claim-drift` and the bus-status probe's `claimDrift` section serve. */
  readClaimDrift?: typeof readClaimStoreDrift;
  /** Kill-switch seam; default reads the sentinel through `readKillSwitch` — the same inspection `agents bus status`'s sendGate section serves. */
  readKillSwitch?: typeof readKillSwitch;
  /** Comms-pause seam; default reads `probePauseState` — the same inspection the sendGate pause verdict serves. */
  probePause?: typeof probePauseState;
  /** Router-queue seam; default reads `<runsDir>/queue/router-queue.md` and
   * `dispatch-events.log` through `readStuckQueue` — the same bounded read
   * `phm queue stuck` and the desktop Queue view serve. */
  readRouterQueue?: (options: { runsDir?: string; now?: () => number }) => Promise<RouterQueueStuckRead>;
  /** Jobs-stuck seam; default reads `<runsDir>/queue/run` markers through
   * `readStuckJobs` — the same bounded read `phm jobs stuck` and the
   * `--stuck` pass of `phm fleet stray-stop` serve. */
  readJobsStuck?: (options: { runsDir?: string; now?: () => number }) => Promise<JobsStuckSourceRead>;
  /** Queue-parked seam; default reads `<runsDir>/queue/ready.tsv` plus
   * `metrics/jobs.jsonl` through `readFleetQueue` with `depDetail` — the
   * same bounded read `phm fleet queue-parked` and the autopilot's
   * `stale-parked-deps` gap serve. */
  readQueueParked?: (options: { runsDir?: string; now?: () => number }) => Promise<QueueParkedRead>;
  /** Stuck-fixes seam; default reads `<runsDir>/metrics/jobs.jsonl` through
   * `readStuckFixes` — the same fold `phm fleet stuck-fixes`, `phm fleet
   * main-health`, the verse runs-history route and the web-ui needs-you
   * strip serve. */
  readStuckFixes?: (options: { runsDir?: string; now?: () => number }) => Promise<StuckFixesSourceRead>;
  /** Stranded-work seam; default reads kept worktrees through
   * `readStrandedWork` — the same fold `phm fleet stranded` serves, over
   * `<runsDir>/queue/status.json`, `metrics/jobs.jsonl`, the `.publish`
   * sidecars and the queue run markers. */
  readStrandedWork?: (options: { runsDir?: string; now?: () => number }) => Promise<StrandedWorkSourceRead>;
  /** Dispatch-stuck seam; default reads the `dispatch-events.log` tail,
   * `queue/ready.tsv` and `queue/router-queue.md` through
   * `readDispatchStuckJobs` — the same bounded read `phm fleet stuck`
   * and the `fleet.stuck.v1` row of `phm fleet vitals` serve. */
  readDispatchStuck?: (options: { runsDir?: string; now?: () => number }) => Promise<DispatchStuckSourceRead>;
  /** Channel-health seam; default reads `readChannelHealth` — the same
   * slack/imessage bridge projection `phm fleet channel-health` and
   * `phm channels` serve. */
  readChannelHealth?: typeof readChannelHealth;
  /** Config seam for the telegram leg; default `loadConfigReadOnlyStrict` —
   * a malformed config reports the telegram channel unknown, never a
   * guessed default. */
  readChannelConfig?: () => AshlrConfig;
  /** Telegram poll-health seam; default `readTelegramHealth` — the same
   * read `phm comms health --json` serves. */
  readTelegramPoll?: typeof readTelegramHealth;
  /** Optional narrowing of the returned item list by stored source, severity,
   * blocking, job citation, appearance time or display text. `total`/`omitted`/`items` then
   * describe the matched view and the applied filter echoes on the report;
   * `sources` stays unfiltered. */
  filter?: UnifiedInboxFilter;
}

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string, max: number): string => cap(scrubSecrets(text).replace(/\s+/g, ' ').trim(), max);
const iso = (ms: number): string => new Date(ms).toISOString();
/** The per-source `pending` value: the items the source found, or null when
 * the store could not be read at all — an 'unavailable' source's true pending
 * total is unknown, never a fabricated 0 ('missing' is a verified-empty
 * store, so its real total is 0; 'degraded' counts what it found). */
const pendingCount = (state: UnifiedInboxSourceState, count: number): number | null =>
  state === 'unavailable' ? null : count;
/** `jobIds` only when the citation set is non-empty — absent means the item names no job, never a guess. */
const jobIdsField = (ids: Iterable<string>): { jobIds?: readonly string[] } => {
  const sorted = [...new Set(ids)].sort();
  return sorted.length === 0 ? {} : { jobIds: sorted };
};

function needsYouItems(read: NonNullable<UnifiedInboxOptions['readNeeds']>, runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: NeedsMasonReadResult;
  try { result = read({ runsDir }); } catch { result = { status: 'unavailable', items: [] }; }
  const state: UnifiedInboxSourceState = result.status === 'available' ? 'healthy' : result.status;
  const items = result.items.map((item: NeedsMasonItem): Omit<UnifiedInboxItem, 'priority'> => {
    // The same verdict `phm needs-you` reports: only a hard-limit item waits
    // on Mason. An auto item is ordinary work the fleet resolves itself, so
    // it lists non-blocking with `resolve --auto` as its first act — pending
    // work, never a Mason block. `classifyNeedsYou` is pure and never throws.
    const verdict = classifyNeedsYou({ text: item.text });
    const hard = verdict.class === 'hard_limit';
    return {
      id: `needs-you:${item.id}`,
      source: 'needs-you',
      kind: 'needs-you',
      severity: 'warn',
      blocking: hard,
      title: oneLine(item.text, TITLE_MAX),
      detail: oneLine(`${verdict.class === 'hard_limit' ? 'hard limit' : 'auto'} — ${verdict.reason}`, DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      act: hard
        ? [`phm fleet needs-resolve ${item.id} --reply "<reply>"`]
        : ['phm needs-you resolve --auto', `phm fleet needs-resolve ${item.id} --reply "<reply>"`],
    };
  });
  return { report: { state, pending: pendingCount(state, items.length) }, items };
}

/**
 * Recorded needs-you answers whose planner-inbox relay is not confirmed — the
 * delivery side of needs-you, from the same `readNeedsMasonReplyDeliveries`
 * read `phm fleet needs` reports as `replyDeliveries`, so the two surfaces
 * can never disagree. A resolved item leaves every open-item list, so a
 * failed or unrecorded append would be invisible without this source. Each
 * pending receipt lists as a warn: "not confirmed", never "undelivered", since
 * an append that succeeded but whose receipt write failed reads the same. The
 * retry act resolves the same id again — the recorded reply is reused, never
 * re-asked. A receipt that failed validation lists as unreadable with its
 * delivery state honestly unknown; there is no per-item fix, so it keeps the
 * `phm fleet needs` inspect link only. Receipts carry no timestamp, so
 * `since`/`expiresAt` stay null. Retrying is agent work; nothing here blocks
 * Mason. An unreadable store reports 'unavailable', never an empty list
 * passed off as fact.
 */
function needsYouDeliveryItems(read: NonNullable<UnifiedInboxOptions['readNeedsDeliveries']>, runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: NeedsMasonReplyDeliveryReport;
  try { result = read({ runsDir }); } catch { result = { status: 'unavailable' }; }
  if (result.status !== 'ok') return { report: { state: 'unavailable', pending: null }, items: [] };
  const items = [
    ...result.pending.map((entry): Omit<UnifiedInboxItem, 'priority'> => ({
      id: `needs-you-delivery:${entry.itemId}`,
      source: 'needs-you-delivery',
      kind: 'needs-you-delivery',
      severity: 'warn',
      blocking: false,
      title: oneLine(`Needs-you answer ${entry.itemId} not confirmed in the planner inbox`, TITLE_MAX),
      detail: oneLine(`via ${entry.source}` +
        (entry.text === null ? ' · ledger text unknown' : ` · "${oneLine(entry.text, 140)}"`), DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      act: [`phm fleet needs-resolve ${entry.itemId}`, 'phm fleet needs'],
    })),
    ...result.unsafe.map((itemId): Omit<UnifiedInboxItem, 'priority'> => ({
      id: `needs-you-delivery:${itemId}`,
      source: 'needs-you-delivery',
      kind: 'needs-you-delivery',
      severity: 'warn',
      blocking: false,
      title: oneLine(`Needs-you delivery receipt ${itemId} unreadable`, TITLE_MAX),
      detail: oneLine('receipt failed validation; delivery state unknown — inspect the needs-mason-delivery directory', DETAIL_MAX),
      since: null,
      expiresAt: null,
      act: ['phm fleet needs'],
    })),
  ];
  return { report: { state: 'healthy', pending: items.length }, items };
}

function teammateItems(read: typeof readTeammateTexts, runsDir: string | undefined, now: () => number,
  coveredResultRowids: ReadonlySet<number> = new Set()): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: ReturnType<typeof readTeammateTexts>;
  try { result = read({ runsDir, now }); } catch { result = { sourceState: 'degraded', texts: [] }; }
  // A replied teammate task's RESULT text is that task's pending item, not a
  // second one — the task source owns it until the drain settles both.
  const texts = coveredResultRowids.size === 0 ? result.texts : result.texts.filter(text => !coveredResultRowids.has(text.rowid));
  const items = texts.map((text: TeammateText): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `imessage:teammate-${text.rowid}`,
    source: 'imessage',
    kind: 'teammate-text',
    // A finding asking for a decision or an action ranks above ordinary replies.
    severity: classifyTeammateIntent(text.text) === 'leader' ? 'warn' : 'info',
    blocking: false,
    title: oneLine(text.text, TITLE_MAX),
    detail: `${text.senderId} · waiting ${text.ageMinutes}m`,
    since: text.at,
    expiresAt: null,
    act: [`phm fleet teammate-texts --answered ${text.rowid}`,
      `phm fleet bus-claim acquire --id imessage-teammate-${text.rowid} --owner <label> --lease-ms ${SUGGESTED_LEASE_MS}`],
  }));
  return { report: { state: result.sourceState, pending: items.length }, items };
}

type TeammateTaskView = ReturnType<typeof listTeammateTasks>['tasks'][number];

/** The resolved teammate-task ledger read: a unified source state plus the `phm fleet imessage-tasks list` view rows (scope, format and result text already stripped). */
export interface TeammateTaskLedgerRead {
  state: UnifiedInboxSourceState;
  tasks: readonly TeammateTaskView[];
}

/**
 * The same read `phm fleet imessage-tasks list` serves, resolved at the shared
 * runs dir. An absent ledger is 'missing' — `load()` returns a verified-empty
 * store for it, so existence is checked first; a ledger that exists but fails
 * the strict store schema or cannot be read is 'unavailable', never an empty
 * list passed off as fact.
 */
function readTeammateTaskLedger(options: { runsDir?: string } = {}): TeammateTaskLedgerRead {
  if (!existsSync(join(imessageStateDir(options.runsDir), 'teammate-tasks.json'))) return { state: 'missing', tasks: [] };
  try {
    const report = listTeammateTasks({ runsDir: options.runsDir });
    return { state: 'healthy', tasks: report.tasks };
  } catch { return { state: 'unavailable', tasks: [] }; }
}

/** Task states whose deadline is still the peer's live obligation; replied and expired rows are settle bookkeeping with no deadline of their own. */
const TEAMMATE_TASK_OPEN: ReadonlySet<string> = new Set(['queued', 'sending', 'pending']);

/**
 * Unsettled, non-cancelled Dot/Instinct teammate tasks — the same
 * `imessage.teammate-tasks.v1` ledger `phm fleet imessage-tasks list` serves.
 * A queued, sending or pending row is work in flight (reserved, send
 * ambiguous, or awaiting the peer's RESULT); a replied or expired row the
 * drain has not settled still owes metrics, the answered marker and the
 * queue finish, so its queue claim stays held — all pending, all agent work,
 * never Mason-blocking. `sending`, `replied`, `expired` and any open row past
 * its real deadline list as warn; routine in-flight rows are info. `since` is
 * the state's own real timestamp (created, attempted, result or deadline —
 * never invented); `expiresAt` is the task deadline while it is still the
 * peer's obligation, null once replied or expired. A replied task's RESULT
 * text rowid is returned in `coveredResultRowids` so the imessage source does
 * not list the same pending thing twice. Scope, format, RESULT text and the
 * correlation token never reach an item.
 */
function teammateTaskItems(read: NonNullable<UnifiedInboxOptions['readTeammateTasks']>,
  runsDir: string | undefined, now: () => number,
): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[]; coveredResultRowids: ReadonlySet<number> } {
  let result: TeammateTaskLedgerRead;
  try { result = read({ runsDir }); } catch { result = { state: 'unavailable', tasks: [] }; }
  if (result.state === 'missing' || result.state === 'unavailable') {
    return { report: { state: result.state, pending: pendingCount(result.state, 0) }, items: [], coveredResultRowids: new Set() };
  }
  const nowMs = now();
  const coveredResultRowids = new Set<number>();
  const items = result.tasks.filter(task => task.settled !== true && task.state !== 'cancelled').map((task): Omit<UnifiedInboxItem, 'priority'> => {
    const deadlineMs = Date.parse(task.deadline);
    const timed = Number.isFinite(deadlineMs);
    const open = TEAMMATE_TASK_OPEN.has(task.state);
    const overdue = open && timed && deadlineMs <= nowMs;
    if (task.result) coveredResultRowids.add(task.result.rowid);
    const phrase = task.state === 'queued' ? 'reserved, awaiting dispatch'
      : task.state === 'sending' ? 'send in flight, awaiting reconcile'
      : task.state === 'pending' ? 'awaiting peer result'
      : task.state === 'replied' ? `peer reported ${task.result?.status ?? 'a result'}, settle owed · peer-reported, unverified`
      : 'deadline elapsed, settle owed';
    const sinceMs = task.state === 'replied' ? task.result?.at
      : task.state === 'expired' ? deadlineMs
      : task.attemptedAt ?? task.createdAt;
    return {
      id: `teammate-tasks:${task.jobId}`,
      source: 'teammate-tasks',
      kind: 'teammate-task',
      severity: task.state === 'sending' || task.state === 'replied' || task.state === 'expired' || overdue ? 'warn' : 'info',
      blocking: false,
      title: oneLine(`teammate ${task.peer} ${task.kind} ${task.jobId}`, TITLE_MAX),
      detail: oneLine(`${task.repo} · ${phrase}` +
        (open && timed ? deadlineMs > nowMs ? ` · due in ${plainAge(deadlineMs - nowMs)}` : ` · overdue ${plainAge(nowMs - deadlineMs)}` : ''), DETAIL_MAX) || null,
      since: typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? iso(sinceMs) : null,
      expiresAt: open && timed ? iso(deadlineMs) : null,
      jobIds: [task.jobId],
      act: ['phm fleet imessage-tasks dispatch --apply', `phm fleet imessage-tasks list --job ${task.jobId}`],
    };
  });
  return { report: { state: result.state, pending: items.length }, items, coveredResultRowids };
}

/**
 * Live inbound owner-thread messages no recorded outbound reply cites — the
 * same awaiting-reply mark `readOwnerThread`/`readOwnerCommsStatus` report,
 * here as items. The owner is waiting on the leader, so each lists as a warn
 * with the thread read and a `send-owner --reply-to` deep link keyed by the
 * inbound's idempotency key. An unreadable thread reports 'unavailable'; it
 * never passes an empty list off as fact.
 */
function ownerThreadItems(read: NonNullable<UnifiedInboxOptions['readOwnerAwaiting']>, runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: OwnerAwaitingReplies;
  try { result = read({ runsDir: dir }); } catch { result = { status: 'unavailable' }; }
  if (result.status !== 'ok') return { report: { state: 'unavailable', pending: null }, items: [] };
  const items = result.items.map((reply): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `owner-thread:${reply.id}`,
    source: 'owner-thread',
    kind: 'owner-message',
    severity: 'warn',
    blocking: false,
    title: oneLine(reply.text, TITLE_MAX) || `owner message ${reply.id}`,
    detail: cap(`via ${reply.channel} · awaiting recorded reply`, DETAIL_MAX),
    since: reply.at,
    expiresAt: null,
    act: ['phm comms thread', `phm comms send-owner --text "<reply>" --reply-to ${reply.idempotencyKey}`],
  }));
  return { report: { state: 'healthy', pending: items.length }, items };
}

/** Same shape guard `send-owner --reply-to` applies to inbound idempotency keys before one reaches a command line. */
const OWNER_REPLY_KEY = /^[A-Za-z0-9._:-]{8,80}$/;

/**
 * Recorded owner-thread replies whose fanout is not fully delivered — the
 * delivery side of the awaiting-reply mark, which counts an inbound answered
 * once a reply is recorded even when every channel refused it. Each lists as
 * a warn with the per-destination states the receipt journal proves —
 * failed, pending or unknown, never delivered — the scrubbed failure reason
 * when one was recorded, and a `phm comms thread` / `send-owner --reply-to`
 * deep link: resending the same text under the reply's own idempotency key
 * and the answered inbound's key reproduces the reply identity in every case
 * — an explicit key or a derived `reply-<digest>` one — and retries only the
 * unconfirmed destinations. An unreadable thread reports 'unavailable'; it
 * never passes an empty list off as fact. `since` is the reply's recorded
 * time — the receipt journal keeps no attempt timestamp, so a later retry's
 * age stays unknown; `expiresAt` stays null.
 */
function ownerDeliveryItems(read: NonNullable<UnifiedInboxOptions['readOwnerUndelivered']>, runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: OwnerUndeliveredReplies;
  try { result = read({ runsDir: dir }); } catch { result = { status: 'unavailable' }; }
  if (result.status !== 'ok') return { report: { state: 'unavailable', pending: null }, items: [] };
  const items = result.items.map((reply): Omit<UnifiedInboxItem, 'priority'> => {
    const act = ['phm comms thread'];
    // The resend must reuse the recorded text, the reply's own key and the
    // answered inbound's key or the reply identity refuses or forks; keys
    // that fail the send-owner shape guard keep the inspect link rather than
    // a command that cannot run.
    if (OWNER_REPLY_KEY.test(reply.replyTo) && OWNER_REPLY_KEY.test(reply.idempotencyKey)) {
      act.push(`phm comms send-owner --reply-to ${reply.replyTo} --idempotency-key ${reply.idempotencyKey} --text "<same reply text>"`);
    }
    return {
      id: `owner-delivery:${reply.id}`,
      source: 'owner-delivery',
      kind: 'owner-reply-undelivered',
      severity: 'warn',
      // Resending is agent work; nothing here blocks Mason.
      blocking: false,
      title: oneLine(`Leader reply undelivered on ${reply.destinations.map(d => d.channel).join(', ')}`, TITLE_MAX) || `leader reply ${reply.id}`,
      detail: oneLine(
        reply.destinations.map(d => d.reason === null ? `${d.channel}: ${d.state}` : `${d.channel}: ${d.state} (${d.reason})`).join(' · ') +
        ` · "${oneLine(reply.text, 120)}"`,
        DETAIL_MAX) || null,
      since: reply.at,
      expiresAt: null,
      act,
    };
  });
  return { report: { state: 'healthy', pending: items.length }, items };
}

/** Epoch-ms → ISO only inside the range `Date` can represent; anything else
 * stays null — an unparseable store time is unknown, never a fabricated one. */
const isoMs = (ms: number): string | null =>
  Number.isFinite(ms) && Math.abs(ms) <= 8_640_000_000_000_000 ? iso(ms) : null;

/**
 * A live iMessage owner-pairing wait — the one pairing text
 * `phm owner pair imessage` or the owner-live self-tick sent to Mason's own
 * handles is still inside its YES window. Until now the wait was invisible
 * here: `phm owner pair status` and `phm fleet owner-live` were the only
 * surfaces, so a pairing Mason never answered looked like nothing pending.
 * Only Mason can finish it — the first own handle answering YES binds and
 * anything else binds nothing — so it lists as a warn `owner-pair-waiting`
 * item carrying the sent-handle count (never the handles), `since` the send
 * time and `expiresAt` the real YES-window deadline the record keeps. An
 * expired window is a closed wait, not pending work; a bound owner makes any
 * leftover record inert residue the next pair check clears; a verified-
 * absent state file is 'missing' and a file that cannot be read or parsed
 * 'unavailable' — a pending YES wait it may hide stays unknown, never an
 * empty wait passed off as fact.
 */
function ownerPairItems(read: NonNullable<UnifiedInboxOptions['readOwnerPair']>, configDir: string,
  now: () => number): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: OwnerPairPendingRead;
  try { result = read({ configDir }); } catch { result = { status: 'unavailable' }; }
  if (result.status !== 'ok') {
    return { report: { state: result.status, pending: result.status === 'missing' ? 0 : null }, items: [] };
  }
  const pending = result.pending;
  const live = pending !== null && pending.expiresAt > now();
  if (pending === null || result.paired || !live) {
    return { report: { state: 'healthy', pending: 0 }, items: [] };
  }
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [{
    id: 'owner-pair:pending',
    source: 'owner-pair',
    kind: 'owner-pair-waiting',
    severity: 'warn',
    // Answering YES is Mason's own step; nothing here blocks other work.
    blocking: false,
    title: 'iMessage owner pairing waiting for YES',
    detail: oneLine(`the pairing text went to ${pending.sent} own handle(s) — the first handle that answers YES binds; anything else binds nothing`, DETAIL_MAX) || null,
    since: isoMs(pending.startedAt),
    expiresAt: isoMs(pending.expiresAt),
    act: ['phm owner pair status --json', 'phm owner pair imessage'],
  }];
  return { report: { state: 'healthy', pending: items.length }, items };
}

async function draftItems(
  list: typeof listDrafts,
  listComms: (runsDir: string) => Promise<CommsDraft[]>,
  runsDir: string | undefined,
): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  // An absent store reads as an empty list; only a read failure is 'unavailable'.
  // The cos read keeps every status: an approved or rejected copy of a
  // comms-agent email draft still means the owner decided it, so it must
  // suppress the comms-agent record below.
  let drafts: Draft[] = [];
  let state: UnifiedInboxSourceState = 'healthy';
  try { drafts = await list({ runsDir }); } catch { state = 'unavailable'; }
  const pendingCos = drafts.filter(draft => draft.status === 'pending');
  const mirrored = new Set(
    drafts.map(draft => draft.source)
      .filter(source => source.startsWith('comms-agent:'))
      .map(source => source.slice('comms-agent:'.length)),
  );
  const commsDir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let commsDrafts: CommsDraft[] = [];
  let commsFailed = false;
  try { commsDrafts = await listComms(commsDir); } catch { commsFailed = true; }
  const items = [
    ...pendingCos.map((draft): Omit<UnifiedInboxItem, 'priority'> => ({
      id: `drafts:${draft.id}`,
      source: 'drafts',
      kind: 'draft-approval',
      severity: 'info',
      // The outbound send is held until the owner decides.
      blocking: true,
      title: oneLine(`Approve outbound email to ${draft.to}`, TITLE_MAX),
      detail: cap(`${draft.subject || '(no subject)'} · digest ${draft.digest.slice(0, 12)}`, DETAIL_MAX),
      since: draft.createdAt,
      expiresAt: null,
      act: [`phm drafts show ${draft.id}`, `phm drafts approve ${draft.id}`, `phm drafts reject ${draft.id}`],
    })),
    // Comms-agent reply drafts that never reached the cos store (every
    // non-email transport, or an email mirror that failed to write) still
    // wait on the owner, so they list here too — one pending reply, one item.
    // The recipient stays out of the item: it can be a handle.
    ...commsDrafts
      .filter(draft => draft.status === 'pending' && !mirrored.has(draft.id))
      .map((draft): Omit<UnifiedInboxItem, 'priority'> => ({
        id: `drafts:${draft.id}`,
        source: 'drafts',
        kind: 'draft-approval',
        severity: 'info',
        blocking: true,
        title: oneLine(`Comms reply draft via ${draft.transport}`, TITLE_MAX),
        detail: oneLine(draft.subject || '(no subject)', DETAIL_MAX),
        since: Number.isNaN(Date.parse(draft.createdAt)) ? null : draft.createdAt,
        expiresAt: null,
        act: ['phm comms-agent drafts'],
      })),
  ];
  const merged: UnifiedInboxSourceState = state === 'unavailable' ? 'unavailable' : commsFailed ? 'degraded' : 'healthy';
  return { report: { state: merged, pending: pendingCount(merged, items.length) }, items };
}

/**
 * Comms-agent inbound mail no reply-draft record covers — the kept half of
 * `<runsDir>/comms-agent/inbox.json` (`phm comms-agent run`'s triage input)
 * still awaiting a pass. Mail whose Comms draft exists — pending, already
 * listed under `drafts`, or sent, already answered — suppresses its row so
 * one pending reply stays one item; a refused send leaves no draft, so that
 * mail lists here — the pending work `phm comms-agent status` counts as
 * `inbox` depth but no item-level surface ever showed. The schema keeps no
 * timestamp and `from` is a handle, so `since`/`expiresAt` stay null and
 * items carry the transport plus the scrubbed subject only. An unreadable
 * or malformed inbox is 'unavailable' — the pending set is unknown, never
 * an empty inbox; an unreadable drafts store degrades the read, coverage
 * then unproven so every message lists rather than suppressing on a guess.
 */
async function commsMailItems(
  readInboxFn: (runsDir: string) => Promise<InboxRead>,
  listComms: (runsDir: string) => Promise<CommsDraft[]>,
  runsDir: string | undefined,
): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const runs = commsRunsRoot(runsDir);
  let inbox: InboxRead;
  try { inbox = await readInboxFn(runs); } catch {
    return { report: { state: 'unavailable', pending: null }, items: [] };
  }
  let drafts: CommsDraft[] = [];
  let draftsFailed = false;
  try { drafts = await listComms(runs); } catch { draftsFailed = true; }
  const covered = new Set(drafts.map(draft => draft.messageId));
  const items = inbox.messages
    .filter(message => !covered.has(message.id))
    .map((message): Omit<UnifiedInboxItem, 'priority'> => ({
      id: `comms-mail:${message.id}`,
      source: 'comms-mail',
      kind: 'comms-mail',
      severity: 'info',
      blocking: false,
      title: oneLine(`Comms mail via ${message.transport}`, TITLE_MAX),
      detail: oneLine(message.subject || '(no subject)', DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      act: ['phm comms-agent run', 'phm comms-agent drafts'],
    }));
  const state: UnifiedInboxSourceState = draftsFailed ? 'degraded' : 'healthy';
  return { report: { state, pending: pendingCount(state, items.length) }, items };
}

/**
 * Live envelopes whose body the bus-next claim contract accepts — the work
 * loop's contract (`isClaimableWork`): a `kind:'work'` body, or a protocol-v1
 * transport `task` body. A `kind:'work'` body carrying a non-task `protocol`
 * is not claimable (the protocol branch decides), so it stays off the list.
 */
function isWorkReceipt(receipt: BusInboxReceipt): boolean {
  return isClaimableWork(receipt.envelope.body);
}

/**
 * One-line title for a bare protocol-v1 transport body — the claimable shape
 * that carries no `kind:'work'` and no `text`: `protocol <kind> <topic>:
 * <payload_ref>`, the same read the bus inbox frames compose. Typed bodies
 * (a `kind` string is present) return null so the caller keeps its
 * `work <from> → <to>` fallback; fields are read defensively because stored
 * envelopes are untrusted data.
 */
function protocolBodyTitle(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind === 'string' && kind.trim() !== '') return null;
  const proto = record[BUS_PROTOCOL_KEY];
  if (proto === null || typeof proto !== 'object' || Array.isArray(proto)) return null;
  const p = proto as Record<string, unknown>;
  const pk = p['kind'];
  if (typeof pk !== 'string' || pk.trim() === '') return null;
  const field = (key: string): string | null => {
    const value = p[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  const head = ['protocol', pk.trim(), field('topic')].filter((part): part is string => part !== null).join(' ');
  const ref = field('payload_ref');
  return ref === null ? head : `${head}: ${ref}`;
}

/** Announcement metadata for a v2 work job, read off its live `work.post` receipt. */
interface BusFeedPost {
  priority: BusPriority;
  receivedAt: number;
  expiresAt: number;
}

/** The newest `work.status` envelope the scan saw for a job: its wire id (the `agents bus show` handle) and its scrubbed reason. */
interface BusFeedStatus {
  id: string;
  detail: string | null;
}

/** Feed statuses that need a decision rather than a worker: blocked waits on something, failed broke. */
const BUS_FEED_STUCK_STATUSES: ReadonlySet<string> = new Set(['blocked', 'failed']);
/** Display clip for a status report's own detail inside an item detail line. */
const STATUS_DETAIL_MAX = 160;

/**
 * Open and stuck v2 work-feed jobs, from the same read-only projection
 * `phm agents bus work feed` serves. A job counts as pending while it is
 * queued or rescheduled, declares at least one claim key, and — when the
 * coordination table is readable — at least one of those keys has no live hold.
 * A job the feed shows `blocked` or `failed` counts as pending too: it cannot
 * be claimed, it needs a decision, so it lists with the newest status report's
 * own detail and a `bus show` deep link instead of a claim act. An open job
 * that declares no claim keys at all counts the same way — `work claim`
 * refuses it `no-claim-keys`, so it is unclaimable work needing a re-announce
 * or a terminal status, not a worker; it lists with the announcement's own
 * `bus show` handle and no claim act. A `running`/`idle` job that declares
 * claim keys counts as pending only under complete hold coverage with no
 * shown live hold on any of them — the status says progress while
 * coordination proves nobody holds the scope, so the announcement is stalled
 * and only its announcer can move it; truncated, unavailable or absent hold
 * coverage can never prove that, so unproven stalls stay hidden. Unknown
 * holds list open candidates under 'degraded' rather than hiding them. A refused feed
 * lists one high item naming the retained receipt the projection blamed —
 * every announced job is hidden and every work verb refuses until that
 * receipt's TTL ends, so the refusal itself is pending work; `expiresAt` is
 * the blamed receipt's own deadline. A retryable or unreadable feed degrades
 * the section; it never invents jobs.
 */
function busFeedJobItems(options: UnifiedInboxOptions, now: number,
  posts: ReadonlyMap<string, BusFeedPost>,
  statuses: ReadonlyMap<string, BusFeedStatus>): { state: 'ok' | 'degraded' | 'unavailable'; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let feed: BusWorkFeedReadResult;
  try { feed = (options.readFeed ?? readBusWorkFeed)({ root: options.busRoot, claims: true, now: () => now }); }
  catch { return { state: 'unavailable', items: [] }; }
  if (feed.status === 'unavailable') return { state: 'unavailable', items: [] };
  if (feed.status === 'refused') {
    const receipt = feed.receipt;
    const expiry = receipt === undefined ? NaN : receipt.receivedAt + receipt.ttl;
    // ECMAScript's Date range ends at ±8.64e15 ms; an out-of-range expiry
    // stays null — unknown, never an invalid timestamp.
    const expiresAt = Number.isSafeInteger(expiry) && expiry <= 8_640_000_000_000_000 ? iso(expiry) : null;
    return { state: 'degraded', items: [{
      id: 'bus-feed-refused',
      source: 'bus',
      kind: 'bus-work',
      severity: 'high',
      blocking: false,
      title: `work feed refused: ${feed.reason}`,
      detail: cap('every announced job is hidden and work verbs refuse until the receipt expires' +
        (receipt === undefined ? '' : ` · receipt ${receipt.id}`), DETAIL_MAX),
      since: receipt === undefined ? null : iso(receipt.receivedAt),
      expiresAt,
      act: [
        ...(receipt === undefined ? [] : [`phm agents bus show ${receipt.id}`]),
        'phm agents bus work feed',
      ],
    }] };
  }
  if (feed.status !== 'ok') return { state: 'degraded', items: [] };

  const { coverage, heldByJob: heldKeys } = busWorkFeedHoldIndex(feed.claims);
  const holdsKnown = coverage === 'complete';

  // ` · result <outcome>[ (reason)] reported by <from>` — the newest
  // work.result evidence a feed job carries in inbox detail; '' when none
  // is retained. Evidence only: it never moved the job's status.
  const resultNote = (job: BusWorkFeedJob): string => {
    const result = job.result;
    if (result === undefined) return '';
    return ` · result ${result.outcome}` +
      (result.reason === undefined ? '' : ` (${oneLine(result.reason, 64)})`) +
      ` reported by ${oneLine(result.from, 96)}`;
  };

  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  for (const job of feed.jobs) {
    const post = posts.get(job.id);
    // A stuck job cannot be claimed — it needs a decision — so it lists with
    // the status report that moved it here instead of a claim act. Claim keys
    // are irrelevant to that read, so empty ones still surface.
    if (BUS_FEED_STUCK_STATUSES.has(job.status)) {
      const report = statuses.get(job.id);
      items.push({
        id: `bus-feed:${job.id}`,
        source: 'bus',
        kind: 'bus-work',
        severity: job.status === 'failed' || post?.priority === 'P0' ? 'high' : 'warn',
        blocking: false,
        title: oneLine(job.title, TITLE_MAX) || `bus work ${job.id}`,
        detail: cap(`owner ${job.owner} · ${job.provider} · ${job.repo} · ${job.status}` +
          (report?.detail ? ` — ${report.detail}` : '') + resultNote(job), DETAIL_MAX),
        since: iso(job.updatedAt),
        expiresAt: post ? iso(post.expiresAt) : null,
        jobIds: [job.id],
        act: [
          ...(report === undefined ? [] : [`phm agents bus show ${report.id}`]),
          `phm agents bus work feed --job ${job.id} --claims`,
        ],
      });
      continue;
    }
    // A running/idle announcement whose declared keys all lost their live
    // holds is stalled work: the status reports progress but complete hold
    // coverage proves nobody holds the job's scope, and only the announcer
    // can move it — a worker cannot claim a non-open status. A live dispatch
    // report is work coverage too: 'reserved'/'admitted' mean the peer
    // pipeline still owns the job's outcome, so the job hides like a held
    // one would. A terminal report ('complete'/'failed') is different — the
    // worker answered and only the announcer can move the status, so the
    // item cites the result receipt instead of reading as abandoned. Jobs
    // with no declared keys have no claim scope to prove unheld, and
    // incomplete coverage can never prove "no hold", so both stay hidden
    // rather than listed as fact.
    if ((job.status === 'running' || job.status === 'idle') && job.claimKeys.length > 0 && holdsKnown) {
      const held = heldKeys.get(job.id);
      if (held === undefined || held.size === 0) {
        const jobResult = job.result;
        if (jobResult !== undefined && (jobResult.outcome === 'reserved' || jobResult.outcome === 'admitted')) continue;
        const report = statuses.get(job.id);
        const terminalResult = jobResult !== undefined && (jobResult.outcome === 'complete' || jobResult.outcome === 'failed')
          ? jobResult : undefined;
        items.push({
          id: `bus-feed:${job.id}`,
          source: 'bus',
          kind: 'bus-work',
          severity: post?.priority === 'P0' ? 'high' : 'warn',
          blocking: false,
          title: oneLine(job.title, TITLE_MAX) || `bus work ${job.id}`,
          detail: cap(`owner ${job.owner} · ${job.provider} · ${job.repo} · ${job.status}` +
            (report?.detail ? ` — ${report.detail}` : (job.detail === undefined ? '' : ` — ${oneLine(job.detail, 140)}`)) +
            ' · no live claim on its declared keys; ' +
            (terminalResult === undefined
              ? 'only the announcer can move it'
              : `work.result ${terminalResult.outcome} reported by ${oneLine(terminalResult.from, 96)}` +
                (terminalResult.reason === undefined ? '' : ` (${oneLine(terminalResult.reason, 64)})`) +
                ' — only the announcer can move it'), DETAIL_MAX),
          since: iso(job.updatedAt),
          expiresAt: post ? iso(post.expiresAt) : null,
          jobIds: [job.id],
          act: [
            ...(jobResult === undefined ? [] : [`phm agents bus show ${jobResult.id}`]),
            ...(report === undefined ? [] : [`phm agents bus show ${report.id}`]),
            `phm agents bus work feed --job ${job.id} --claims`,
          ],
        });
      }
      continue;
    }
    // An open job that declares no claim keys can never be claimed —
    // `work claim` refuses it `no-claim-keys` — so like a stuck job it needs
    // a decision (re-announce with keys or move it terminal), not a worker.
    // It lists with the announcement's own post handle and no claim act.
    if (BUS_FEED_OPEN_STATUSES.has(job.status) && job.claimKeys.length === 0) {
      items.push({
        id: `bus-feed:${job.id}`,
        source: 'bus',
        kind: 'bus-work',
        severity: post?.priority === 'P0' ? 'high' : 'warn',
        blocking: false,
        title: oneLine(job.title, TITLE_MAX) || `bus work ${job.id}`,
        detail: cap(`owner ${job.owner} · ${job.provider} · ${job.repo} · ${job.status}` +
          (job.detail === undefined ? '' : ` — ${oneLine(job.detail, 140)}`) +
          resultNote(job) +
          ' · declares no claim keys; nothing can claim it', DETAIL_MAX),
        since: iso(post?.receivedAt ?? job.updatedAt),
        expiresAt: post ? iso(post.expiresAt) : null,
        jobIds: [job.id],
        act: [`phm agents bus show ${job.postId}`, `phm agents bus work feed --job ${job.id} --claims`],
      });
      continue;
    }
    if (!BUS_FEED_OPEN_STATUSES.has(job.status) || job.claimKeys.length === 0) continue;
    const held = heldKeys.get(job.id);
    const freeKeys = holdsKnown ? job.claimKeys.filter(key => !held?.has(key)) : job.claimKeys;
    if (freeKeys.length === 0) continue;
    const claimKey = freeKeys.find(key => key.startsWith('queue:')) ?? freeKeys[0]!;
    // The feed job carries the announcement's own title; the receipt scan only
    // adds priority and expiry the projection does not keep.
    const title = oneLine(job.title, TITLE_MAX);
    const heldCount = held?.size ?? 0;
    items.push({
      id: `bus-feed:${job.id}`,
      source: 'bus',
      kind: 'bus-work',
      severity: post?.priority === 'P0' ? 'high' : post?.priority === 'P1' ? 'warn' : 'info',
      blocking: false,
      title: title || `bus work ${job.id}`,
      detail: cap(`owner ${job.owner} · ${job.provider} · ${job.repo} · ${job.status}` +
        (job.detail === undefined ? '' : ` — ${oneLine(job.detail, 140)}`) +
        (holdsKnown ? ` · ${heldCount}/${job.claimKeys.length} claim keys held` : ' · claim holds unknown') +
        resultNote(job), DETAIL_MAX),
      since: iso(post?.receivedAt ?? job.updatedAt),
      expiresAt: post ? iso(post.expiresAt) : null,
      jobIds: [job.id],
      act: [
        `phm agents bus claim acquire --key ${claimKey} --owner <label> --lease-ms ${SUGGESTED_LEASE_MS}`,
        'phm agents bus work feed --claims',
      ],
    });
  }
  return { state: holdsKnown ? 'ok' : 'degraded', items };
}

/** Pending bus items a waiting conversation thread must not repeat: the envelope ids behind `bus:`/`bus-handoff:` items and the job ids behind `bus-feed:` items. */
interface BusItemCoverage {
  readonly envelopes: ReadonlySet<string>;
  readonly feedJobs: ReadonlySet<string>;
  /** Envelope ids of live `work.post` announcements — feed traffic the bus
   * source represents as jobs, so a coordination board reading the same
   * envelope does not list it a second time. */
  readonly posts: ReadonlySet<string>;
}

/** The transport dead-letter sink (docs/AGENT-BUS.md "Dead letters"): the
 * router files delivery-failure reports under this address. Kept a literal —
 * the shared constant lives in bus-transport-file, whose import would pull
 * the transport router into this read projection's closure (the same call
 * fleet-edges makes). */
const BUS_DEAD_LETTER_ADDRESS = 'bus.dead-letter';

/** The delivery-failure summary a dead-letter letter carries under
 * `body.payload.deadLetter` (the sink's wire shape in bus-transport-file),
 * read defensively: stored envelopes are untrusted data, so every field is
 * optional and a missing one stays absent rather than guessed. */
interface DeadLetterFacts {
  readonly id: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly kind: string | null;
  readonly reason: string | null;
  readonly attempts: number | null;
  readonly correlationId: string | null;
  readonly payloadDropped: boolean;
}

function deadLetterFacts(body: unknown): DeadLetterFacts | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const outer = body as Record<string, unknown>;
  const payload = outer.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const letter = (payload as Record<string, unknown>).deadLetter;
  if (letter === null || typeof letter !== 'object' || Array.isArray(letter)) return null;
  const record = letter as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  const correlation = outer.correlation_id;
  const attempts = record.attempts;
  return {
    id: text('id'), from: text('from'), to: text('to'), kind: text('kind'), reason: text('reason'),
    attempts: Array.isArray(attempts) ? attempts.length : null,
    correlationId: typeof correlation === 'string' && correlation.trim() !== '' ? correlation.trim() : null,
    payloadDropped: (payload as Record<string, unknown>).payloadDropped === true,
  };
}

function busItems(options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[]; covered: BusItemCoverage } {
  const covered: { envelopes: Set<string>; feedJobs: Set<string>; posts: Set<string> } = { envelopes: new Set(), feedJobs: new Set(), posts: new Set() };
  const bus: BusInboxOptions = { root: options.busRoot, now: options.now };
  let inspection: BusInboxInspection;
  try { inspection = (options.inspectBus ?? inspectBusInbox)(bus); }
  catch { inspection = { source: 'unavailable', retainedCount: null, retainedBytes: null, maxMessages: BUS_INBOX_MAX_MESSAGES, maxBytes: BUS_INBOX_MAX_BYTES, liveCount: null, expiredCount: null }; }
  if (inspection.source !== 'available') return { report: { state: inspection.source === 'missing' ? 'missing' : 'unavailable', pending: inspection.source === 'missing' ? 0 : null }, items: [], covered };

  const now = (options.now ?? Date.now)();
  const claims = (options.readClaims ?? inspectBusWorkClaims)(options.busRoot);
  const coordination = (options.readCoordination ?? listCoordination)(options.busRoot, now);
  // A message-id claim lands in the same coordination table under
  // `queue:<envelope id>`, so a live row there — resource, lane or board —
  // means the canonical acquire would conflict: the work is held, not free.
  const coordinationHolds = coordination.source === 'available'
    ? coordination.claims.filter(row => row.live) : [];
  const taken = (receipt: BusInboxReceipt): boolean =>
    claims.claims.some(row =>
      row.id === receipt.envelope.id && row.cursor === receipt.cursor && row.receivedAt === receipt.receivedAt &&
      (row.completedAt !== null || row.leaseUntil > now)) ||
    coordinationHolds.some(row => coordinationRowBlocks(row, `queue:${receipt.envelope.id}`));

  const list = options.listBus ?? listBusInboxAfter;
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  const feedPosts = new Map<string, BusFeedPost>();
  const feedStatuses = new Map<string, BusFeedStatus>();
  // Live reply citations collected across the same scan, and the handoff items
  // deferred until the walk ends so an answered assignment never lists.
  const replyCites: BusReplyCitation[] = [];
  const pendingHandoffs: { id: string; from: string; to: string; item: Omit<UnifiedInboxItem, 'priority'> }[] = [];
  let state: UnifiedInboxSourceState = claims.source === 'unavailable' || coordination.source === 'unavailable' ? 'degraded' : 'healthy';
  let after = 0;
  // Same paging bound the work loop accepts: the store retains at most
  // BUS_INBOX_MAX_MESSAGES records over BUS_INBOX_MAX_READ-sized pages.
  for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
    let result: ReturnType<typeof listBusInboxAfter>;
    try { result = list(after, BUS_INBOX_MAX_READ, bus); } catch { result = { status: 'unavailable' }; }
    if (result.status !== 'ok') { state = result.status === 'retryable' ? 'degraded' : 'unavailable'; break; }
    for (const receipt of result.messages) {
      const { envelope } = receipt;
      const body = envelope.body;
      // Every live envelope's reply citations feed the answered-handoff check
      // below — a handoff's answer is routed back to its assigner, so it is
      // collected here regardless of the item's own kind.
      replyCites.push(...busReplyCitations(envelope));
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        if (record.kind === 'work.post' && typeof record.jobId === 'string' && !feedPosts.has(record.jobId)) {
          feedPosts.set(record.jobId, {
            priority: envelope.priority,
            receivedAt: receipt.receivedAt,
            // The reader decrements ttl to what remains; expiry is a real deadline.
            expiresAt: now + envelope.ttl,
          });
          // The feed represents this announcement as a job item, so the
          // coordination board must not list the same envelope again.
          covered.posts.add(envelope.id);
        }
        // Cursor order is append order, so the last status seen per job is the
        // one the feed projection credits — the same rule it applies. The
        // detail is untrusted body text: scrubbed and clipped here, never raw.
        if (record.kind === 'work.status' && typeof record.jobId === 'string') {
          const detail = record.detail;
          feedStatuses.set(record.jobId, {
            id: envelope.id,
            detail: typeof detail === 'string' && detail.trim() !== '' ? oneLine(detail, STATUS_DETAIL_MAX) : null,
          });
        }
      }
      // A dead letter is the router's delivery-failure report, not claimable
      // work, a handoff or feed traffic: the original envelope exhausted every
      // live transport (or had no route, or its TTL lapsed) and the sink
      // recorded it under the reserved address. The mail provably never
      // arrived, so it is pending attention here even though the
      // conversations/messages/edges projections exclude it as "not agent
      // mail". A failed delivery always wants a look, so the severity floor
      // is warn; an original P0 stays high like every other bus item.
      if (envelope.to === BUS_DEAD_LETTER_ADDRESS) {
        const facts = deadLetterFacts(body);
        const parties = facts !== null && (facts.from !== null || facts.to !== null)
          ? `${facts.from ?? 'unknown'} → ${facts.to ?? 'unknown'}` : 'delivery failure';
        const detailParts = [
          facts?.reason != null ? `reason ${facts.reason}` : null,
          facts?.attempts != null ? `${facts.attempts} attempt${facts.attempts === 1 ? '' : 's'}` : null,
          facts?.kind != null ? `kind ${facts.kind}` : null,
          facts?.id != null ? `original ${facts.id}` : null,
          facts?.correlationId != null ? `correlation ${facts.correlationId}` : null,
          facts?.payloadDropped ? 'original payload dropped' : null,
          `cursor ${receipt.cursor}`,
        ].filter((part): part is string => part !== null);
        items.push({
          id: `bus-dead-letter:${envelope.id}`,
          source: 'bus',
          kind: 'bus-dead-letter',
          severity: envelope.priority === 'P0' ? 'high' : 'warn',
          blocking: false,
          title: oneLine(`dead letter${facts?.reason != null ? ` ${facts.reason}` : ''}: ${parties}`, TITLE_MAX),
          // oneLine, not cap: the facts are untrusted body text — scrubbed
          // like every other stored-body string this view shows.
          detail: oneLine(detailParts.join(' · '), DETAIL_MAX) || null,
          since: iso(receipt.receivedAt),
          expiresAt: iso(now + envelope.ttl),
          act: [
            `phm agents bus show ${envelope.id}`,
            `phm comms bus read --to ${BUS_DEAD_LETTER_ADDRESS}`,
          ],
        });
        continue;
      }
      // A live worker-handoff is a pending assignment, not claimable work:
      // receiving it runs `fleet handoff-receive`/`handoff-reply`, which check
      // no claims. It is deferred until the walk ends so an assignment the
      // addressee already answered drops out rather than listing as pending.
      // The title matches the shared bus composer (`handoff task <id>: <prompt>`).
      if (isWorkerHandoffBody(envelope.body)) {
        pendingHandoffs.push({
          id: envelope.id, from: envelope.from, to: envelope.to,
          item: {
            id: `bus-handoff:${envelope.id}`,
            source: 'bus',
            kind: 'bus-handoff',
            severity: envelope.priority === 'P0' ? 'high' : envelope.priority === 'P1' ? 'warn' : 'info',
            blocking: false,
            title: oneLine(`handoff task ${envelope.body.taskId}: ${envelope.body.prompt}`, TITLE_MAX),
            detail: cap(`from ${envelope.from} to ${envelope.to} · ${envelope.priority} · cursor ${receipt.cursor}`, DETAIL_MAX),
            since: iso(receipt.receivedAt),
            expiresAt: iso(now + envelope.ttl),
            ...jobIdsField(busBodyJobIds(envelope.body)),
            act: [
              `phm fleet handoff-receive --id ${envelope.id} --to ${envelope.to} --snapshot <abs-json> -- <program> [args...]`,
              `phm agents bus show ${envelope.id}`,
            ],
          },
        });
        continue;
      }
      if (!isWorkReceipt(receipt) || taken(receipt)) continue;
      const text = body !== null && typeof body === 'object' && !Array.isArray(body) && typeof body.text === 'string'
        ? body.text : '';
      items.push({
        id: `bus:${envelope.id}`,
        source: 'bus',
        kind: 'bus-work',
        severity: envelope.priority === 'P0' ? 'high' : envelope.priority === 'P1' ? 'warn' : 'info',
        blocking: false,
        // `kind:'work'` bodies title from their text; bare protocol `task`
        // bodies have no text, so their kind/topic/ref names the item.
        title: oneLine(text || protocolBodyTitle(body) || `work ${envelope.from} → ${envelope.to}`, TITLE_MAX),
        detail: cap(`from ${envelope.from} to ${envelope.to} · ${envelope.priority} · cursor ${receipt.cursor}`, DETAIL_MAX),
        since: iso(receipt.receivedAt),
        // The reader decrements ttl to what remains; expiry is a real deadline.
        expiresAt: iso(now + envelope.ttl),
        ...jobIdsField(busBodyJobIds(body)),
        act: [`phm fleet bus-claim acquire --id ${envelope.id} --owner <label> --lease-ms ${SUGGESTED_LEASE_MS}`],
      });
    }
    if (result.messages.length < BUS_INBOX_MAX_READ) break;
    if (result.nextCursor <= after) { state = 'degraded'; break; }
    after = result.nextCursor;
  }
  // A handoff the addressee already answered is not pending work: a live reply
  // routed recipient -> sender and citing the handoff id is the same durable
  // evidence the conversation projection credits when it marks the thread
  // answered, so this view and `agents conversations` agree — under any label
  // of either identity, or from a member of the addressed channel. Only live
  // envelopes were scanned, matching that projection's own window. The
  // identity registry binds the label resolution only when a handoff could
  // drop; an unreadable registry keeps literal-label matching.
  let answerScope: HandoffAnswerScope | undefined;
  if (pendingHandoffs.length > 0) {
    const registryRead = readAgentRegistry({ root: options.busRoot });
    answerScope = registryRead.status === 'ok' ? handoffAnswerScope(registryRead.registry) : undefined;
  }
  for (const pending of pendingHandoffs) {
    if (!workerHandoffAnswered(pending, replyCites, answerScope)) items.push(pending.item);
  }
  const feed = busFeedJobItems(options, now, feedPosts, feedStatuses);
  items.push(...feed.items);
  if (feed.state === 'unavailable') state = 'unavailable';
  else if (feed.state === 'degraded' && state === 'healthy') state = 'degraded';
  for (const item of items) {
    if (item.id.startsWith('bus-feed:')) covered.feedJobs.add(item.id.slice('bus-feed:'.length));
    else if (item.id.startsWith('bus-handoff:')) covered.envelopes.add(item.id.slice('bus-handoff:'.length));
    else if (item.id.startsWith('bus:')) covered.envelopes.add(item.id.slice('bus:'.length));
  }
  return { report: { state, pending: pendingCount(state, items.length) }, items, covered };
}

/** Pending mail rows one mailbox read returns — the store's own message ceiling, so every pending row lists. */
const MAILBOX_INBOX_MAX = 5000;
/** ECMAScript's Date range ends at ±8.64e15 ms; an out-of-range store timestamp stays null — unknown, never an invalid date. */
const MAX_DATE_MS = 8_640_000_000_000_000;
const isoOrNull = (ms: number): string | null =>
  Number.isSafeInteger(ms) && Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString() : null;

/**
 * The default mailbox read: `BusMailbox.pendingAll` under the fleet root's
 * parent — the same home derivation `agents bus status` and `work mine`'s
 * mailbox section apply, so a custom `busRoot` probes the matching scratch
 * store and an unset one falls back to `ashlrHome()`.
 */
function readMailboxPending(options: { busRoot?: string; now?: () => number }): MailboxPendingRead {
  const home = options.busRoot === undefined ? undefined : dirname(options.busRoot);
  return createBusMailbox(home, options.now ?? Date.now).pendingAll(MAILBOX_INBOX_MAX);
}

/**
 * Pending (unacked, unexpired) mail in the legacy `phm bus` mailbox store
 * across EVERY recipient label — the fleet-wide read `pendingAll` serves,
 * where `work mine`'s mailbox section still needs the agent's labels ahead
 * of time. The unified bus store never carried these records, so without
 * this source leftover mail is invisible to the one pending view. Each item
 * keeps its own `to` label — the `--to` `phm bus inbox`/`ack` take — in the
 * mailbox's own priority/acceptance/id drain order, with `since` the store
 * acceptance time and `expiresAt` acceptance plus TTL, the same stamps
 * `work mine` reports. Titles reuse the shared bus body composer (known
 * kinds summarize, unknown bodies render as clipped scrubbed JSON), so a
 * secret-shaped body never reaches the item raw. An absent store is
 * 'missing' (verified empty); an unreadable one or a throwing read is
 * 'unavailable', never an empty list passed off as fact; `matched` beyond
 * the shown rows degrades the source rather than under-counting `pending`.
 * Mail awaiting an ack is coordination backlog, never Mason-blocking.
 */
function mailboxItems(read: NonNullable<UnifiedInboxOptions['readMailbox']>, options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: MailboxPendingRead;
  try { result = read({ busRoot: options.busRoot, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.source === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  if (result.source === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  const items = result.messages.map((message): Omit<UnifiedInboxItem, 'priority'> => {
    const { envelope } = message;
    const summary = oneLine(busBodySummary(envelope.body) ?? busBodyFallbackSummary(envelope.body), TITLE_MAX);
    return {
      id: `mailbox:${envelope.id}`,
      source: 'mailbox',
      kind: 'mailbox-message',
      severity: envelope.priority === 'P0' ? 'high' : envelope.priority === 'P1' ? 'warn' : 'info',
      blocking: false,
      title: summary === '' ? `mail from ${envelope.from} to ${envelope.to}` : summary,
      detail: oneLine(`from ${envelope.from} to ${envelope.to} · ${envelope.priority}`, DETAIL_MAX) || null,
      since: isoOrNull(message.acceptedAt),
      expiresAt: isoOrNull(message.acceptedAt + envelope.ttl),
      ...jobIdsField(busBodyJobIds(envelope.body)),
      act: [`phm bus inbox --to ${envelope.to}`, `phm bus ack ${envelope.id} --to ${envelope.to}`],
    };
  });
  const truncated = result.matched !== null && result.matched > result.messages.length;
  return { report: { state: truncated ? 'degraded' : 'healthy', pending: items.length }, items };
}

/** Same identifier grammar `BusBoard` validates every stored peer, thread, task, delivery and fleet-item id against; re-checked before one reaches a command line. */
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/**
 * Pending work on the shared task board (`phm bus thread`/`task`/`board`,
 * docs/BUS-THREADS.md) across EVERY peer — the fleet-wide read
 * `BusBoard.pendingAll` serves, where `work mine`'s board section still
 * needs the agent's labels ahead of time and `phm bus board pending` one
 * `--peer` at a time. Two pending classes list: every unacknowledged
 * delivery (board mail awaiting `thread ack` — the wire TTL bounds live
 * observers only, so `expiresAt` stays null and `since` is the delivery's
 * recorded `createdAt`) and every task whose observed hold is not `held` —
 * `open` is claimable work, `ambiguous` an expired claim record the claim
 * path never auto-reclaims, `unknown` a hold the unreadable queue could not
 * prove; `held` is in-flight work, not pending. Tasks carry no timestamp,
 * so `since`/`expiresAt` stay null — unknown, never invented. An absent
 * board is 'missing' (verified empty); an unreadable one 'unavailable'; an
 * unreadable claim index or a truncated item list degrades the source
 * rather than under-counting `pending`. Every item is agent work — claiming
 * coordinates, never grants authority — so none blocks Mason.
 */
function boardItems(read: NonNullable<UnifiedInboxOptions['readBoard']>, options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: BoardPendingRead;
  try { result = read({ busRoot: options.busRoot, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.source === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  if (result.source === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  const { pending } = result;
  // The board's own `--job` citation: a thread stays in scope when it carries
  // a task whose `itemId` equals the job — the fleet item and bus job share
  // the id namespace — and that thread's deliveries ride along. The map keys
  // on `pending.tasks.items`, the same capped set the task items come from
  // (held tasks included, so thread membership never depends on hold state);
  // a truncated list already degrades the source, and a delivery whose
  // citing task fell beyond the cap keeps no `jobIds` — unproven, never
  // guessed.
  const threadJobs = new Map<string, Set<string>>();
  for (const task of pending.tasks.items) {
    const set = threadJobs.get(task.threadId) ?? new Set<string>();
    set.add(task.itemId);
    threadJobs.set(task.threadId, set);
  }
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  for (const delivery of pending.deliveries.items) {
    const text = oneLine(busBoardDeliveryText(delivery), TITLE_MAX);
    const act = BOARD_ID.test(delivery.threadId) && BOARD_ID.test(delivery.id) && BOARD_ID.test(delivery.recipient)
      ? [`phm bus thread pending ${delivery.threadId} --peer ${delivery.recipient}`,
        `phm bus thread ack ${delivery.threadId} ${delivery.id} --peer ${delivery.recipient}`]
      : ['phm bus board pending --peer <label>'];
    const created = Date.parse(delivery.createdAt);
    items.push({
      id: `board:delivery:${delivery.id}`,
      source: 'board',
      kind: 'board-delivery',
      // Board posts are P2 wire mail awaiting receipt — agent work, info like the mailbox's own P2 rows.
      severity: 'info',
      blocking: false,
      title: text === '' ? `board post ${delivery.sender} → ${delivery.recipient}` : text,
      detail: oneLine(`thread ${delivery.threadId} · ${delivery.sender} → ${delivery.recipient} · awaiting receipt`, DETAIL_MAX) || null,
      since: Number.isFinite(created) ? delivery.createdAt : null,
      expiresAt: null,
      ...jobIdsField(threadJobs.get(delivery.threadId) ?? []),
      act,
    });
  }
  for (const task of pending.tasks.items) {
    // A live queue claim means the work is in flight, not pending.
    if (task.hold === 'held') continue;
    const idsOk = BOARD_ID.test(task.id) && BOARD_ID.test(task.threadId);
    const hold = task.hold === 'open' ? 'unclaimed'
      : task.hold === 'ambiguous' ? 'ambiguous hold — expired claim the claim path never reclaims'
      : 'hold unknown — shared queue unreadable';
    const act = !idsOk ? ['phm bus board pending --peer <label>']
      : task.hold === 'ambiguous'
        ? [`phm bus task list ${task.threadId} --peer <label>`, 'phm bus board pending --peer <label>']
        : [`phm bus task claim ${task.id} --peer <label>`, `phm bus task list ${task.threadId} --peer <label>`];
    items.push({
      id: `board:task:${task.id}`,
      source: 'board',
      kind: 'board-task',
      severity: task.hold === 'open' ? 'info' : 'warn',
      blocking: false,
      title: oneLine(task.content.text, TITLE_MAX) || `board task ${task.id}`,
      detail: oneLine(`thread ${task.threadId} · fleet item ${task.itemId} · ${hold}` +
        (task.claimed ? ' · claim record on file' : ''), DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      jobIds: [task.itemId],
      act,
    });
  }
  const degraded = pending.claims === 'unreadable' || pending.deliveries.truncated || pending.tasks.truncated;
  return { report: { state: degraded ? 'degraded' : 'healthy', pending: items.length }, items };
}

/** The work-board states that still need a coordination decision: RECEIVED
 * (no named owner or durable claim receipt yet), ASSIGNED (owned but its
 * running evidence is stale or absent) and BLOCKED (a reply named what it
 * waits on). RUNNING carries fresh running evidence and VERIFIED proof of
 * completion — done or provably progressing, never pending. */
const WORK_BOARD_PENDING_STATES: ReadonlySet<WorkItemState> = new Set(['RECEIVED', 'ASSIGNED', 'BLOCKED']);

/**
 * The coordination work board's (`fleet work-board`) requests still needing a
 * decision — the same `listWorkBoard`/`classifyWorkItem` projection `phm fleet
 * work-board`, `fleet_work_board` and the cloud work-board route serve, so the
 * inbox and those surfaces can never disagree on an item's state, owner,
 * claim receipt or missing evidence. The board classifies every durable bus
 * request envelope; only the states above list, so a request that is done
 * (VERIFIED) or provably progressing (RUNNING) never counts as pending here
 * even though the conversations and bus sources may still carry its raw
 * envelope — this source adds the ownership/verification classification those
 * projections do not compute. `since` is the request's recorded `receivedAt`;
 * a retained receipt has no deadline, so `expiresAt` stays null. The board
 * carries no message bodies by design, so items name the envelope id, channel,
 * owner, claim receipt, missing-evidence list and (for BLOCKED) the named
 * dependency — and no provable job citation, so `--job` never matches. An
 * unreadable inbox scan is 'unavailable' with a null pending, never an empty
 * board passed off as fact; an unreadable claims or coordination table leaves
 * owners unknown the same way the board reports it, so the source degrades
 * rather than let partial evidence pass as complete. An envelope the bus
 * source already represents — a claimable work item, a worker handoff or a
 * `work.post` feed announcement — stays under `bus`: one pending thing, one
 * item. What lists here is what only the board computes — a non-work request
 * no owner or claim receipt has picked up, an assignment whose running
 * evidence went stale, or a reply naming what it waits on.
 */
function workBoardItems(read: NonNullable<UnifiedInboxOptions['readWorkBoard']>,
  options: UnifiedInboxOptions, covered: BusItemCoverage): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const root = options.busRoot ?? join(ashlrHome(), 'fleet');
  let result: WorkBoardResult;
  try { result = read({ root, now: (options.now ?? Date.now)(), limit: WORK_BOARD_MAX_LIMIT }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.inbox !== 'ok') return { report: { state: 'unavailable', pending: null }, items: [] };
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  for (const item of result.items) {
    if (!WORK_BOARD_PENDING_STATES.has(item.state)) continue;
    if (covered.envelopes.has(item.id) || covered.posts.has(item.id)) continue;
    const kind = item.state === 'RECEIVED' ? 'work-board-received'
      : item.state === 'ASSIGNED' ? 'work-board-assigned' : 'work-board-blocked';
    const missing = item.missing.length === 0 ? 'no missing evidence' : `missing ${item.missing.join(', ')}`;
    const owner = item.owner ?? 'unowned';
    const channel = item.channelRef ?? item.channel;
    const detail = item.state === 'BLOCKED'
      ? oneLine(`blocked · waiting on ${item.result?.kind === 'blocked' ? item.result.dependency : 'unknown'} · owner ${owner} · ${channel} · ${missing}`, DETAIL_MAX)
      : item.state === 'ASSIGNED'
        ? oneLine(`assigned · owner ${owner} · claim ${item.claimReceipt ?? 'unknown'} · ${channel} · ${missing}`, DETAIL_MAX)
        : oneLine(`unclaimed request · owner ${owner} · ${channel} · ${missing}`, DETAIL_MAX);
    items.push({
      id: `work-board:${item.id}`,
      source: 'work-board',
      kind,
      severity: item.state === 'ASSIGNED' ? 'info' : 'warn',
      blocking: false,
      title: oneLine(`Work board · ${item.state} · ${item.id}`, TITLE_MAX) || `Work board · ${item.state}`,
      detail: detail || null,
      since: item.receivedAt,
      expiresAt: null,
      act: [`phm fleet work-board --state ${item.state}`, `phm fleet work-trace --id ${item.id}`],
    });
  }
  const degraded = result.truncated || result.claims === 'unavailable' || result.coordination === 'unavailable';
  return { report: { state: degraded ? 'degraded' : 'healthy', pending: pendingCount(degraded ? 'degraded' : 'healthy', items.length) }, items };
}

/** The `--thread` label rule `agents bus post` enforces: printable ASCII, 1-128 chars. */
const THREAD_LABEL = /^[\x21-\x7e]{1,128}$/;

/**
 * Agent-to-agent conversation threads still needing a person — the same
 * `state:'waiting'` and `state:'blocked'` threads the one shared
 * conversations projection computes, read unfiltered and narrowed here so
 * thread state, subjects and ages can never disagree with that surface. A
 * waiting thread names who must answer and how long it has waited; a blocked
 * thread names who reported the block, who was told and how long it has
 * stood — a reported block nothing has answered is pending work like an
 * unanswered ask. A thread whose latest message is already a pending bus
 * item — an unclaimed work envelope or a live worker-handoff — or whose
 * `job:` thread the feed already lists stays under the bus source: one
 * pending thing, one item. The source state follows the projection honestly:
 * 'missing' is a verified-empty store, 'unavailable' an unreadable one
 * (never an empty list passed off as fact), and damaged rows the tolerant
 * scan skipped degrade the read rather than let partial coverage pass as
 * complete. `since` is the state change's start; the retained envelope TTL
 * is not part of the projection, so `expiresAt` stays null — unknown, never
 * invented.
 */
function conversationItems(read: NonNullable<UnifiedInboxOptions['readConversations']>,
  options: UnifiedInboxOptions, now: () => number,
  covered: BusItemCoverage): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: AgentConversations;
  try { result = read({}, { root: options.busRoot, now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.source === 'unavailable' || result.conversations === null) {
    return { report: { state: 'unavailable', pending: null }, items: [] };
  }
  if (result.source === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  for (const thread of result.conversations) {
    // Answered and done threads are history, not pending work.
    if (thread.state !== 'waiting' && thread.state !== 'blocked') continue;
    const last = thread.messages[thread.messages.length - 1];
    if (last === undefined) continue;
    if (covered.envelopes.has(last.id)) continue;
    if (thread.id.startsWith(JOB_THREAD_PREFIX) && covered.feedJobs.has(thread.id.slice(JOB_THREAD_PREFIX.length))) continue;
    const act = ['phm agents conversations', `phm agents bus show ${last.id}`];
    // The reply template only prints when the conversation key is itself a
    // label `agents bus post --thread` accepts; a key beyond the label bound
    // keeps the inspect acts rather than a command that cannot run.
    if (THREAD_LABEL.test(thread.id)) {
      act.push(`phm agents bus post --to <sender-label> --text "<reply>" --thread ${thread.id}`);
    }
    const title = oneLine(thread.subject, TITLE_MAX) || `agent thread ${thread.id}`;
    const count = `${thread.messageCount} message${thread.messageCount === 1 ? '' : 's'}`;
    if (thread.state === 'waiting' && thread.waiting !== null) {
      items.push({
        id: `conversations:${thread.id}`,
        source: 'conversations',
        kind: 'agent-thread',
        // A handoff waiting on a recipient is delegated work nobody picked up;
        // an ask is ordinary coordination. Neither blocks Mason, so never `blocking`.
        severity: last.kind === 'handoff' ? 'warn' : 'info',
        blocking: false,
        title,
        detail: cap(`from ${last.from} · waiting on ${thread.waiting.on} · ${count} · waiting ${plainAge(thread.waiting.ms)}`, DETAIL_MAX),
        since: thread.waiting.since,
        expiresAt: null,
        ...jobIdsField(thread.jobs),
        act,
      });
    } else if (thread.state === 'blocked') {
      items.push({
        id: `conversations:${thread.id}`,
        source: 'conversations',
        kind: 'agent-thread',
        // Unblocking a reported block is agent work, never Mason-blocking —
        // warn like a handoff wait, non-blocking like every thread item.
        severity: 'warn',
        blocking: false,
        title,
        detail: cap(`from ${last.from} · to ${last.to} · ${thread.stateText} for ${plainAge(now() - Date.parse(thread.lastAt))} · ${count}`, DETAIL_MAX),
        since: thread.lastAt,
        expiresAt: null,
        ...jobIdsField(thread.jobs),
        act,
      });
    }
  }
  return { report: { state: result.skipped > 0 ? 'degraded' : 'healthy', pending: items.length }, items };
}

/** Referent descriptions named inside one wake item's detail line before the overflow count takes over. */
const WAKE_DETAIL_REFS = 3;

/**
 * Pending wake hints fleet-wide — the same `readAllWakes` projection
 * `phm agents bus wakes --all` and `fleet_agent_wakes` serve, grouped by
 * addressee so the bounded queue tail never floods the view with one item
 * per hint. A wake is the bus's notification layer — "go read your inbox" —
 * never pending work itself and never Mason-blocking, so items are warn and
 * non-blocking; `since` is the newest hint's queue time (last activity, the
 * same rule conversation threads use) and `expiresAt` stays null because a
 * hint carries no deadline — it ages out of the bounded tail, unknown.
 * Each addressee's `jobIds` are the jobs its hints provably cite — a
 * claim-holder hint's `jobId` or a resolved referent's feed citation —
 * absent when none name a job. The addressee groups by resolved identity
 * when the `to` label resolves through the registry (one agent's hints
 * under any spelling merge) and by the literal label otherwise, so unknown
 * identity state never merges distinct addressees. An unreadable queue,
 * registry, bus store or hold table reports 'unavailable', never an empty
 * page passed off as "no wakes". A bounded-tail read that cut older hints
 * or capped matched rows beyond the shown slice reports 'degraded' — the
 * same `matched`/`truncated` honesty `agents bus wakes --all` and
 * `fleet_agent_wakes` surface — while still listing the addressee groups
 * it proved, never a healthy under-count passed off as the whole queue.
 */
function wakeItems(read: NonNullable<UnifiedInboxOptions['readWakes']>,
  options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let page: AllWakesPage;
  try { page = read({ root: options.busRoot, runsRoot: options.runsDir, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (page.status !== 'ok') return { report: { state: 'unavailable', pending: null }, items: [] };
  const registryRead = readAgentRegistry({ root: options.busRoot });
  const registry = registryRead.status === 'ok' ? registryRead.registry : undefined;
  interface WakeGroup { key: string; label: string; rows: AgentWakeRow[] }
  const groups = new Map<string, WakeGroup>();
  for (const wake of page.wakes) {
    const identity = registry === undefined ? undefined : resolveAgent(registry, wake.to);
    const key = identity === undefined ? `label:${wake.to}` : `id:${identity.id}`;
    const group = groups.get(key) ?? { key, label: identity?.handle ?? wake.to, rows: [] };
    group.rows.push(wake);
    groups.set(key, group);
  }
  const items = [...groups.values()].map((group): Omit<UnifiedInboxItem, 'priority'> => {
    const newestFirst = [...group.rows].sort((a, b) => b.at - a.at);
    const newest = newestFirst[0]!;
    const count = group.rows.length;
    const jobIds = new Set<string>();
    const refs: string[] = [];
    for (const wake of newestFirst.slice(0, WAKE_DETAIL_REFS)) {
      const holder = wake.claimHolder;
      const message = wake.message;
      if (holder !== undefined && holder !== 'unresolved' && holder !== 'unknown') {
        jobIds.add(holder.jobId);
        refs.push(`job ${holder.jobId} ${holder.status}`);
      } else if (message?.status === 'resolved') {
        if (message.job !== undefined) jobIds.add(message.job.jobId);
        refs.push(`"${oneLine(message.summary, 80)}"`);
      } else {
        refs.push(`hint ${wake.id}`);
      }
    }
    const overflow = count > WAKE_DETAIL_REFS ? ` +${count - WAKE_DETAIL_REFS} more` : '';
    const detail = refs.length === 0 ? null : oneLine(`${refs.join(' · ')}${overflow}`, DETAIL_MAX);
    return {
      id: `wakes:${createHash('sha256').update(group.key).digest('hex').slice(0, 16)}`,
      source: 'wakes',
      kind: 'wake-hint',
      severity: 'warn',
      blocking: false,
      title: oneLine(`${count} pending wake hint${count === 1 ? '' : 's'} for ${group.label}`, TITLE_MAX),
      detail,
      since: iso(newest.at),
      expiresAt: null,
      ...jobIdsField(jobIds),
      act: [`phm agents bus wakes ${group.label}`, 'phm agents bus wakes --all'],
    };
  });
  items.sort((a, b) => (b.since ?? '').localeCompare(a.since ?? ''));
  const truncated = page.truncated || page.matched > page.wakes.length;
  return { report: { state: truncated ? 'degraded' : 'healthy', pending: items.length }, items };
}

/** Work refs named inside one seat item's detail line before the overflow count takes over. */
const SEAT_DETAIL_REFS = 4;

/**
 * Bot seats whose projected handoff plan still has work to move — the same
 * `planSeatHandoffs` read `phm bots handoffs` serves, so this source and that
 * surface can never disagree. Only eligible seats with pending (not yet
 * journaled) handoff records list: a draining seat with nothing left to
 * release is already on its way to idle, not pending work, and an ineligible
 * seat's held work is not a handoff candidate. Seat handoffs are agent work,
 * never Mason-blocking, so items are warn and non-blocking; `since` stays
 * null because the plan stamps records at the read instant, not at a real
 * age, and `expiresAt` stays null — unknown, never invented. An empty roster
 * is 'missing' (no seats configured); a throwing or refused plan read is
 * 'unavailable', never an empty plan passed off as fact.
 */
async function seatItems(read: NonNullable<UnifiedInboxOptions['readSeatHandoffs']>,
  now: () => number): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  let plan: SeatHandoffsPlan;
  try { plan = await read({ now }); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (plan.seats.length === 0) return { report: { state: 'missing', pending: 0 }, items: [] };
  const items = plan.seats
    .filter(seat => seat.eligible && seat.handoffs.length > 0)
    .map((seat): Omit<UnifiedInboxItem, 'priority'> => {
      const count = seat.handoffs.length;
      const refs = seat.handoffs.slice(0, SEAT_DETAIL_REFS)
        .map(handoff => `${handoff.work.kind} ${handoff.work.ref}`).join(', ');
      const overflow = count > SEAT_DETAIL_REFS ? ` +${count - SEAT_DETAIL_REFS} more` : '';
      // A `node-job` ref is the queue job id the seat must drain; a `bus-claim`
      // ref is a coordination claim key, not a job id.
      const jobIds = seat.handoffs.filter(handoff => handoff.work.kind === 'node-job')
        .map(handoff => handoff.work.ref);
      return {
        id: `seats:${seat.seatId}`,
        source: 'seats',
        kind: 'seat-handoff',
        severity: 'warn',
        blocking: false,
        title: oneLine(`Seat ${seat.seatId} (${seat.state}): ${count} pending handoff${count === 1 ? '' : 's'}`, TITLE_MAX),
        detail: oneLine(`${seat.state} · ${refs}${overflow}`, DETAIL_MAX),
        since: null,
        expiresAt: null,
        ...jobIdsField(jobIds),
        act: [
          `phm bots handoff --seat ${seat.seatId}`,
          `phm bots handoff --seat ${seat.seatId} --apply`,
          'phm bots handoffs',
        ],
      };
    });
  return { report: { state: 'healthy', pending: items.length }, items };
}

/**
 * The peer work-dispatch journal schema, restated locally: the canonical
 * reader (`src/core/agentnet/work-dispatch-journal.ts`) sits outside the
 * Tier-1 authority import closure and this file cannot import it without
 * growing that closure, so the v1 shape is mirrored here against the shared
 * `workResultBodySchema` — a bus-v2 contract change still moves both reads —
 * with `version` literal 1, so a v2 journal reports 'unavailable' in both
 * places. Field constraints match the canonical schema exactly.
 */
const peerDispatchCallsign = z.string().regex(/^[a-z][a-z0-9-]{0,31}(?![\s\S])/).refine(v => scrubSecrets(v) === v);
const peerDispatchReceiptSchema = workResultBodySchema.extend({
  peer: peerDispatchCallsign, consumer: peerDispatchCallsign,
  digest: z.string().regex(/^[a-f0-9]{64}$/), at: z.number().int().nonnegative(),
  queueDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sent: workResultBodySchema.shape.outcome.optional(),
}).strict();
const peerDispatchJournalSchema = z.object({ version: z.literal(1),
  receipts: z.array(peerDispatchReceiptSchema).max(512) }).strict();

/**
 * The journal's bus root: `agentnetPaths().busRoot` is
 * `join(realHome(), '.ashlr', 'fleet')` — the root `consumePeerWork` writes
 * `work-dispatch.json` under — restated here for the same closure reason as
 * the schema above. A missing real home throws, which the caller reports as
 * 'unavailable' rather than guessing a path.
 */
function peerDispatchBusRoot(busRoot: string | undefined): string {
  if (busRoot !== undefined) return busRoot;
  const home = realHome();
  if (!home) throw new Error('peer-home-unavailable');
  return join(home, '.ashlr', 'fleet');
}

/**
 * Read `<busRoot>/agentnet/work-dispatch.json` with the same private-file
 * gate `readPeerJson` applies — regular file, single link, mode 0600, owned
 * by this uid, bounded stable read anchored at the bus root — then the same
 * v1 schema parse, so this source and `phm agentnet peers dispatch` agree on
 * what the journal says. Missing means dispatch never ran; anything else
 * unreadable or invalid is 'unavailable', never an empty backlog passed off
 * as fact.
 */
function readPeerDispatchJournal(options: { busRoot?: string }): WorkDispatchJournal {
  const busRoot = peerDispatchBusRoot(options.busRoot);
  const file = join(busRoot, 'agentnet', 'work-dispatch.json');
  if (!existsSync(file)) return { status: 'missing', receipts: [] };
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 ||
        (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) ||
        (process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new Error('peer-storage-unavailable');
    }
    const read = readStableRegularFile(file, {
      anchorPath: busRoot, maxFileBytes: 512 * 1024, remainingBytes: 512 * 1024,
    });
    if (!read.ok) throw new Error('peer-storage-unavailable');
    return { status: 'available',
      receipts: peerDispatchJournalSchema.parse(JSON.parse(read.text)).receipts };
  } catch { return { status: 'unavailable', receipts: [] }; }
}

/**
 * Peer work results the journal recorded but never confirmed published —
 * receipts whose `sent` trails `outcome` (or was never written). The peer
 * admission check refuses a `work.result` envelope the journal does not
 * prove this host published with that exact outcome, so each lagging
 * receipt is a result the proposing peer is still waiting on and no other
 * surface lists: the dispatch feed page shows only the current proposals.
 * Publishing is agent work — `phm agentnet peers dispatch --apply` runs the
 * same publish pass `consumePeerWork` caps at eight receipts a run — so
 * items are warn and non-blocking. `since` stays null because the journal
 * stamps receipt creation, not the last outcome move, so the pending age is
 * unknown; `expiresAt` stays null for the same reason — the result waits
 * until the next apply pass, never a guessed deadline. The receipt's
 * peer-announced `jobId` is the job citation `--job` matches on. An absent
 * journal is 'missing' (dispatch never ran); an unreadable one
 * 'unavailable', never an empty backlog passed off as fact.
 */
function peerDispatchItems(read: NonNullable<UnifiedInboxOptions['readPeerDispatch']>,
  options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let journal: WorkDispatchJournal;
  try { journal = read({ busRoot: options.busRoot }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (journal.status === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  if (journal.status === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  // `consumePeerWork` derives queueId and receiptId from one key, so a real
  // journal never repeats a receipt id; a hand-edited one could, and one
  // pending thing must stay one item.
  const seen = new Set<string>();
  const items = journal.receipts
    .filter(receipt => receipt.sent !== receipt.outcome && !seen.has(receipt.receiptId) && seen.add(receipt.receiptId))
    .map((receipt): Omit<UnifiedInboxItem, 'priority'> => ({
      id: `peer-dispatch:${receipt.receiptId}`,
      source: 'peer-dispatch',
      kind: 'peer-dispatch-result',
      severity: 'warn',
      blocking: false,
      title: oneLine(`peer ${receipt.peer} awaits ${receipt.outcome} result for ${receipt.jobId}`, TITLE_MAX),
      detail: oneLine(`consumer ${receipt.consumer} · queue ${receipt.queueId} · receipt ${receipt.receiptId}` +
        ` · last sent ${receipt.sent ?? 'none'}` +
        (receipt.reason === undefined ? '' : ` · reason ${receipt.reason}`), DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      ...jobIdsField([receipt.jobId]),
      act: ['phm agentnet peers dispatch --apply'],
    }));
  return { report: { state: 'healthy', pending: items.length }, items };
}

/**
 * The peer-inbox plane's private-file gate — `readPeerJson`'s exact custody
 * rule restated locally for the same Tier-1 closure reason the dispatch
 * journal schema above is mirrored: no symlinks, hardlinks, public or
 * foreign-owned files and no unbounded reads, anchored at the store the
 * file belongs to. Errors never include contents.
 */
function readPeerPlaneJson(path: string, anchorPath: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 ||
      (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) ||
      (process.getuid !== undefined && stat.uid !== process.getuid())) {
    throw new Error('peer-storage-unavailable');
  }
  const read = readStableRegularFile(path, {
    anchorPath, maxFileBytes: 512 * 1024, remainingBytes: 512 * 1024,
  });
  if (!read.ok) throw new Error('peer-storage-unavailable');
  return JSON.parse(read.text);
}

/**
 * The peer bindings and coordination-ledger schemas, restated locally field
 * for field against `slack-identities.ts`'s `bindingSchema`/`readPeerBindings`
 * and `peer-bus.ts`'s `rowSchema` — the same mirror discipline the dispatch
 * journal above keeps, so this source and `phm agentnet peers read` /
 * `agents bus status`'s `peerInbox` section agree on what the stores say. A
 * schema change on the agentnet side must move this mirror too.
 */
const peerInboxLabel = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}(?![\s\S])/).refine(v => scrubSecrets(v) === v);
const peerInboxReference = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:/#-]+(?![\s\S])/).refine(v => scrubSecrets(v) === v);
const peerInboxId = z.string().regex(/^peer-[a-f0-9-]{36}(?![\s\S])/);
const peerInboxBindingSchema = z.object({
  callsign: peerDispatchCallsign, lane: peerInboxLabel, sessionId: peerInboxLabel,
  sessionHash: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/), expiresAt: z.number().int().nonnegative(),
  teamId: z.string().regex(/^T[A-Z0-9]{2,32}(?![\s\S])/),
  userId: z.string().regex(/^[UW][A-Z0-9]{2,32}(?![\s\S])/),
  botId: z.string().regex(/^B[A-Z0-9]{2,32}(?![\s\S])/),
  topic: peerInboxLabel,
}).strict();
const peerInboxBindingsSchema = z.object({ version: z.literal(1),
  peers: z.array(peerInboxBindingSchema).max(128) }).strict();
const peerInboxRowSchema = z.object({ id: peerInboxId, fromAgent: peerDispatchCallsign,
  target: peerInboxReference, origin: peerInboxId,
  digest: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/), hopCount: z.number().int().min(1).max(8),
  threadId: peerInboxReference, at: z.number().int().nonnegative() }).strict();
const peerInboxLedgerSchema = z.array(peerInboxRowSchema).max(1024);
type PeerInboxLedgerRow = z.infer<typeof peerInboxRowSchema>;

/** The live-admission window `readPeerInbox`/`probePeerInbox` apply to ledger rows — 24h from the recorded send instant. */
const PEER_INBOX_LIVE_MS = 86_400_000;
/** The wire id shape `consumePeerWork` stamps on published work.result replies — the same expression the sessioned read and the status probe apply. */
const PEER_INBOX_WORK_RESULT_ID = /^(pw-[a-f0-9]{32})-(reserved|admitted|complete|failed)$/;

/** `workDispatchResultBody` restated: the exact body the journal proves this host published for one receipt. */
function peerInboxResultBody(row: z.infer<typeof peerDispatchReceiptSchema>): unknown {
  return workResultBodySchema.parse({
    kind: row.kind, jobId: row.jobId, claimKey: row.claimKey, queueId: row.queueId,
    receiptId: row.receiptId, outcome: row.outcome, ...(row.reason ? { reason: row.reason } : {}),
  });
}

/** The bindings path the peer verbs resolve — `agentnetPaths().bindings` under `realHome()` or the caller's override; a `busRoot` override never relocates it. Undefined when no real home exists. */
function peerInboxBindingsPath(override: string | undefined): string | undefined {
  if (override !== undefined) return override;
  const home = realHome();
  return home === null ? undefined : join(home, '.ashlr', 'agentnet', 'bindings.json');
}

/**
 * The fleet-wide admitted peer-mail read — `probePeerInbox`'s count applied
 * per envelope instead of summed, so the unified inbox can itemize what
 * `phm agentnet peers read` would return for this host's live-enrolled
 * callsigns. Same inputs, same proofs, same states: the bindings file's
 * live callsigns, the coordination ledger's admission rows and the dispatch
 * journal's published work.result receipts, paged through the same bounded
 * live-receipt scan. A `work.*`/`wake` body is admitted too but the bus and
 * wakes sources already own those pending things, so the read returns every
 * admitted envelope and the item builder drops the covered kinds — one
 * pending thing one item. Never throws: any unreadable input reports
 * 'unavailable', never an empty backlog passed off as fact.
 */
function readPeerInboxSource(options: { busRoot?: string; bindings?: string; now?: () => number }): PeerInboxRead {
  const unavailable: PeerInboxRead = { state: 'unavailable', messages: [], truncated: false };
  try {
    const busRoot = peerDispatchBusRoot(options.busRoot);
    const bindingsPath = peerInboxBindingsPath(options.bindings);
    if (bindingsPath === undefined) return unavailable;
    const now = options.now ?? Date.now;
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return unavailable;
    let enrolled: 'missing' | 'available';
    try { lstatSync(bindingsPath); enrolled = 'available'; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') enrolled = 'missing';
      else return unavailable;
    }
    const callsigns = new Set<string>();
    if (enrolled === 'available') {
      try {
        const parsed = peerInboxBindingsSchema.parse(readPeerPlaneJson(bindingsPath, dirname(bindingsPath)));
        // The same uniqueness rule `readPeerBindings` enforces — a conflicting
        // file refuses every peer verb, so it proves no admission here either.
        for (const key of ['callsign', 'userId', 'botId', 'sessionHash'] as const) {
          if (new Set(parsed.peers.map(peer => peer[key])).size !== parsed.peers.length) {
            throw new Error('peer-binding-conflict');
          }
        }
        for (const peer of parsed.peers) if (peer.expiresAt > nowMs) callsigns.add(peer.callsign);
      } catch { return unavailable; }
    }
    // No live-enrolled callsign can hold admitted mail: an empty set is
    // proven without touching the bus store, ledger or journal.
    if (callsigns.size === 0) {
      return { state: enrolled === 'missing' ? 'missing' : 'available', messages: [], truncated: false };
    }
    const store = inspectBusInbox({ root: busRoot, now });
    if (store.source === 'missing') return { state: 'missing', messages: [], truncated: false };
    if (store.source !== 'available') return unavailable;
    const ledgerFile = join(busRoot, 'agentnet', 'coordination.json');
    let ledgerRows: PeerInboxLedgerRow[] = [];
    if (existsSync(ledgerFile)) {
      try { ledgerRows = peerInboxLedgerSchema.parse(readPeerPlaneJson(ledgerFile, busRoot)); }
      catch { return unavailable; }
    }
    const journal = readPeerDispatchJournal({ busRoot });
    // work.result replies admit only on journal proof; an unreadable journal
    // leaves that half of the read unprovable, so the total is unknown.
    if (journal.status === 'unavailable') return unavailable;
    const dispatched = new Map(journal.receipts.map(receipt => [receipt.receiptId, receipt]));
    const admittedRows = new Map<string, PeerInboxLedgerRow[]>();
    for (const row of ledgerRows) {
      if (!callsigns.has(row.target) || row.at > nowMs || nowMs - row.at >= PEER_INBOX_LIVE_MS) continue;
      const list = admittedRows.get(row.id);
      if (list) list.push(row); else admittedRows.set(row.id, [row]);
    }
    const workResultAdmitted = (original: NonNullable<BusInboxReceipt['originalEnvelope']>): boolean => {
      if (!callsigns.has(original.to)) return false;
      const match = PEER_INBOX_WORK_RESULT_ID.exec(original.id);
      if (!match) return false;
      const receipt = dispatched.get(match[1]!);
      return receipt !== undefined && receipt.peer === original.to && receipt.sent === match[2] &&
        receipt.outcome === match[2] && original.from === receipt.consumer &&
        JSON.stringify(original.body) === JSON.stringify(peerInboxResultBody(receipt));
    };
    const admitted = new Map<string, PeerInboxPending>();
    let after = 0, truncated = false;
    const maxPages = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ);
    for (let page = 0; page < maxPages; page++) {
      const result = listBusInboxAfter(after, BUS_INBOX_MAX_READ,
        { root: busRoot, now, includeOriginalEnvelope: true });
      if (result.status !== 'ok') {
        if (page === 0) return unavailable;
        truncated = true; break;
      }
      for (const receipt of result.messages) {
        const original = receipt.originalEnvelope;
        if (original === undefined) continue;
        const digest = createHash('sha256').update(JSON.stringify(original)).digest('hex');
        const ledgerMatches = (admittedRows.get(original.id) ?? [])
          .filter(row => receipt.receivedAt === row.at && row.digest === digest);
        const resultAdmitted = workResultAdmitted(original);
        if (ledgerMatches.length === 0 && !resultAdmitted) continue;
        const prior = admitted.get(original.id);
        const admittedFor = new Set(prior?.admittedFor ?? []);
        for (const row of ledgerMatches) admittedFor.add(row.target);
        if (resultAdmitted) admittedFor.add(original.to);
        admitted.set(original.id, {
          id: original.id, from: original.from, to: original.to, priority: original.priority,
          receivedAt: receipt.receivedAt, ttl: original.ttl, body: original.body,
          admittedFor: [...admittedFor].sort(),
        });
      }
      after = result.nextCursor;
      if (result.messages.length < BUS_INBOX_MAX_READ) break;
      if (page === maxPages - 1) truncated = true;
    }
    return { state: 'available', messages: [...admitted.values()], truncated };
  } catch { return unavailable; }
}

/** Body kinds the bus/work-feed projection already owns — an admitted peer
 * envelope carrying one of these is the same pending thing a `bus`/`wakes`
 * item already lists, so it stays under that source. `work.result` is
 * deliberately absent: the feed reads results as job evidence but never
 * lists the reply itself, and the peer-dispatch source covers only
 * unpublished outcomes — a published result the peer has not read is
 * admitted mail with no other surface. */
const PEER_INBOX_FEED_KINDS: ReadonlySet<string> = new Set(
  ['work.post', 'work.status', 'work.claim', 'work.release', 'wake']);

/**
 * Admitted peer mail the bus source does not already own — `peer.message`
 * bodies (a peer's task, review, handoff, query or social note), published
 * `work.result` replies the peer has not read, and any other admitted shape
 * no feed projection covers. Each lists as a warn
 * `peer-message` — agent coordination awaiting a sessioned `peers read`,
 * never Mason-blocking — naming the enrolled callsigns whose session
 * admits it (the actionable half of the read: which `PHM_AGENTNET_*`
 * session has this pending), a scrubbed body summary as title and the
 * envelope's real receipt/TTL times; a stored P0 band maps to high like
 * every other source's priority carry. `jobIds` keeps only the body's own
 * provable citations. Act: `peers read --id` (the admission-correct
 * filtered read), `agents bus show` (works without a session) and bare
 * `peers read`. The source states are the read's own — 'missing' a
 * verified-absent bindings file, bus store or peer plane, 'unavailable'
 * any input the proofs cannot read — and a truncated bounded scan degrades
 * it with pending a stated floor.
 */
function peerInboxItems(read: NonNullable<UnifiedInboxOptions['readPeerInbox']>,
  options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: PeerInboxRead;
  try { result = read({ busRoot: options.busRoot, bindings: options.agentnetBindings, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.state === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  if (result.state === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  const items = result.messages
    .filter(message => !isClaimableWork(message.body) && !isWorkerHandoffBody(message.body) &&
      !PEER_INBOX_FEED_KINDS.has(busBodyKind(message.body) ?? ''))
    .map((message): Omit<UnifiedInboxItem, 'priority'> => {
      const expiry = message.receivedAt + message.ttl;
      // ECMAScript's Date range ends at ±8.64e15 ms; an out-of-range expiry
      // stays null — unknown, never an invalid timestamp.
      const expiresAt = Number.isSafeInteger(expiry) && expiry <= 8_640_000_000_000_000 ? iso(expiry) : null;
      return {
        id: `peer-inbox:${message.id}`,
        source: 'peer-inbox',
        kind: 'peer-message',
        severity: message.priority === 'P0' ? 'high' : 'warn',
        blocking: false,
        title: oneLine(busBodySummary(message.body) ?? `peer mail ${message.from} → ${message.to}`, TITLE_MAX),
        detail: oneLine(`admitted for ${message.admittedFor.join(', ')}`, DETAIL_MAX) || null,
        since: iso(message.receivedAt),
        expiresAt,
        ...jobIdsField(busBodyJobIds(message.body)),
        act: [
          `phm agentnet peers read --id ${message.id}`,
          `phm agents bus show ${message.id}`,
          'phm agentnet peers read',
        ],
      };
    });
  return { report: { state: result.truncated ? 'degraded' : 'healthy', pending: items.length }, items };
}

/** The resume bound `planSessionResume` enforces — a checkpoint older than
 * 24h refuses resume and failover, so `expiresAt` reports that real deadline. */
const SESSION_HANDOFF_RESUME_WINDOW_MS = 24 * 3_600_000;

/**
 * Open session-handoff checkpoints — jobs that yielded mid-run and wait for
 * a resume or failover pass. The same `listSessionHandoffs` bounded journal
 * scan `phm checkpoint handoff list`, `fleet_session_handoffs`, the
 * bus-status probe's `sessionHandoffs` section and `work mine`'s `sessions`
 * digest serve, so this source and those surfaces can never disagree about
 * which checkpoints are open. Checkpointed work is agent work, never
 * Mason-blocking, so items are warn and non-blocking; `since` is the latest
 * revision's recorded time and `expiresAt` the 24-hour resume bound — both
 * real journal facts, never invented. A pressure signal — rate-limit,
 * quota-exhausted or a budget at its threshold, the same `handoffPressure`
 * verdict `planSessionFailover` applies — marks the item for failover in
 * its title. The journal's job id is the `--job` citation; the detail
 * carries the resume facts an agent needs — lane, model, minimum tier,
 * repo, attempt and revision — scrubbed and single-lined like every other
 * item. The read's own `unreadable`/`truncated` flags degrade the source:
 * journals that fail validation or sit past the bounded scan could hide
 * open checkpoints, so pending stays a stated floor. An absent store is
 * 'missing' (no handoff was ever checkpointed); an uninspectable one
 * 'unavailable', never an empty list passed off as fact.
 */
function sessionHandoffItems(read: NonNullable<UnifiedInboxOptions['readSessionHandoffs']>,
  options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let list: SessionHandoffList;
  try { list = read({ runsDir: options.runsDir }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (list.status === 'unavailable' || list.handoffs === null) {
    return { report: { state: 'unavailable', pending: null }, items: [] };
  }
  if (list.status === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const items = list.handoffs
    .filter(entry => entry.state === 'open')
    .map((entry): Omit<UnifiedInboxItem, 'priority'> => {
      const atMs = Date.parse(entry.at);
      return {
        id: `session-handoff:${entry.job}`,
        source: 'session-handoff',
        kind: 'session-handoff',
        severity: 'warn',
        blocking: false,
        title: oneLine(`Session handoff ${entry.job}: ${entry.signal.kind}${handoffPressure(entry.signal) ? ' (failover)' : ''}`, TITLE_MAX),
        detail: oneLine(`${entry.lane} · ${entry.model} · min tier ${entry.minTier} · ${entry.repo}` +
          ` · attempt ${entry.attempt} rev ${entry.revision} · needs ${entry.needs.join(', ') || 'none'}` +
          ` · head ${entry.head.slice(0, 12)}`, DETAIL_MAX) || null,
        since: entry.at,
        expiresAt: Number.isFinite(atMs) ? new Date(atMs + SESSION_HANDOFF_RESUME_WINDOW_MS).toISOString() : null,
        ...jobIdsField([entry.job]),
        act: [
          `phm checkpoint handoff show ${dir} ${entry.job}`,
          `phm checkpoint handoff list ${dir} --state open`,
        ],
      };
    });
  const degraded = list.truncated || (list.unreadable?.length ?? 0) > 0;
  return { report: { state: degraded ? 'degraded' : 'healthy', pending: items.length }, items };
}

/**
 * The org-plane store schema, restated locally: the canonical modules
 * (`src/core/org/agent-plane-schema.ts`, `agent-plane-reader.ts`,
 * `agent-plane-outbox.ts`) sit outside the Tier-1 authority import closure
 * and this file cannot import them without growing that closure, so the
 * `org.agents.v1` shape — role, proposal, edit and ledger rows plus the
 * chart invariants `validateChart` enforces and the revision contiguity
 * `readAgentPlane` requires — is mirrored here field for field, the same
 * way the peer-dispatch journal mirrors its own schema above. A schema or
 * validation change on the org side must move this mirror too; until then
 * both reads agree on what the store says.
 */
const orgPlaneId = z.string().regex(/^[a-z][a-z0-9-]{0,63}(?![\s\S])/);
const orgPlaneCount = z.number().int().nonnegative().safe();
const orgPlaneNeed = z.string().regex(/^[a-z][a-z0-9._-]{0,63}(?![\s\S])/)
  .refine(value => !/(^|[._-])(secrets?|credentials?|payments?|billing|2fa|mfa|auth|passwords?)([._-]|$)/.test(value), 'Restricted capability scope');
const orgPlaneRoleSchema = z.object({
  id: orgPlaneId, title: z.string().trim().min(1).max(120), charter: z.string().trim().min(1).max(2000),
  tier: z.enum(['LEADER', 'ORCHESTRATOR', 'WORKER_SESSION']), reportsTo: orgPlaneId.nullable(),
  status: z.enum(['active', 'retired']), scope: z.enum(['engineering', 'research', 'janitor', 'comms-draft']),
  needs: z.array(orgPlaneNeed).max(32),
  laneAffinities: z.array(orgPlaneId).max(32),
  budget: z.object({ tokens: orgPlaneCount.max(1_000_000_000), sessions: orgPlaneCount.max(1000), maxCostClass: z.enum(['local', 'included', 'metered']) }).strict(),
  sizing: z.object({ batchDepth: orgPlaneCount.min(10).max(1000), fanOut: orgPlaneCount.max(32) }).strict(),
  sessionId: z.string().regex(/^[a-z][a-z0-9_-]{0,127}(?![\s\S])/).nullable(),
}).strict();
const orgPlaneProposalSchema = z.object({
  actor: orgPlaneId, reason: z.string().trim().min(1).max(1000), expectedRevision: orgPlaneCount,
  change: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('upsert'), role: orgPlaneRoleSchema }).strict(),
    z.object({ kind: z.literal('retire'), id: orgPlaneId }).strict(),
    z.object({ kind: z.literal('revoke'), revision: orgPlaneCount.min(1) }).strict(),
  ]),
}).strict();
const orgPlaneEditSchema = z.object({ before: orgPlaneRoleSchema.nullable(), after: orgPlaneRoleSchema.nullable() }).strict();
const orgPlaneSchema = z.object({
  schema: z.literal('org.agents.v1'), storeId: z.string().uuid(), revision: orgPlaneCount,
  agents: z.array(orgPlaneRoleSchema).max(256),
  ledger: z.array(z.object({
    revision: orgPlaneCount.min(1), at: z.string().datetime(), proposal: orgPlaneProposalSchema,
    applied: z.boolean(), edits: z.array(orgPlaneEditSchema).max(256), busDelivered: z.boolean(),
  }).strict()).max(2000),
}).strict();
type OrgPlaneRole = z.infer<typeof orgPlaneRoleSchema>;
type OrgPlane = z.infer<typeof orgPlaneSchema>;

/** `validateChart`, mirrored: the same reporting-tier, budget-ceiling, cost-class and session-staffing invariants `readAgentPlane` enforces before any outbox read trusts the store. */
function orgPlaneValidateChart(agents: OrgPlaneRole[]): void {
  const roles = new Map(agents.map(role => [role.id, role]));
  if (roles.size !== agents.length || roles.has('board')) throw new Error('Duplicate or reserved role id.');
  const leaders = agents.filter(role => role.tier === 'LEADER');
  if (leaders.length !== 1 || leaders[0]!.id !== 'leader' || leaders[0]!.status !== 'active' || leaders[0]!.reportsTo !== null) throw new Error('One active leader is required.');
  for (const role of agents) {
    if (role.sessionId !== null && role.tier !== 'WORKER_SESSION') throw new Error('Only workers bind sessions.');
    if (role.tier === 'LEADER' || role.status === 'retired') continue;
    const parent = roles.get(role.reportsTo ?? '');
    if (!parent || parent.status !== 'active' || parent.tier !== (role.tier === 'ORCHESTRATOR' ? 'LEADER' : 'ORCHESTRATOR')) throw new Error('Invalid reporting tier or inactive parent.');
    const siblings = agents.filter(other => other.status === 'active' && other.reportsTo === parent.id);
    if (siblings.reduce((sum, child) => sum + child.budget.tokens, 0) > parent.budget.tokens || siblings.reduce((sum, child) => sum + child.budget.sessions, 0) > parent.budget.sessions) throw new Error('Child budgets exceed parent planning ceiling.');
    if (['local', 'included', 'metered'].indexOf(role.budget.maxCostClass) > ['local', 'included', 'metered'].indexOf(parent.budget.maxCostClass)) throw new Error('Child cost class exceeds parent.');
  }
  const sessions = agents.filter(role => role.status === 'active' && role.sessionId !== null).map(role => role.sessionId);
  if (new Set(sessions).size !== sessions.length) throw new Error('Session is already staffed.');
}

/** Storage cap for `org/agents.json`, as in the source PR (`ORG_STORE_MAX_BYTES`). */
const ORG_STORE_MAX_BYTES = 4 * 1024 * 1024;

/** The runs root the org store lives under: `options.runsDir`, then `ASHLR_RUNS_DIR`, then `~/.ashlr-runs` — the same resolution every other runsDir source here applies, matching `orgRunsRoot`'s own env/home fallback. */
function orgOutboxRunsDir(runsDir: string | undefined): string {
  return runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
}

/**
 * Read `<runsDir>/org/agents.json` and return the org.membership events its
 * ledger still owes the bus — `busDelivered:false` entries, one event per
 * distinct `(revision, role)` edit pair, exactly the set `previewOrgOutbox`
 * would replay. The read applies `readAgentPlane`'s whole acceptance —
 * absent store is 'missing', symlink/non-file/oversize/unstable/secret-shaped/
 * schema-invalid/chart-invalid/non-contiguous-ledger is 'unavailable' — so
 * this source and `phm fleet org-sync`/`org-board` can never disagree about
 * whether the store is trustworthy. An undelivered edit with neither a
 * before nor an after role is one `envelopes` cannot form, which the apply
 * pass would crash on; it reports 'unavailable' here too rather than
 * listing a partial backlog the real pass refuses.
 */
function readOrgPlaneOutbox(options: { runsDir?: string }): OrgOutboxRead {
  const anchor = resolve(orgOutboxRunsDir(options.runsDir));
  const file = join(anchor, 'org', 'agents.json');
  let stat;
  try { stat = lstatSync(file); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing', events: [] }
      : { status: 'unavailable', events: [] };
  }
  try {
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > ORG_STORE_MAX_BYTES) {
      throw new Error('org-store-refused');
    }
    const read = readStableRegularFile(file, {
      anchorPath: anchor, maxFileBytes: ORG_STORE_MAX_BYTES, remainingBytes: ORG_STORE_MAX_BYTES,
    });
    if (!read.ok) throw new Error('org-store-refused');
    const raw: unknown = JSON.parse(read.text);
    // `metadata(planeSchema, raw)`: the secret-shape gate runs on the raw
    // JSON text before the schema parse, exactly like the canonical read.
    assertMetadata(JSON.stringify(raw) ?? '');
    const plane: OrgPlane = orgPlaneSchema.parse(raw);
    orgPlaneValidateChart(plane.agents);
    if (plane.revision !== plane.ledger.length ||
        plane.ledger.some((entry, index) => entry.revision !== index + 1)) {
      throw new Error('org-ledger-refused');
    }
    const events: OrgOutboxEvent[] = [];
    const seen = new Set<string>();
    for (const entry of plane.ledger.filter(row => !row.busDelivered)) {
      for (const edit of entry.edits) {
        const role = edit.after ?? edit.before;
        if (role === null) throw new Error('org-event-refused');
        const id = `org-${plane.storeId}-${entry.revision}-${role.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        events.push({
          id, revision: entry.revision, roleId: role.id,
          actor: entry.proposal.actor, tier: role.tier,
          status: edit.after?.status ?? 'retired', at: entry.at,
        });
      }
    }
    return { status: 'ok', events };
  } catch { return { status: 'unavailable', events: [] }; }
}

/**
 * Org-membership bus events the org plane recorded but `phm fleet org-sync
 * --apply` has not yet confirmed posted. `org.membership` envelopes are how
 * the org chart's staffing changes reach the bus — planning metadata that
 * grants no execution authority — and until the apply pass replays them no
 * other surface lists them: `org-board` shows only a `pendingBusEvents`
 * count, and the bus itself cannot see an event it never received. Each
 * undelivered ledger edit is one pending delivery; items are warn and
 * non-blocking because the apply pass is ordinary agent work, and `since`
 * carries the ledger entry's recorded application time. `expiresAt` stays
 * null — the event waits until the next org-sync pass, never a guessed
 * deadline. The store keeps actor callsigns, role ids and revisions only —
 * never role charters, proposals' free-text reasons or member data — so
 * titles and details stay inside that vocabulary.
 */
function orgOutboxItems(read: NonNullable<UnifiedInboxOptions['readOrgOutbox']>,
  options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: OrgOutboxRead;
  try { result = read({ runsDir: options.runsDir }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.status === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  if (result.status === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  const items = result.events.map((event): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `org-outbox:${event.id}`,
    source: 'org-outbox',
    kind: 'org-membership',
    severity: 'warn',
    blocking: false,
    title: oneLine(`org role ${event.roleId} (${event.tier} ${event.status}) awaits bus delivery`, TITLE_MAX),
    detail: oneLine(`rev ${event.revision} · proposed by ${event.actor} · event ${event.id}`, DETAIL_MAX) || null,
    since: event.at,
    expiresAt: null,
    act: ['phm fleet org-sync --apply', 'phm fleet org-board'],
  }));
  return { report: { state: 'healthy', pending: items.length }, items };
}

function gmailItems(read: typeof readGmailArchivePlanLatest, runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let latest: ReturnType<typeof readGmailArchivePlanLatest> = null;
  try { latest = read(dir); } catch { latest = null; }
  if (latest === null) {
    // A reader that returns null for a file that exists means unreadable or invalid, not absent.
    return { report: { state: existsSync(gmailArchivePlanLatestPath(dir)) ? 'degraded' : 'missing', pending: 0 }, items: [] };
  }
  const items = latest.plans.filter(plan => plan.unread > plan.target).map((plan): Omit<UnifiedInboxItem, 'priority'> => {
    const senders = plan.topSenders.map(s => `${s.sender} (${s.count})`).join(', ');
    return {
      id: `gmail:${plan.inbox}`,
      source: 'gmail',
      kind: 'gmail-over-target',
      severity: plan.target > 0 && plan.unread >= 2 * plan.target ? 'high' : 'warn',
      blocking: false,
      title: oneLine(`${plan.inbox}: ${plan.unread} unread, target ${plan.target}`, TITLE_MAX),
      detail: oneLine(`archive plan proposes ${plan.archiveCount}; top senders: ${senders || 'none'}`, DETAIL_MAX),
      since: plan.at,
      expiresAt: null,
      act: ['phm fleet gmail-archive-plan'],
    };
  });
  return { report: { state: 'healthy', pending: items.length }, items };
}

function linkedInItems(read: typeof readLinkedInDrop, runsDir: string | undefined, now: () => number): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: ReturnType<typeof readLinkedInDrop>;
  try { result = read({ runsDir, now }); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  const items = result.messages.map((m: LinkedInMessage): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `linkedin:${m.id}`,
    source: 'linkedin',
    kind: 'linkedin-message',
    severity: 'info',
    blocking: false,
    title: oneLine(`LinkedIn from ${m.from}: ${m.text}`, TITLE_MAX),
    detail: m.threadUrl ? cap(m.threadUrl, DETAIL_MAX) : null,
    since: m.at,
    expiresAt: null,
    // Replies stay drafts until Mason confirms; nothing is sent from here.
    act: ['phm drafts list --status pending'],
  }));
  return { report: { state: result.sourceState, pending: items.length }, items };
}

/** The request TTL dispatch will apply, resolved read-only: cfg.comms.requestTtlHours with the same 48h fallback `expireStaleRequests` gets. */
function requestTtlMs(): number {
  try { return commsRequestTtlMs(loadConfigReadOnly()); }
  catch { return DEFAULT_REQUEST_TTL_HOURS * 3_600_000; }
}

/** Same shape guard `inbox show` applies to proposal ids before one reaches a command line. */
const PROPOSAL_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

/**
 * Comms questions and approvals still owed an answer — the live request queue
 * behind `phm comms status`. A `sent` question/approval is the single
 * outstanding slot Mason's numbered reply or button tap resolves, so it
 * lists as a blocking warn; a `pending` one is queued behind the slot or the
 * question cooldown and lists as info. Informational `report` requests never
 * await a reply and never list, matching the dispatch split. `since` and
 * `expiresAt` come from the same age-start and TTL rule
 * `expireStaleRequests` applies, so a request about to age out ranks as the
 * deadline it really is. An unreadable store reports 'unavailable'; a
 * missing one 'missing' — never an empty queue passed off as fact.
 */
function requestItems(read: typeof readCommsRequests, now: () => number, ttlOverride?: number): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: CommsRequestsRead;
  try { result = read(); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.status === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  if (result.status === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  // A malformed store row must never take the whole inbox down.
  const candidates = result.requests.filter(r =>
    r !== null && typeof r === 'object' &&
    (r.type === 'question' || r.type === 'approval') && (r.status === 'pending' || r.status === 'sent'));
  if (candidates.length === 0) return { report: { state: 'healthy', pending: 0 }, items: [] };
  const nowMs = now();
  const ttlMs = ttlOverride ?? requestTtlMs();
  const items = candidates.map((r): Omit<UnifiedInboxItem, 'priority'> => {
    const sent = r.status === 'sent';
    const start = commsRequestAgeStartMs(r);
    const timed = Number.isFinite(start);
    const act = ['phm comms status'];
    const proposalId = r.meta?.['proposalId'];
    if (typeof proposalId === 'string' && PROPOSAL_ID.test(proposalId)) act.push(`phm inbox show ${proposalId}`);
    return {
      id: `requests:${r.id}`,
      source: 'requests',
      kind: 'comms-request',
      severity: sent ? 'warn' : 'info',
      // Until Mason answers or it expires, a sent request holds the question slot.
      blocking: sent,
      title: oneLine(r.text, TITLE_MAX) || `comms ${r.type} ${r.id.slice(0, 8)}`,
      detail: cap(`${r.type} · ${r.kind} · ${sent ? 'awaiting reply' : 'queued'}` +
        (r.options.length > 0 ? ` · ${r.options.length} option${r.options.length === 1 ? '' : 's'}` : '') +
        (timed ? ` · waiting ${plainAge(nowMs - start)}` : ''), DETAIL_MAX),
      since: timed ? new Date(start).toISOString() : null,
      expiresAt: timed ? new Date(start + ttlMs).toISOString() : null,
      act,
    };
  });
  return { report: { state: 'healthy', pending: items.length }, items };
}

/**
 * Pending team approvals — access requests and consequential handoffs only
 * an owner/admin can decide — from the same `readTeamApprovals` section
 * `phm approvals` and the desktop Approvals panel project, scoped to
 * DEFAULT_TEAM like the bare command. The requested action is held until
 * `phm team approve|deny` records the decision, so each lists as a blocking
 * warn with the projection's own approve command first and the matching deny
 * command second. The item carries no timestamp, so `since`/`expiresAt` stay
 * null — unknown, never invented. A throwing or refused read reports
 * 'unavailable', never an empty approvals list passed off as fact.
 */
function teamApprovalItems(read: NonNullable<UnifiedInboxOptions['readTeamApprovals']>): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let section: ReturnType<typeof readTeamApprovals>;
  try { section = read(DEFAULT_TEAM); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (section.state !== 'ok') return { report: { state: 'unavailable', pending: null }, items: [] };
  const items = section.items.map((approval: TeamApprovalItem): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `team-approvals:${approval.id}`,
    source: 'team-approvals',
    kind: 'team-approval',
    severity: 'warn',
    // The access request or handoff stays held until an owner/admin decides.
    blocking: true,
    title: oneLine(approval.summary, TITLE_MAX) || `team approval ${approval.id}`,
    detail: oneLine(`from ${approval.requestedBy}${approval.note ? ` · "${approval.note}"` : ''}`, DETAIL_MAX) || null,
    since: null,
    expiresAt: null,
    act: [approval.command, `phm team deny ${approval.id} --team ${DEFAULT_TEAM}`, 'phm approvals'],
  }));
  return { report: { state: 'healthy', pending: items.length }, items };
}

/**
 * Pending inbox proposals — proposed outward actions that never auto-apply —
 * from the same `readPendingProposals` section `phm approvals` and the
 * desktop Approvals panel project. Each lists as info: a review backlog, not
 * an urgent decision. `phm inbox show` reviews first, then approve and
 * reject; a partial capture can be denied but never approved, so its acts
 * drop `approve`. A proposal id that fails the inbox-show shape guard keeps
 * only the bare `phm inbox` list link rather than a command that cannot
 * run. `since` is the proposal's real createdAt — null when it does not
 * parse, never invented; `expiresAt` stays null. An 'ok' read whose coverage
 * was truncated, or an 'unavailable' read that still returned items, reports
 * 'degraded': the items found are real and list while the missing remainder
 * is honestly unknown — never an empty list passed off as fact.
 */
function proposalItems(read: NonNullable<UnifiedInboxOptions['readInboxProposals']>): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let section: ReturnType<typeof readPendingProposals>;
  try { section = read(); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  const items = section.items.map((proposal: ProposalApprovalItem): Omit<UnifiedInboxItem, 'priority'> => {
    const idOk = PROPOSAL_ID.test(proposal.id);
    const act = idOk
      ? [`phm inbox show ${proposal.id}`,
        ...(proposal.partial ? [] : [`phm inbox approve ${proposal.id}`]),
        `phm inbox reject ${proposal.id}`]
      : ['phm inbox'];
    const created = typeof proposal.createdAt === 'string' ? Date.parse(proposal.createdAt) : Number.NaN;
    return {
      id: `proposals:${proposal.id}`,
      source: 'proposals',
      kind: 'inbox-proposal',
      severity: 'info',
      blocking: false,
      title: oneLine(proposal.title, TITLE_MAX) || `inbox proposal ${proposal.id}`,
      detail: oneLine(`${proposal.kind} proposal${proposal.partial ? ' · partial capture' : ''}` +
        (proposal.detail === null ? '' : ` — ${proposal.detail}`), DETAIL_MAX) || null,
      since: Number.isFinite(created) ? proposal.createdAt : null,
      expiresAt: null,
      act,
    };
  });
  const state: UnifiedInboxSourceState = section.state !== 'ok'
    ? (items.length > 0 ? 'degraded' : 'unavailable')
    : section.truncated ? 'degraded' : 'healthy';
  return { report: { state, pending: pendingCount(state, items.length) }, items };
}

/**
 * Slack requests whose local bus append failed — a pending-comms class
 * no other source can see. `readSlackJournal` is the same bounded journal
 * read `phm fleet slack-trace` and `phm channels slack status` project, so
 * this source can never disagree with them: the trace's `bus-failed` outcome
 * is exactly an `ingested` row whose `bus` field is `'failed'` — send
 * receipts only bind reply evidence for the other outcomes, which this
 * source never lists. Such a row is an authenticated, validated Slack event
 * whose bus append never landed: there is no bus envelope for the bus or
 * conversations sources to list, no owner-thread record (`noteUnifiedOwner`
 * runs only on durable ingest) and no claim — the journal is the only
 * durable evidence, so each row lists as a warn with the per-request trace
 * and bridge-status deep links. Posted, duplicate, legacy (`bus` absent)
 * and ignored rows either have a durable envelope another source already
 * covers or cannot be proven pending. Rows carry ids and timestamps only
 * (channel, thread and message ts — the same fields the trace requires
 * before it will emit a row), never text; `since` is the journal receive
 * time and `expiresAt` stays null — the request is lost until re-ingested,
 * never a guessed deadline. Repeated failed ingests of the same Slack
 * message (an outage retrying) collapse to the newest row — one pending
 * thing, one item. Source state is the journal read's own (`ok`, `missing`,
 * `degraded`), never fabricated; a throwing read reports 'unavailable',
 * never an empty list passed off as fact.
 */
function slackItems(read: NonNullable<UnifiedInboxOptions['readSlackJournal']>,
  options: UnifiedInboxOptions, now: () => number): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let journal: SlackJournalRead;
  try {
    journal = read({ ...(options.runsDir !== undefined ? { runsDir: options.runsDir } : {}), limit: 4096 });
  } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  const state: UnifiedInboxSourceState = journal.state === 'ok' ? 'healthy'
    : journal.state === 'missing' ? 'missing' : 'degraded';
  const nowMs = now();
  const latest = new Map<string, SlackObservation>();
  for (const entry of journal.entries) {
    // The same row filter traceSlackRequests applies before it will emit a
    // row: ingested events carrying all three Slack ids, then the failed
    // bus outcome the trace reports as 'bus-failed'.
    if (entry.decision !== 'ingested' || entry.bus !== 'failed') continue;
    if (!entry.channelId || !entry.messageTs || !entry.threadTs) continue;
    const key = `${entry.channelId}:${entry.messageTs}`;
    const prev = latest.get(key);
    if (prev === undefined || entry.at > prev.at) latest.set(key, entry);
  }
  const items = [...latest.values()].map((entry): Omit<UnifiedInboxItem, 'priority'> => {
    const atMs = Date.parse(entry.at);
    const timed = Number.isFinite(atMs);
    return {
      id: `slack:${entry.channelId}:${entry.messageTs}`,
      source: 'slack',
      kind: 'slack-request',
      // A received request that never reached any agent surface is a
      // recorded delivery failure — agent work to investigate, never
      // Mason-blocking.
      severity: 'warn',
      blocking: false,
      title: 'Slack request failed bus ingress',
      detail: oneLine(`channel ${entry.channelId} · thread ${entry.threadTs} · message ${entry.messageTs}` +
        (timed ? ` · waiting ${plainAge(nowMs - atMs)}` : ''), DETAIL_MAX) || null,
      since: timed ? new Date(atMs).toISOString() : null,
      expiresAt: null,
      // The journal already shape-checks these ids on read; re-check before
      // embedding them in a command so a seam or future row shape can never
      // widen the act into something unsafe — fall back to the bare reads.
      act: isSlackChannelId(entry.channelId) && isSlackTs(entry.threadTs) && isSlackTs(entry.messageTs)
        ? [
          `phm fleet slack-trace --channel ${entry.channelId} --thread ${entry.threadTs} --message ${entry.messageTs} --json`,
          'phm channels slack status --json',
        ]
        : ['phm fleet slack-trace --json', 'phm channels slack status --json'],
    };
  });
  return { report: { state, pending: items.length }, items };
}

/**
 * Outbound Slack sends still unconfirmed — send-store receipts the transport
 * journaled as `attempted` and never proved. `readSlackSendReceipts` is the
 * same bounded send-store read `phm channels slack status` counts as
 * `uncertainSends` and `phm fleet slack-trace` binds reply evidence from, so
 * this source can never disagree with them: an `attempted` receipt is a post
 * whose outcome the transport could not prove — the intent row is kept
 * precisely so a later pass reconciles by history scan instead of risking a
 * duplicate post, and until that reconciliation lands the recipient may
 * never have seen the message. Every other surface reports only the count;
 * each unconfirmed send lists here as a warn with its channel/thread
 * coordinates — ids only, never text. Receipts keep no attempt timestamp
 * (the store records delivery intent and an expiry bound, not when the send
 * was first tried), so `since`/`expiresAt` stay null: the send waits until
 * reconciled, never a guessed deadline. Reconciliation is agent work — a
 * bounded `phm channels slack run` pass re-drives the delivery, which scans
 * channel history for the recorded client id and marks the receipt `sent`
 * without reposting — so items stay non-blocking. `sent` receipts are proved
 * deliveries and never list; identical unkeyed seam rows collapse to one
 * item. Source state is the read's own (`ok`, `missing`, `degraded`), never
 * fabricated; a throwing read reports 'unavailable', never an empty list
 * passed off as fact.
 */
function slackSendItems(read: NonNullable<UnifiedInboxOptions['readSlackSends']>): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let sends: SlackSendReceiptRead;
  try { sends = read({}); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  const state: UnifiedInboxSourceState = sends.state === 'ok' ? 'healthy'
    : sends.state === 'missing' ? 'missing' : 'degraded';
  // The reader always sets the store key; a seam row without one still lists
  // under a content hash so indistinguishable unkeyed evidence collapses.
  const attempted = new Map<string, { itemId: string; receipt: SentReceipt }>();
  for (const receipt of sends.receipts) {
    if (receipt.state !== 'attempted') continue;
    const itemId = receipt.key ?? createHash('sha256')
      .update(JSON.stringify([receipt.channel, receipt.thread ?? null, receipt.state])).digest('hex');
    if (!attempted.has(itemId)) attempted.set(itemId, { itemId, receipt });
  }
  const items = [...attempted.values()].map(({ itemId, receipt }): Omit<UnifiedInboxItem, 'priority'> => {
    // The reader shape-checks channel and thread on the way in; re-check
    // before embedding them in a command so a seam or future row shape can
    // never widen the act into something unsafe — fall back to the bare reads.
    const channelOk = isSlackChannelId(receipt.channel);
    const threadOk = receipt.thread !== undefined && isSlackTs(receipt.thread);
    return {
      id: `slack-sends:${itemId}`,
      source: 'slack-sends',
      kind: 'slack-send-unconfirmed',
      // An outbound send whose delivery is unproven may be a reply the
      // recipient never saw — agent work to reconcile, never Mason-blocking.
      severity: 'warn',
      blocking: false,
      title: 'Slack send unconfirmed',
      detail: oneLine(`channel ${receipt.channel}` + (threadOk ? ` · thread ${receipt.thread}` : ''), DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      act: [
        'phm channels slack status --json',
        channelOk
          ? `phm fleet slack-trace --channel ${receipt.channel}${threadOk ? ` --thread ${receipt.thread}` : ''} --json`
          : 'phm fleet slack-trace --json',
        'phm channels slack run --seconds 60 --json',
      ],
    };
  });
  return { report: { state, pending: items.length }, items };
}

/**
 * Leader-thread messages whose Telegram delivery the drain can no longer
 * finish — `failed` after its retries, or `pending` past the 72 h offer
 * window — from `readLeaderThreadUndelivered`, the read-only scan of the
 * same thread log and delivery index `drainLeaderThread` drains (every
 * listing path syncs memos first — a write — so the inbox reads the store
 * directly). A stuck delivery means Mason may never have seen a memo,
 * question, update or reply on his phone, and until now the only surfaces
 * were the comms cycle's one-line outcome for the newest memo and the Verse
 * thread — `phm comms inbox`, the API and `fleet_comms_inbox` had no way to
 * list the backlog. Each lists as a warn naming the message kind and state
 * with a text snippet — the stored text is already scrubbed and `oneLine`
 * re-scrubs — `since` the message's recorded post time and `expiresAt` null:
 * a failed send waits for a decision, never a guessed deadline. Items are
 * agent work — reposting the content through a proven channel or letting the
 * next memo carry it — never Mason-blocking. `missing` is a verified-absent
 * thread; `degraded`/`unavailable` pass the read's own state through, never
 * an empty list passed off as fact; a throwing seam reports 'unavailable'.
 */
function leaderDeliveryItems(read: NonNullable<UnifiedInboxOptions['readLeaderUndelivered']>, now: () => number): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let result: LeaderThreadUndeliveredRead;
  try { result = read({ now: () => now() }); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  const state: UnifiedInboxSourceState = result.status === 'ok' ? 'healthy' : result.status;
  const items = result.items.map((entry): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `leader-delivery:${entry.id}`,
    source: 'leader-delivery',
    kind: 'leader-message-undelivered',
    // A Leader message Mason never got on Telegram is agent work to surface
    // another way — warn, never blocking.
    severity: 'warn',
    blocking: false,
    title: oneLine(`Leader ${entry.kind} Telegram delivery ${entry.telegram === 'failed' ? 'failed' : 'stalled'}`, TITLE_MAX),
    detail: oneLine(
      `${entry.channel} · Telegram ${entry.telegram === 'failed'
        ? `failed after ${entry.attempts} send attempt${entry.attempts === 1 ? '' : 's'}`
        : 'pending past the 72 h drain window — the comms drain no longer offers it'}` +
      ` · "${oneLine(entry.text, 120)}"`,
      DETAIL_MAX) || null,
    since: entry.at,
    expiresAt: null,
    act: [
      'phm channels --json',
      'phm comms cycle',
      'phm comms send-owner --text "<same message text>"',
    ],
  }));
  return { report: { state, pending: pendingCount(state, items.length) }, items };
}

/**
 * The leader network's durable route/digest state — `<runsDir>/leader/
 * network-state.json` — read through `readLeaderNetworkState`, the same
 * bounded anchored read `readRouteReplyFacts` applies, never the locking
 * `pending()` recovery pass. Until now the only surface was
 * `hasPendingLeaderNetwork`'s boolean inside the comms wake: an agent could
 * not tell WHAT the leader owes, and three recorded states had no read at
 * all. Each verified owner request fully ingested for the leader (inbox and
 * bus legs proven, no delivered or attempted reply) lists as a warn
 * `leader-request` — the leader's own pending queue, which the owner-thread
 * awaiting mark cannot see because network replies record to
 * MASON-OUTBOX.md, never the thread store; a reply recorded whose delivery
 * failed non-ambiguously stays in that same pending queue (the network
 * retries it), so the item's detail says "awaiting retry", never
 * "awaiting reply". A leader-bound route missing its
 * inbox append or bus mirror — or any route whose bus publish never landed —
 * lists as `leader-request-incomplete`: the request provably did not reach
 * every store the leader reads, and a non-slack inbox leg is never retried.
 * A reply whose delivery attempt ended ambiguous (`attempted` without
 * `delivered`) lists as `leader-reply-unconfirmed`: `pending()` and `reply()`
 * both exclude it forever — "reconcile before retry" — so the owner may
 * never have seen the answer and nothing else reports it. A digest in the
 * same state lists as `leader-digest-unconfirmed`. Items name channel,
 * routing label, timestamps and job citations only — owner recipient ids
 * and channel refs never leave the reader; request text is scrubbed by
 * `oneLine` like every other source. `missing` is a verified-absent store,
 * `unavailable` any refusal — never an empty backlog passed off as fact.
 */
function leaderNetworkItems(read: NonNullable<UnifiedInboxOptions['readLeaderNetwork']>,
  runsDir: string | undefined): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: LeaderNetworkStateRead;
  try { result = read({ runsDir: dir }); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.status !== 'ok') {
    return { report: { state: result.status === 'missing' ? 'missing' : 'unavailable',
      pending: result.status === 'missing' ? 0 : null }, items: [] };
  }
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  for (const request of result.requests) {
    const via = `via ${request.channel}`;
    const jobIds = jobIdsField(request.jobIds);
    if (request.reply !== null && request.reply.attempted && !request.reply.delivered) {
      items.push({
        id: `leader-network:reply-${request.requestId}`,
        source: 'leader-network',
        kind: 'leader-reply-unconfirmed',
        // The reply may never have reached the owner and the network never
        // retries an ambiguous attempt — agent work to reconcile, never
        // Mason-blocking.
        severity: 'warn',
        blocking: false,
        title: oneLine(`Leader reply delivery unconfirmed ${via}`, TITLE_MAX),
        detail: oneLine(`reply recorded ${iso(request.reply.at)} · delivery outcome unknown — reconcile before retry`, DETAIL_MAX) || null,
        since: iso(request.reply.at),
        expiresAt: null,
        ...jobIds,
        act: ['phm leader inbox --json', 'phm comms thread'],
      });
      continue;
    }
    if (request.to === 'leader' && request.inbox && request.bus &&
        !(request.reply?.delivered ?? false) && !(request.reply?.attempted ?? false)) {
      // `pending()` still offers this route: either no reply was recorded,
      // or one was recorded whose delivery failed non-ambiguously — the
      // network retries that on the next reply pass, so it is pending
      // leader work either way, never an ambiguous send.
      const replyAt = request.reply?.at;
      items.push({
        id: `leader-network:request-${request.requestId}`,
        source: 'leader-network',
        kind: 'leader-request',
        // A verified owner request the leader has not finished answering —
        // the owner is waiting, same warn band the owner-thread source
        // applies.
        severity: 'warn',
        blocking: false,
        title: oneLine(request.text ?? '', TITLE_MAX) || `Leader request ${via} awaiting reply`,
        detail: oneLine(
          `leader network · ${via} · ` +
          (replyAt === undefined ? 'awaiting reply' : `reply recorded ${iso(replyAt)} · delivery incomplete — awaiting retry`) +
          ` · received ${iso(request.receivedAt)}`,
          DETAIL_MAX) || null,
        since: iso(request.receivedAt),
        expiresAt: null,
        ...jobIds,
        act: ['phm leader inbox --json', 'phm comms thread'],
      });
      continue;
    }
    const missingLegs = request.to === 'leader'
      ? [request.inbox ? null : 'inbox append', request.bus ? null : 'bus mirror'].filter((leg): leg is string => leg !== null)
      : request.bus ? [] : ['bus publish'];
    if (missingLegs.length === 0) continue;
    items.push({
      id: `leader-network:incomplete-${request.requestId}`,
      source: 'leader-network',
      kind: 'leader-request-incomplete',
      severity: 'warn',
      blocking: false,
      title: oneLine(`Leader request delivery incomplete ${via}`, TITLE_MAX),
      detail: oneLine(
        `leader network · ${via}` +
        (request.to === 'leader' ? '' : ` · to ${request.to}`) +
        ` · unproven: ${missingLegs.join(', ')} · received ${iso(request.receivedAt)}`,
        DETAIL_MAX) || null,
      since: iso(request.receivedAt),
      expiresAt: null,
      ...jobIds,
      act: ['phm leader inbox --json', 'phm comms thread'],
    });
  }
  for (const digest of result.digests) {
    if (!digest.attempted || digest.sent) continue;
    items.push({
      id: `leader-network:digest-${digest.key}`,
      source: 'leader-network',
      kind: 'leader-digest-unconfirmed',
      // An away-digest whose delivery attempt ended ambiguous is never
      // retried — the owner may never have seen it; agent work, never
      // Mason-blocking.
      severity: 'warn',
      blocking: false,
      title: oneLine(`Leader away-digest delivery unconfirmed via ${digest.channel}`, TITLE_MAX),
      detail: oneLine(
        `leader network · via ${digest.channel}` +
        (digest.day === null ? '' : ` · day ${digest.day}`) +
        ` · recorded ${iso(digest.at)} · delivery outcome unknown — reconcile before retry`,
        DETAIL_MAX) || null,
      since: iso(digest.at),
      expiresAt: null,
      act: ['phm leader inbox --json'],
    });
  }
  return { report: { state: 'healthy', pending: items.length }, items };
}

/**
 * Leader replies to Mason still owed a proven iMessage delivery — the send
 * ledger `<imessageStateDir>/leader-sent.jsonl` `sendLeaderReplies` appends,
 * read through `readLeaderRepliesLedger`'s last-status-per-hash fold (the
 * same fold `readClaimed` applies, so the projection can never disagree with
 * what the next pass does). A `failed` last row lists as warn
 * `leader-reply-failed` — the send provably did not land and the next live
 * `phm imessage replies` pass retries it; a stale `pending` last row lists
 * as warn `leader-reply-orphaned` — the process died between claim and
 * outcome, `readClaimed` counts it as sent forever, and no pass ever retries
 * it. Fresh pending rows may be in flight and never list; `sent`/`baseline`
 * are resolved. Each item names the reply through the bounded outbox read
 * the sender uses — a scrubbed snippet and outbox stamp when the read still
 * holds the text, an honest "not in the current outbox read" when it does
 * not — `since` the first recorded attempt, `expiresAt` null. Agent work —
 * a pass retry or a deliberate re-post — never Mason-blocking. `missing` is
 * a verified-absent ledger, `degraded` a truncated read whose pending is a
 * stated lower bound, `unavailable`/a throwing seam — never an empty list
 * passed off as fact.
 */
async function leaderReplyItems(
  read: NonNullable<UnifiedInboxOptions['readLeaderReplies']>,
  options: UnifiedInboxOptions, now: () => number,
): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  let result: LeaderRepliesLedgerRead;
  try { result = await read({ runsDir: options.runsDir, now: () => now() }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.state === 'missing' || result.state === 'unavailable') {
    return { report: { state: result.state, pending: pendingCount(result.state, 0) }, items: [] };
  }
  const items = result.items.map((entry): Omit<UnifiedInboxItem, 'priority'> => {
    const orphaned = entry.state === 'orphaned';
    const snippet = entry.reply ? oneLine(entry.reply.text, 120) : '';
    const where = entry.reply
      ? `${entry.reply.at !== '' ? ` · outbox ${entry.reply.at}` : ''}`
      : ' · reply text not in the current outbox read';
    return {
      id: `leader-replies:${entry.hash}`,
      source: 'leader-replies',
      kind: orphaned ? 'leader-reply-orphaned' : 'leader-reply-failed',
      // A leader reply Mason never provably received on iMessage is agent
      // work to retry or re-post — warn, never blocking.
      severity: 'warn',
      blocking: false,
      title: orphaned ? 'iMessage leader reply unconfirmed' : 'iMessage leader reply failed',
      detail: oneLine(
        (snippet !== '' ? `"${snippet}"` : 'reply text unresolved') + where +
        (orphaned
          ? ` · claimed ${entry.claimedAt ?? 'at an unrecorded time'} · no outcome ever recorded — the dedupe read counts it as sent, so no pass retries it`
          : ` · failed after ${entry.failedAttempts} recorded send attempt${entry.failedAttempts === 1 ? '' : 's'} · awaiting the next live replies pass`),
        DETAIL_MAX) || null,
      since: entry.since,
      expiresAt: null,
      act: orphaned
        ? ['phm imessage replies --json', 'phm leader replies --json', 'phm comms send-owner --text "<same reply text>"']
        : ['phm imessage replies --json', 'phm leader replies --json'],
    };
  });
  return { report: { state: result.state, pending: pendingCount(result.state, items.length) }, items };
}

/**
 * The advisory coordination ledger's (`fleet.coordination.v1`) whole pending
 * surface — a store no other source reads: bus, mailbox and board cover the
 * agent bus and shared board, while coordination mail, assignments and
 * return intents live only in `~/.ashlr/fleet/coordination.jsonl`, reachable
 * today solely through `phm fleet coordination inbox|board|returns` and the
 * fleet_coordination_* MCP tools. `readFleetCoordinationPending` replays the
 * ledger exactly like `readFleetBoard` but projects all three pending
 * classes atomically and never takes the reaping mutation path, so the read
 * cannot append an expiry row. Live messages list as info
 * `coordination-message` — the body is the mail content, `since`/`expiresAt`
 * the record's own stamps, and the act is the addressed agent's inbox (or
 * the board for `all` broadcasts, which every agent inbox carries). Live
 * assignment proposals list as info `coordination-assignment` — advisory
 * offers (`executionAuthorized:false`) that never spawn work, so they never
 * block; the assignee's inbox is the act. Unpublished RESULT intents — a
 * claim concluded `intended` whose receipt `postFleetMessage` never landed,
 * the `released-unposted` class `returnFleetClaim` reports once — list as
 * warn `coordination-return-unposted`: the claim is already released, so no
 * board, claims or returns read names it, and the intent dies silently at
 * expiry unless the owner-held lease retries `phm fleet coordination
 * return`. The item names claim id, returning agent, receipt stamps and a
 * scrubbed receipt snippet; lease material never enters the projection.
 * `missing` is a verified-absent ledger, `unknown`/a throwing read
 * `unavailable` — never an empty backlog passed off as fact.
 */
function coordinationItems(read: NonNullable<UnifiedInboxOptions['readFleetCoordination']>): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let pending: FleetCoordinationPending;
  try { pending = read(); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (pending.state === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  if (pending.state !== 'known') return { report: { state: 'unavailable', pending: null }, items: [] };
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  for (const message of pending.messages) {
    items.push({
      id: `coordination:message-${message.id}`,
      source: 'coordination',
      kind: 'coordination-message',
      severity: 'info',
      blocking: false,
      title: oneLine(message.body, TITLE_MAX) || `Coordination mail to ${message.to}`,
      detail: oneLine(`from ${message.from} · to ${message.to}`, DETAIL_MAX) || null,
      since: iso(message.at),
      expiresAt: iso(message.expiresAt),
      act: message.to === 'all'
        ? ['phm fleet coordination board --json']
        : [`phm fleet coordination inbox --agent ${message.to} --json`],
    });
  }
  for (const proposal of pending.proposals) {
    items.push({
      id: `coordination:assignment-${proposal.id}`,
      source: 'coordination',
      kind: 'coordination-assignment',
      severity: 'info',
      blocking: false,
      title: oneLine(proposal.task, TITLE_MAX) || `Coordination assignment ${proposal.id}`,
      detail: oneLine(`advisory — no execution authority · ${proposal.repo} · to ${proposal.to}`, DETAIL_MAX) || null,
      since: iso(proposal.at),
      expiresAt: iso(proposal.expiresAt),
      act: [`phm fleet coordination inbox --agent ${proposal.to} --json`],
    });
  }
  for (const ret of pending.returns) {
    items.push({
      id: `coordination:return-${ret.id}`,
      source: 'coordination',
      kind: 'coordination-return-unposted',
      // A recorded RESULT receipt whose publish never landed — agent work to
      // reconcile before the intent expires, never Mason-blocking.
      severity: 'warn',
      blocking: false,
      title: oneLine(`Unposted coordination RESULT · claim ${ret.id}`, TITLE_MAX),
      detail: oneLine(
        `returning agent ${ret.agent} · recorded ${iso(ret.at)} · receipt publish never landed — ` +
        `the claim owner retries \`phm fleet coordination return ${ret.id} --agent ${ret.agent} --lease <lease>\``,
        DETAIL_MAX) || null,
      since: iso(ret.at),
      expiresAt: iso(ret.message.expiresAt),
      act: ['phm fleet coordination board --json'],
    });
  }
  return { report: { state: 'healthy', pending: items.length }, items };
}

/**
 * The claim-store drift verdict's (`fleet.claim-drift.v1`) disagreeing rows —
 * the one claim-correctness surface no other source reads: `agents bus
 * status` reports only the verdict's counts, `phm fleet claim-drift` is a
 * verb an agent must already know to run, and the bus/mailbox/board sources
 * each consult ONE of the two claim stores, so a live lease the other store
 * never recorded — or a pair whose owners disagree — is invisible to every
 * pending view until the lease lapses. `mutateBusWorkClaim` writes the bus
 * claims table and the coordination table one after the other, so a crash
 * or settle failure between the writes leaves them disagreeing: a bus-only
 * row is a lease the coordination overlap check cannot see (a second
 * acquire could double-grant), a coord-only row a `queue:<id>` lease the
 * bus claims journal never recorded, and an owner-mismatch pair the same
 * lease showing two different holders. `readClaimStoreDrift` compares only
 * live rows and never throws; UNKNOWN — a store that could not be read —
 * reports 'unavailable' with a null pending, never an empty verdict passed
 * off as fact (the row arrays are empty by construction whenever a side is
 * unreadable), and VERIFIED with both stores absent is 'missing'
 * (verified-empty). Each row lists as a warn — agent work to reconcile
 * before the lease expires, never Mason-blocking — `since` the claim
 * coordinate's recorded receipt time (null when a coord row's sourceId
 * tail cannot be parsed — unknown stays unknown) and `expiresAt` the
 * lease deadline that ends the disagreement. Items name the envelope id,
 * owner labels, cursor and stamps only — claim keys beyond `queue:<id>`
 * and fencing material never leave the read, and no job citation is
 * provable from a drift row, so `--job` never matches.
 */
function claimDriftItems(read: NonNullable<UnifiedInboxOptions['readClaimDrift']>,
  options: UnifiedInboxOptions): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let drift: ClaimStoreDrift;
  try { drift = read({ root: options.busRoot, now: (options.now ?? Date.now)() }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (drift.state === 'UNKNOWN') return { report: { state: 'unavailable', pending: null }, items: [] };
  // The drift read reports an unparseable coord sourceId tail as the epoch;
  // that is "unknown", not a 1970 appearance time.
  const EPOCH_ISO = '1970-01-01T00:00:00.000Z';
  const sinceOf = (row: ClaimDriftRow): string | null => row.receivedAt === EPOCH_ISO ? null : row.receivedAt;
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  for (const row of drift.busOnly) {
    items.push({
      id: `claim-drift:bus:${row.id}:${row.cursor}:${row.receivedAt}`,
      source: 'claim-drift',
      kind: 'claim-drift-bus',
      // A live lease only the bus claims table recorded — the coordination
      // overlap check cannot see it, so a second acquire could double-grant;
      // agent work to reconcile before the lease lapses, never Mason-blocking.
      severity: 'warn',
      blocking: false,
      title: oneLine(`Claim drift · bus-only lease on ${row.id}`, TITLE_MAX),
      detail: oneLine(`bus claims table holds a live lease coordination does not · owner ${row.owner} · cursor ${row.cursor} · lease until ${row.leaseUntil}`, DETAIL_MAX) || null,
      since: sinceOf(row),
      expiresAt: row.leaseUntil,
      act: ['phm fleet claim-drift --json', `phm agents bus show ${row.id}`],
    });
  }
  for (const row of drift.coordOnly) {
    items.push({
      id: `claim-drift:coord:${row.id}:${row.cursor}:${row.receivedAt}`,
      source: 'claim-drift',
      kind: 'claim-drift-coordination',
      // A live `queue:<id>` lease only the coordination table recorded — the
      // bus claims journal never saw the acquire; agent work, never
      // Mason-blocking.
      severity: 'warn',
      blocking: false,
      title: oneLine(`Claim drift · coordination-only lease on ${row.id}`, TITLE_MAX),
      detail: oneLine(`coordination table holds a live queue:${row.id} lease the bus claims table does not · owner ${row.owner} · lease until ${row.leaseUntil}`, DETAIL_MAX) || null,
      since: sinceOf(row),
      expiresAt: row.leaseUntil,
      act: ['phm fleet claim-drift --json', `phm agents bus claim list --key queue:${row.id}`],
    });
  }
  for (const row of drift.ownerMismatch) {
    items.push({
      id: `claim-drift:owner:${row.id}:${row.cursor}:${row.receivedAt}`,
      source: 'claim-drift',
      kind: 'claim-drift-owner',
      // The same live lease shows two different holders depending which
      // store an agent consults — agent work to reconcile, never
      // Mason-blocking.
      severity: 'warn',
      blocking: false,
      title: oneLine(`Claim drift · owner mismatch on ${row.id}`, TITLE_MAX),
      detail: oneLine(`bus owner ${row.busOwner ?? row.owner} vs coordination owner ${row.coordOwner ?? 'unknown'} · lease until ${row.leaseUntil}`, DETAIL_MAX) || null,
      since: sinceOf(row),
      expiresAt: row.leaseUntil,
      act: ['phm fleet claim-drift --json', `phm agents bus show ${row.id}`, `phm agents bus claim list --key queue:${row.id}`],
    });
  }
  // VERIFIED with both claim stores absent is a verified-empty pair — the
  // same 'missing' state every other never-used store reports.
  const state: UnifiedInboxSourceState =
    drift.state === 'VERIFIED' && drift.bus === 'missing' && drift.coordination === 'missing' ? 'missing' : 'healthy';
  return { report: { state, pending: pendingCount(state, items.length) }, items };
}

/**
 * The outbound send gate every local bus write, claim and send passes
 * through — `localWriteGate`/`localBusHold`'s two inspections: the
 * kill-switch sentinel (`readKillSwitch`) and the comms soft-pause flag
 * (`probePauseState`), the same reads `agents bus status`'s `sendGate`
 * section serves, so the two surfaces can never disagree. Until now the
 * gate was invisible here: pending items kept listing while every write
 * verb refused, and an agent had to already know `agents bus status` to
 * learn why nothing could drain. An engaged kill switch lists as
 * `send-gate-kill`, a set pause flag as `send-gate-pause` — each naming
 * the gate and its verdict; an uninspectable or unsafe gate file lists
 * the same kind one severity band lower, because the send path fails
 * closed and refuses as if engaged while the probe honestly reports
 * unknown rather than calling it a decision someone made. `since` is the
 * pause flag's recorded start — the sentinel keeps no provable time, so
 * kill items and unparseable flags stay null — and `expiresAt` stays
 * null: a gate waits for its release, never a guessed deadline. Both
 * gates clear is a verified-open source with a real zero; either probe's
 * own unknown verdict degrades the source — unknown stays unknown, never
 * an open gate passed off as fact. The reads are total by contract and
 * each keeps its own try, matching the bus-status probe, so one throwing
 * read cannot hide the other's verdict — a throw synthesizes the same
 * 'unknown' verdict the fail-closed send path applies.
 */
function sendGateItems(readKill: NonNullable<UnifiedInboxOptions['readKillSwitch']>,
  probePause: NonNullable<UnifiedInboxOptions['probePause']>): { report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] } {
  let kill: KillSwitchReadResult;
  try { kill = readKill(); }
  catch { kill = { state: 'unknown', sourceState: 'degraded', reason: 'uninspectable', path: '', errorCode: null }; }
  let pause: PauseProbe;
  try { pause = probePause(); }
  catch { pause = { state: 'unknown', since: null, reason: 'could not be checked' }; }
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  if (kill.state !== 'inactive') {
    const engaged = kill.state === 'active';
    items.push({
      id: 'send-gate:kill',
      source: 'send-gate',
      kind: 'send-gate-kill',
      // A positively engaged sentinel halts every claim and send — the
      // same fleet-wide blockage the refused work feed ranks high; an
      // unproven one still refuses but cannot be called a decision.
      severity: engaged ? 'high' : 'warn',
      blocking: false,
      title: engaged ? 'Kill switch engaged — bus writes held' : 'Kill switch state unknown — writes refused',
      detail: oneLine(engaged
        ? 'the kill-switch sentinel is present — claims, sends and every local bus write refuse until it is released'
        : `the sentinel could not be inspected (${kill.reason}) — the send gate fails closed and refuses writes as if engaged`, DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      act: engaged
        ? ['phm fleet resume', 'phm agents bus status --json', 'phm fleet status']
        : ['phm agents bus status --json', 'phm fleet status'],
    });
  }
  if (pause.state !== 'clear') {
    const paused = pause.state === 'paused';
    const sinceMs = paused && pause.since !== null && Number.isFinite(pause.since) ? pause.since : null;
    items.push({
      id: 'send-gate:pause',
      source: 'send-gate',
      kind: 'send-gate-pause',
      severity: paused ? 'high' : 'warn',
      blocking: false,
      title: paused ? 'Comms pause set — bus writes held' : 'Comms pause state unknown — writes refused',
      detail: oneLine(paused
        ? `the comms pause flag is set${sinceMs === null ? '' : ` since ${iso(sinceMs)}`} — claims, sends and every local bus write refuse until it clears`
        : `pause.json could not be inspected (${pause.reason ?? 'unknown'}) — the send gate fails closed and refuses writes as if paused`, DETAIL_MAX) || null,
      since: sinceMs === null ? null : iso(sinceMs),
      expiresAt: null,
      act: ['phm agents bus status --json', 'phm fleet status'],
    });
  }
  const state: UnifiedInboxSourceState =
    kill.state === 'unknown' || pause.state === 'unknown' ? 'degraded' : 'healthy';
  return { report: { state, pending: pendingCount(state, items.length) }, items };
}

/** Compact wait label for a queue job's recorded age: `42s`, `18m`, `5h12m`, `3d4h`. */
const queueWaitLabel = (ageS: number): string => {
  if (ageS < 90) return `${ageS}s`;
  const minutes = Math.floor(ageS / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d${hours % 24}h`;
};

/**
 * READY jobs in the dispatch router queue (`<runsDir>/queue/router-queue.md`)
 * that no recorded LAUNCH in `dispatch-events.log` proves ever started — the
 * same `readStuckQueue` read `phm queue stuck` and the desktop Queue view
 * serve, so this source and those surfaces can never disagree. Until now the
 * dispatch queue's stuck backlog had no inbox surface: work sitting READY
 * while every bus, board, feed and coordination read shows nothing was
 * invisible to the one view an agent checks for work. Each unlaunched READY
 * row lists as a warn `router-queue-job` — agent coordination work, never
 * Mason-blocking — naming the job id (the same label `phm queue` verbs
 * take), `since` the enqueue epoch or first dispatch-event time the wait is
 * measured from and `expiresAt` null: a queued job waits for a lane, never
 * a guessed deadline. `age_s` is whole seconds, so `since` reconstructs the
 * recorded start within a second of rounding; `age: 'unknown'` — neither an
 * enqueue epoch nor a dispatch event — leaves `since` null rather than
 * guessing. The job id is the item's own citation, so `--job` matches. A
 * missing events log degrades the source — every READY row still lists but
 * its launch state is unproven and the detail says so; a missing queue file
 * is 'missing' (verified-empty) and an unreadable one 'unavailable', never
 * an empty queue passed off as fact.
 */
async function routerQueueItems(read: NonNullable<UnifiedInboxOptions['readRouterQueue']>,
  options: UnifiedInboxOptions): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: RouterQueueStuckRead;
  try { result = await read({ runsDir: dir, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.state === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  if (result.state === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  const nowMs = (options.now ?? Date.now)();
  const degraded = result.state === 'degraded';
  const items = result.jobs.map((job): Omit<UnifiedInboxItem, 'priority'> => {
    const ageMs = typeof job.age_s === 'number' && Number.isSafeInteger(job.age_s) && job.age_s >= 0
      ? job.age_s * 1000 : null;
    return {
      id: `router-queue:${job.id}`,
      source: 'router-queue',
      kind: 'router-queue-job',
      severity: 'warn',
      blocking: false,
      title: oneLine(`Router job ${job.id} has no recorded launch`, TITLE_MAX),
      detail: oneLine(`READY in queue/router-queue.md · ${ageMs === null ? 'wait age unknown' : `waiting ${queueWaitLabel(job.age_s!)}`}${degraded ? ' · launch evidence unavailable — may already have launched' : ''}`, DETAIL_MAX) || null,
      since: ageMs === null ? null : iso(nowMs - ageMs),
      expiresAt: null,
      jobIds: [job.id],
      act: ['phm queue stuck', 'phm fleet unfed --json', 'phm queue'],
    };
  });
  return { report: { state: result.state, pending: pendingCount(result.state, items.length) }, items };
}

/** The real router-queue read: `readStuckQueue` on the shared runs dir. An
 * absent `queue/router-queue.md` is 'missing' — verified-empty, no READY rows
 * can exist — while any other read failure is 'unavailable', never an empty
 * queue passed off as fact. A missing `dispatch-events.log` is not a throw:
 * the read reports `eventsAvailable: false` and the source degrades, since
 * every listed job's launch state is then unproven. */
async function readRouterQueueSource(options: { runsDir?: string; now?: () => number }): Promise<RouterQueueStuckRead> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  try {
    const { jobs, eventsAvailable } = await readStuckQueue(dir, options.now?.() ?? Date.now());
    return { state: eventsAvailable ? 'healthy' : 'degraded', jobs };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing' : 'unavailable', jobs: [] };
  }
}

/**
 * Running jobs that are not really running — dispatchd run markers
 * (`queue/run/<job>.line` open, `.fin` absent) whose recorded pid is gone
 * (GHOST) or whose log has been silent past the stuck bound (STUCK) — the
 * same `readStuckJobs`/`jobs.stuck.v1` read `phm jobs stuck` and the
 * `--stuck` pass of `phm fleet stray-stop` serve, so this source and those
 * surfaces can never disagree. Until now a dead or hung job held its
 * lane's running count — every status, vitals and capacity read inflated —
 * while no pending surface named it: the bus, feed, board, queue and
 * channel sources all look at work not yet claimed or refused, never at
 * markers that claim a run which is not happening. Each row lists as a
 * warn `stuck-ghost`/`stuck-job` naming the job id (the same label
 * `phm jobs stuck` prints), `since` the recorded start reconstructed at
 * the report's whole-minute precision (`age_min` floors to minutes, so
 * the reconstructed start can sit up to a minute late; `age_min` null —
 * the marker kept no start — leaves `since` null rather than guessing)
 * and `expiresAt` null: a lying marker waits for stray-stop or a finish,
 * never a guessed deadline. The job id is the item's own citation, so
 * `--job` matches. The read itself never writes: closing a ghost marker
 * or stopping a stuck job is `phm fleet stray-stop --stuck --apply`'s
 * job, which the self-tick also runs.
 */
async function jobsStuckItems(read: NonNullable<UnifiedInboxOptions['readJobsStuck']>,
  options: UnifiedInboxOptions): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: JobsStuckSourceRead;
  try { result = await read({ runsDir: dir, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.state === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  if (result.state === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  const nowMs = (options.now ?? Date.now)();
  const items = result.jobs.map((job): Omit<UnifiedInboxItem, 'priority'> => {
    const ageMin = typeof job.age_min === 'number' && Number.isFinite(job.age_min) && job.age_min >= 0
      ? job.age_min : null;
    const ghost = job.kind === 'ghost';
    return {
      id: `jobs-stuck:${job.job}`,
      source: 'jobs-stuck',
      kind: ghost ? 'stuck-ghost' : 'stuck-job',
      severity: 'warn',
      blocking: false,
      title: oneLine(ghost
        ? `Job ${job.job} counted running but its process is gone`
        : `Job ${job.job} running with a silent log`, TITLE_MAX),
      detail: oneLine(`lane ${job.lane} · ${ageMin === null ? 'age unknown' : `age ${queueWaitLabel(ageMin * 60)}`} · last log ${job.last_log_at ?? 'none'} · ${job.why}`, DETAIL_MAX) || null,
      since: ageMin === null ? null : iso(nowMs - ageMin * 60_000),
      expiresAt: null,
      jobIds: [job.job],
      act: ['phm jobs stuck', 'phm fleet stray-stop --stuck --apply'],
    };
  });
  return { report: { state: result.state, pending: pendingCount(result.state, items.length) }, items };
}

/** The real jobs-stuck read: `readStuckJobs` on the shared runs dir. The
 * read itself never throws — an unlistable marker directory comes back
 * `known:false`, which this maps by probing `queue/run`: verified absent
 * is 'missing' (no job can count as running, so nothing can be stuck),
 * anything else is 'unavailable' — the stuck set is unknown, never an
 * empty list passed off as fact. */
async function readJobsStuckSource(options: { runsDir?: string; now?: () => number }): Promise<JobsStuckSourceRead> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const report: StuckJobsReport = await readStuckJobs({ runsDir: dir, now: options.now });
  if (report.known) return { state: 'healthy', jobs: report.stuck };
  try {
    lstatSync(join(dir, 'queue', 'run'));
    return { state: 'unavailable', jobs: [] };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing' : 'unavailable', jobs: [] };
  }
}

/**
 * PARKED rows in the dispatch ready queue — the same `readFleetQueue`
 * `depDetail` projection `phm fleet queue-parked`, `phm fleet parked` and
 * the autopilot's `stale-parked-deps` gap serve, so this source and those
 * surfaces can never disagree. Each dependency-gated row lists once under
 * its own state: gates still lacking a MERGED outcome list as info
 * `parked-dep-waiting` (queued work correctly waiting on named jobs), a
 * row whose gates ALL merged yet was never unparked lists as warn
 * `parked-dep-stale` (stuck work — the auto-unpark pass should have freed
 * it). `jobIds` carries the parked job's own id plus the gate ids the
 * detail names, so `--job` finds the row under the parked job and under
 * every job it waits on. Every non-dependency parked reason+lane group
 * lists once as info `parked-group` — the same rollup those reads print —
 * with `jobIds` the group's own listed job ids. `since`/`expiresAt` stay
 * null throughout: ready.tsv rows keep no park timestamp and a parked job
 * waits for its gates or an unpark pass, never a guessed deadline; no item
 * is Mason-blocking.
 */
async function queueParkedItems(read: NonNullable<UnifiedInboxOptions['readQueueParked']>,
  options: UnifiedInboxOptions): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: QueueParkedRead;
  try { result = await read({ runsDir: dir, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.state === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  if (result.state === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  const degraded = result.state === 'degraded'
    ? ' · ready.tsv read degraded — the parked set may be incomplete' : '';
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [
    ...result.waiting.map((row): Omit<UnifiedInboxItem, 'priority'> => ({
      id: `queue-parked:${row.job}`,
      source: 'queue-parked',
      kind: 'parked-dep-waiting',
      severity: 'info',
      blocking: false,
      title: oneLine(`Job ${row.job} parked on unmet dependency gates`, TITLE_MAX),
      detail: oneLine(`lane ${row.lane ?? 'unknown'} · waiting on gates ${row.unmet.join(', ')} — no MERGED outcome recorded${degraded}`, DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      ...jobIdsField([row.job, ...row.unmet]),
      act: ['phm fleet queue-parked', 'phm fleet autopilot --once'],
    })),
    ...result.stale.map((row): Omit<UnifiedInboxItem, 'priority'> => ({
      id: `queue-parked:${row.job}`,
      source: 'queue-parked',
      kind: 'parked-dep-stale',
      severity: 'warn',
      blocking: false,
      title: oneLine(`Job ${row.job} parked past merged dependency gates`, TITLE_MAX),
      detail: oneLine(`lane ${row.lane ?? 'unknown'} · all gates MERGED (${row.gates.join(', ')}) yet the row was never unparked — a stale-park signal${degraded}`, DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      ...jobIdsField([row.job, ...row.gates]),
      act: ['phm fleet queue-parked', 'phm fleet autopilot --once'],
    })),
    // Every other parked reason lists once per reason+lane group — the same
    // rollup `phm fleet queue-parked`'s `parked REASON (lane): count [jobs]`
    // lines print — so a BYHAND/HOLD/MERGERATE backlog is visible here too,
    // not only the dependency-gated rows above. `count` is the group's true
    // total while `jobs` is the projection's own eight-id cap, so the detail
    // names the overflow rather than passing the listed ids off as the set.
    ...result.groups.map((group): Omit<UnifiedInboxItem, 'priority'> => ({
      id: `queue-parked:${group.reason}:${group.lane ?? 'unknown'}`,
      source: 'queue-parked',
      kind: 'parked-group',
      severity: 'info',
      blocking: false,
      title: oneLine(`${group.count} job${group.count === 1 ? '' : 's'} parked ${group.reason}`, TITLE_MAX),
      detail: oneLine(`lane ${group.lane ?? 'unknown'} · jobs ${group.jobs.join(', ')}${group.count > group.jobs.length ? ` · +${group.count - group.jobs.length} more` : ''} — parked under a non-dependency reason, never a gate wait or stale park${degraded}`, DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      ...jobIdsField(group.jobs),
      act: ['phm fleet queue-parked', 'phm fleet parked'],
    })),
  ];
  return { report: { state: result.state, pending: pendingCount(result.state, items.length) }, items };
}

/** The real queue-parked read: `readFleetQueue` with `depDetail` on the
 * shared runs dir — the same bounded read `phm fleet queue-parked` and the
 * autopilot's `stale-parked-deps` gap serve. The projection never throws
 * on an absent or unreadable store: `sources.ready` carries the verdict —
 * 'missing' a verified-absent `ready.tsv` (no parked rows can exist),
 * 'degraded' a partial read (the listed rows are a floor) — and any throw
 * is 'unavailable', never an empty queue passed off as fact. */
async function readQueueParkedSource(options: { runsDir?: string; now?: () => number }): Promise<QueueParkedRead> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  try {
    const view: FleetQueueV1 = await readFleetQueue({ runsDir: dir, depDetail: true, now: options.now });
    const ready = view.sources.ready;
    const state: UnifiedInboxSourceState = ready === 'missing' ? 'missing'
      : ready === 'degraded' ? 'degraded' : 'healthy';
    return { state, waiting: view.unmetDeps ?? [], stale: view.metDeps ?? [],
      groups: view.groups.filter((group) => !isDependencyParkedReason(group.reason)) };
  } catch {
    return { state: 'unavailable', waiting: [], stale: [], groups: [] };
  }
}

/** A fix PR stuck this long lists 'high' — the same hour mark the web-ui
 * needs-you strip's urgent band applies to the same rows. */
const STUCK_FIX_HIGH_MINUTES = 60;

/**
 * Guardian FIXUP-MAIN jobs whose published pull request never reached a
 * terminal outcome — the same `findStuckFixes`/`readStuckFixes` fold `phm
 * fleet stuck-fixes`, `phm fleet main-health`, the verse runs-history
 * `stuck-fixes` route and the web-ui needs-you strip serve, over
 * `<runsDir>/metrics/jobs.jsonl`, so this source and those surfaces can
 * never disagree. Until now a fix PR sitting open past the 20-minute
 * terminal-outcome bound had no item-level surface here: the jobs-stuck
 * source reads run markers, the queue sources read ready/router rows, and
 * every bus/feed/board read looks at work not yet claimed — while a
 * guardian fix that published and then stalled was invisible to the one
 * view an agent checks for work. Each stuck row lists once as a
 * `stuck-fix` — warn, 'high' once the PR has been stuck an hour, the
 * same escalation the needs-you strip applies — naming the repo
 * ('unknown repo' when no repo is on record), the PR url and the job
 * id, `since`
 * the recorded publish time and `expiresAt` null: a stuck fix waits for
 * a merge or close decision, never a guessed deadline. The job id is the
 * item's own citation, so `--job` matches. `phm fleet main-health`'s own
 * rule applies — a verified-absent ledger means no fix PR was ever
 * published, so 'missing' (verified-empty); a ledger that exists but
 * cannot be folded is 'unavailable' — the stuck set is unknown, never an
 * empty list passed off as fact.
 */
async function stuckFixItems(read: NonNullable<UnifiedInboxOptions['readStuckFixes']>,
  options: UnifiedInboxOptions): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: StuckFixesSourceRead;
  try { result = await read({ runsDir: dir, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.state === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  if (result.state === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  const items = result.stuck.map((fix): Omit<UnifiedInboxItem, 'priority'> => ({
    id: `stuck-fixes:${fix.job}`,
    source: 'stuck-fixes',
    kind: 'stuck-fix',
    severity: fix.ageMinutes >= STUCK_FIX_HIGH_MINUTES ? 'high' : 'warn',
    blocking: false,
    title: oneLine(`${fix.repo ?? 'unknown repo'} fix PR stuck ${fix.ageMinutes} min`, TITLE_MAX),
    detail: oneLine(`job ${fix.job} · ${fix.prUrl} · no MERGED/CLOSED outcome recorded`, DETAIL_MAX) || null,
    since: fix.publishedAt,
    expiresAt: null,
    jobIds: [fix.job],
    act: ['phm fleet stuck-fixes', 'phm fleet main-health'],
  }));
  return { report: { state: result.state, pending: pendingCount(result.state, items.length) }, items };
}

/** The real stuck-fixes read: `readStuckFixes` on the shared runs dir. The
 * fold itself never throws — an unreadable ledger comes back `known:false`
 * — so existence is probed first, the same convention `jobs-stuck` and
 * `phm fleet main-health` apply: a verified-absent `metrics/jobs.jsonl`
 * means no fix PR was ever published ('missing', verified-empty), while a
 * ledger that exists but cannot be folded is 'unavailable' — the stuck
 * set is unknown, never an empty list passed off as fact. */
async function readStuckFixesSource(options: { runsDir?: string; now?: () => number }): Promise<StuckFixesSourceRead> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  try {
    lstatSync(join(dir, 'metrics', 'jobs.jsonl'));
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing' : 'unavailable', stuck: [] };
  }
  const report = await readStuckFixes({ runsDir: dir, now: options.now });
  return report.known ? { state: 'healthy', stuck: report.stuck } : { state: 'unavailable', stuck: [] };
}

/**
 * Finished work in kept worktrees that never became a pull request — the
 * same `readStrandedWork`/`findStrandedWork` fold `phm fleet stranded`
 * serves, over `<runsDir>/queue/status.json`'s kept list, the
 * `metrics/jobs.jsonl` finish events, each job's `.publish` sidecar and
 * the queue run markers, so this source and that surface can never
 * disagree. Until now finished-but-unshipped work had no item-level
 * surface here: the jobs-stuck source reads open run markers, the queue
 * sources read ready/router rows, the stuck-fixes source reads published
 * fix PRs, and every bus/feed/board read looks at work not yet claimed —
 * while a job that finished with real changes and then stopped short of
 * a PR (a publish abort, a safety-gate stop, an unexplained result) sat
 * invisible in a kept worktree, its diff at risk of being reaped or
 * forgotten. Each unrecovered stranded row lists once as a warn
 * `stranded-worktree` naming the job id, `since` the recorded finish
 * time (null when the ledger kept none — unknown stays unknown) and
 * `expiresAt` null: a stranded job waits for a republish or re-run,
 * never a guessed deadline; the job id is the item's own citation, so
 * `--job` matches. Rows a later job already recovered — or a verify
 * already proved on main — never list: their own next step says there
 * is nothing to do. The kept-list rule `phm fleet stranded` itself
 * reports applies — a verified-absent `queue/status.json` is 'missing'
 * (no kept worktree can be listed, so no finished work can be
 * stranded), a kept list that exists but cannot be read or a throwing
 * read is 'unavailable' — the stranded set is unknown, never an empty
 * list passed off as fact — and a known read with gaps (an unreadable
 * metrics ledger leaves finish times and sizes unknown, so the listed
 * rows are a floor) is 'degraded'.
 */
async function strandedWorkItems(read: NonNullable<UnifiedInboxOptions['readStrandedWork']>,
  options: UnifiedInboxOptions): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: StrandedWorkSourceRead;
  try { result = await read({ runsDir: dir, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.state === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  if (result.state === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  const items = result.items
    .filter((item) => item.recovered_by === null && item.verify !== 'already_on_main')
    .map((item): Omit<UnifiedInboxItem, 'priority'> => {
      const cause = item.cause.replaceAll('_', ' ');
      const size = item.diff_files === null ? 'size unknown'
        : `${item.diff_files} files, ${item.diff_lines === null ? 'lines unknown' : `${item.diff_lines} lines`}`;
      return {
        id: `stranded-work:${item.job}`,
        source: 'stranded-work',
        kind: 'stranded-worktree',
        severity: 'warn',
        blocking: false,
        title: oneLine(`Job ${item.job} finished with changes but no pull request`, TITLE_MAX),
        detail: oneLine(`${item.repo} · ${item.lane} lane · ${cause} · ${size} — ${item.next_step}`, DETAIL_MAX) || null,
        since: item.finished_at,
        expiresAt: null,
        jobIds: [item.job],
        act: item.cause === 'abort_after_push'
          ? ['phm fleet stranded', 'phm fleet republish', 'phm fleet kept-worktrees']
          : ['phm fleet stranded', 'phm fleet kept-worktrees'],
      };
    });
  return { report: { state: result.state, pending: pendingCount(result.state, items.length) }, items };
}

/** The real stranded-work read: `readStrandedWork` on the shared runs
 * dir, its kept-worktree fold mapped onto the unified source states —
 * the same existence probe `jobs-stuck`/`stuck-fixes` apply: a
 * verified-absent `queue/status.json` means no kept worktree can be
 * listed, so no finished work can be stranded ('missing',
 * verified-empty); a status file that exists but whose kept list cannot
 * be read is 'unavailable' — the stranded set is unknown, never an
 * empty list passed off as fact; and a known read carrying gaps — an
 * unreadable metrics ledger leaves finish times and sizes unknown — is
 * 'degraded', the listed rows a floor. The read itself never throws on
 * missing files; a throwing read is 'unavailable' all the same. */
async function readStrandedWorkSource(options: { runsDir?: string; now?: () => number }): Promise<StrandedWorkSourceRead> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  try {
    lstatSync(join(dir, 'queue', 'status.json'));
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'missing' : 'unavailable', items: [] };
  }
  try {
    const report = await readStrandedWork({ runsDir: dir, now: options.now?.() });
    if (!report.known) return { state: 'unavailable', items: [] };
    return { state: report.gaps.length > 0 ? 'degraded' : 'healthy', items: report.items };
  } catch {
    return { state: 'unavailable', items: [] };
  }
}

/** Deep links per dispatch-stuck cause: a lane refusal is fixed by moving
 * the row (`phm queue lane`), a worktree cleanup failure by inspecting the
 * worktrees, and an unrecognised cause by reading the raw event lines —
 * every item still leads with the `phm fleet stuck` diagnostic. */
const dispatchStuckActs = (job: DispatchStuckJob): readonly string[] => {
  if (job.cause === 'lane_refused_size' || job.cause === 'lane_refused_repo') {
    return ['phm fleet stuck', `phm queue lane ${job.job} <lane>`, 'phm queue'];
  }
  if (job.cause === 'worktree_cleanup_failed') return ['phm fleet stuck', 'phm fleet worktrees', 'phm queue'];
  return ['phm fleet stuck', 'phm fleet dispatch-events', 'phm queue'];
};

/**
 * Queued jobs dispatch keeps refusing or failing — the same
 * `findStuckJobs`/`readDispatchStuckJobs` fold `phm fleet stuck` and the
 * `fleet.stuck.v1` row of `phm fleet vitals` serve, over the tail of
 * `dispatch-events.log` plus the ready list's lane attribution, so this
 * source and those surfaces can never disagree. Until now a job the
 * dispatcher could never place — a lane refusing its size or repo every
 * tick, a worktree cleanup that keeps failing — had no item-level surface
 * here: the router-queue source lists only READY rows in
 * `queue/router-queue.md`, the queue-parked source lists only PARKED
 * rows, the jobs-stuck source reads run markers for jobs already
 * launched, and every bus/feed/board read looks at work not yet claimed —
 * while the refused job sat in the queue generating refusal events an
 * agent had to already know to look for. Each stuck row lists once as a
 * warn `dispatch-stuck` naming the job id — the same label `phm fleet
 * stuck` prints — `since` the first recorded refusal or failure (the
 * moment the stuck condition began) and `expiresAt` null: a refused job
 * waits for a lane move or a queue edit, never a guessed deadline; the
 * job id is the item's own citation, so `--job` matches. A degraded
 * ready read still lists every event-proven job — the events log, not
 * the ready list, proves the stuck set — but marks the source 'degraded'
 * and says so in the detail: lane attribution is a floor, never a
 * complete set.
 */
async function dispatchStuckItems(read: NonNullable<UnifiedInboxOptions['readDispatchStuck']>,
  options: UnifiedInboxOptions): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: DispatchStuckSourceRead;
  try { result = await read({ runsDir: dir, now: options.now }); }
  catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  if (result.state === 'missing') return { report: { state: 'missing', pending: 0 }, items: [] };
  if (result.state === 'unavailable') return { report: { state: 'unavailable', pending: null }, items: [] };
  const degraded = result.state === 'degraded'
    ? ' · ready.tsv read degraded — lane may be misattributed' : '';
  const items = result.jobs.map((job): Omit<UnifiedInboxItem, 'priority'> => {
    const refused = job.kind.endsWith('_REFUSED');
    return {
      id: `dispatch-stuck:${job.job}`,
      source: 'dispatch-stuck',
      kind: 'dispatch-stuck',
      severity: 'warn',
      blocking: false,
      title: oneLine(`Job ${job.job} cannot launch — dispatch keeps ${refused ? 'refusing' : 'failing'} it`, TITLE_MAX),
      detail: oneLine(`lane ${job.lane ?? 'unknown'} · waiting ${queueWaitLabel(job.ageSeconds)} · ${job.events} events · ${job.kind}${job.reason ? ` ${job.reason}` : ''} · ${job.action}${degraded}`, DETAIL_MAX) || null,
      since: job.firstSeen,
      expiresAt: null,
      jobIds: [job.job],
      act: dispatchStuckActs(job),
    };
  });
  return { report: { state: result.state, pending: pendingCount(result.state, items.length) }, items };
}

/** The real dispatch-stuck read: `readDispatchStuckJobs` on the shared
 * runs dir — the same bounded read `phm fleet stuck` and the
 * `fleet.stuck.v1` row of `phm fleet vitals` serve. `phm fleet stuck`'s
 * own health rule applies — the event log is the only witness a job is
 * being refused, so a missing or unreadable log leaves the stuck set
 * unknown ('unavailable', pending null), never an empty list passed off
 * as fact; a degraded ready read keeps every event-proven job but marks
 * the source 'degraded' — lane attribution is a floor. */
async function readDispatchStuckSource(options: { runsDir?: string; now?: () => number }): Promise<DispatchStuckSourceRead> {
  const dir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  try {
    const report: DispatchStuckRead = await readDispatchStuckJobs({ runsDir: dir }, options.now?.() ?? Date.now());
    if (report.sources.events !== 'healthy') return { state: 'unavailable', jobs: [] };
    return { state: report.sources.ready === 'degraded' ? 'degraded' : 'healthy', jobs: report.jobs };
  } catch {
    return { state: 'unavailable', jobs: [] };
  }
}

/** Display label and deep links per channel-health leg; telegram's acts differ because its diagnostic is `phm comms health`, not `phm fleet channel-health`. */
const channelHealthPresentation = (channel: string): { label: string; acts: readonly string[] } =>
  channel === 'slack'
    ? { label: 'Slack', acts: ['phm fleet channel-health', 'phm channels slack status', 'phm channels'] }
    : channel === 'imessage'
      ? { label: 'iMessage', acts: ['phm fleet channel-health', 'phm imessage doctor', 'phm channels'] }
      : { label: 'Telegram', acts: ['phm comms health --json', 'phm comms cycle', 'phm channels'] };

/**
 * Owner-channel transport health — the slack and iMessage bridges through
 * `readChannelHealth` (the same projection `phm fleet channel-health` and
 * `phm channels` serve) and the Telegram poller through `telegramEnabled` +
 * `readTelegramHealth` (the same read `phm comms health --json` serves), so
 * this source and those surfaces can never disagree. Until now a dead
 * bridge or a stale poller was invisible here: `phm channels` could show a
 * channel ready while its process was gone, and an agent had to already
 * know which diagnostic to run to learn owner traffic was not flowing. A
 * configured bridge that is BLOCKED lists as `channel-blocked` (high — the
 * transport is provably down), DEGRADED as `channel-degraded` and UNKNOWN as
 * `channel-unknown` (warn — evidence incomplete or a receipt overdue,
 * never called a decision); a channel nobody configured (`BLOCKED` with
 * `configured:false`, the overview's 'not-set-up' row) and a LIVE one never
 * list — setup state is not pending work. The telegram leg lists only when
 * `telegramEnabled` — the same gate the comms cycle's poll applies — as one
 * `channel-degraded` item naming each failed check (a recorded poll error,
 * no poll inside the 7-minute liveness window, no successful poll yet); an
 * unreadable main config or a throwing poll read lists `channel-unknown`
 * instead. `since`/`expiresAt` stay null throughout: health keeps no
 * condition-start time and a degraded channel waits for repair, never a
 * guessed deadline; no item names a job. Either leg's own failure degrades
 * the source — a throwing bridge read proves nothing about
 * slack/imessage while the telegram verdicts still list, and a throwing
 * config or poll read is itself the `channel-unknown` evidence — so
 * 'unavailable' and 'missing' never apply: this is a live probe of running
 * transports, not a store that can be absent.
 */
async function channelHealthItems(options: UnifiedInboxOptions): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const nowMs = (options.now ?? Date.now)();
  const runsDir = options.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const items: Omit<UnifiedInboxItem, 'priority'>[] = [];
  let bridgesFailed = false;
  try {
    const report = await (options.readChannelHealth ?? readChannelHealth)({ now: () => new Date(nowMs), runsDir });
    for (const health of report.channels) {
      // LIVE is verified flow; BLOCKED with configured:false is the
      // overview's 'not-set-up' row — a channel nobody enabled is not
      // pending work. Every other verdict lists, including UNKNOWN with
      // configured:false (the config itself could not be read).
      if (health.state === 'LIVE' || (health.state === 'BLOCKED' && !health.configured)) continue;
      const { label, acts } = channelHealthPresentation(health.channel);
      const kind: UnifiedInboxKind = health.state === 'BLOCKED' ? 'channel-blocked'
        : health.state === 'DEGRADED' ? 'channel-degraded' : 'channel-unknown';
      const reasons = health.missing.map((m) => m.trim()).filter((m) => m !== '');
      // A DEGRADED verdict can arrive with an empty reason list when the
      // only trigger is an inbound unanswered past the reply grace — say
      // so rather than reporting an empty detail.
      if (health.state === 'DEGRADED' && reasons.length === 0) {
        reasons.push(health.unansweredCount > 0
          ? `${health.unansweredCount} inbound request${health.unansweredCount === 1 ? '' : 's'} unanswered past the reply grace`
          : 'a receipt is overdue or a send failed');
      }
      if (health.unansweredCount > 0 && !reasons.some((r) => r.includes('unanswered'))) {
        reasons.push(`${health.unansweredCount} inbound request${health.unansweredCount === 1 ? '' : 's'} unanswered`);
      }
      items.push({
        id: `channel-health:${health.channel}`,
        source: 'channel-health',
        kind,
        severity: health.state === 'BLOCKED' ? 'high' : 'warn',
        blocking: false,
        title: oneLine(`${label} channel ${health.state === 'UNKNOWN' ? 'state unknown' : health.state.toLowerCase()}`, TITLE_MAX),
        detail: oneLine(reasons.join('; ') || 'channel state could not be verified', DETAIL_MAX) || null,
        since: null,
        expiresAt: null,
        act: acts,
      });
    }
  } catch { bridgesFailed = true; }

  let telegramUnknown: string | null = null;
  let cfg: AshlrConfig | null = null;
  try { cfg = (options.readChannelConfig ?? loadConfigReadOnlyStrict)(); }
  catch { telegramUnknown = 'the main config could not be read — the poller health cannot be verified'; }
  // telegramEnabled gates on the same predicate the comms cycle's poll
  // applies; it stays inside its own try so a malformed config shape or a
  // credential-read failure degrades this leg instead of throwing.
  let telegramActive = false;
  if (cfg !== null && telegramUnknown === null) {
    try { telegramActive = telegramEnabled(cfg); }
    catch { telegramUnknown = 'the telegram configuration could not be verified'; }
  }
  if (telegramActive) {
    let poll: ReturnType<typeof readTelegramHealth> | null = null;
    try { poll = (options.readTelegramPoll ?? readTelegramHealth)(cfg!); }
    catch { telegramUnknown = 'the poller health read failed — its state is unknown'; }
    if (poll !== null) {
      const issues: string[] = [];
      const pollError = typeof poll.error === 'string' && poll.error !== '' ? poll.error : null;
      if (pollError !== null) issues.push(`last recorded poll failed (${pollError})`);
      const lastPoll = typeof poll.lastPoll === 'string' ? poll.lastPoll : null;
      if (poll.pollerAlive !== true) {
        issues.push(lastPoll === null
          ? 'no poll recorded — the comms cycle has never run'
          : `no poll within the last 7 minutes (last poll ${lastPoll})`);
      }
      if (typeof poll.lastSuccess !== 'string') issues.push('no successful poll recorded');
      if (issues.length > 0) {
        const { acts } = channelHealthPresentation('telegram');
        items.push({
          id: 'channel-health:telegram',
          source: 'channel-health',
          kind: 'channel-degraded',
          severity: 'warn',
          blocking: false,
          title: 'Telegram channel degraded',
          detail: oneLine(issues.join('; '), DETAIL_MAX) || null,
          since: null,
          expiresAt: null,
          act: acts,
        });
      }
    }
  }
  if (telegramUnknown !== null) {
    const { acts } = channelHealthPresentation('telegram');
    items.push({
      id: 'channel-health:telegram',
      source: 'channel-health',
      kind: 'channel-unknown',
      severity: 'warn',
      blocking: false,
      title: 'Telegram channel state unknown',
      detail: oneLine(telegramUnknown, DETAIL_MAX) || null,
      since: null,
      expiresAt: null,
      act: acts,
    });
  }

  // 'unavailable'/'missing' never apply: every leg resolves to a verdict —
  // a throwing read is itself the degraded/unknown evidence — so a partial
  // failure reports 'degraded' and the surviving verdicts still count.
  const state: UnifiedInboxSourceState = bridgesFailed || telegramUnknown !== null ? 'degraded' : 'healthy';
  return { report: { state, pending: pendingCount(state, items.length) }, items };
}

/**
 * The same drop inbox `runEmailDropOnce` scans, resolved at the shared runs
 * dir: saved email-drop config → `inboxDir` → `readEmailDropInbox`. A missing
 * config or inbox dir is 'missing' (the pass treats an absent inbox as an
 * empty pass too); a config that exists but cannot be used is 'degraded'; a
 * non-directory or unreadable inbox is 'unavailable' — a broken drop folder
 * never reports a healthy empty inbox. An other-writable inbox degrades the
 * state because the pass refuses the whole folder, so the pending files
 * cannot move until permissions are fixed; a paused config (`enabled:false`)
 * leaves the state alone — the listing itself is healthy — and only the item
 * detail says why the backlog sits.
 */
async function readEmailInboxSource(runsDir: string): Promise<EmailInboxSourceRead> {
  const none = (state: UnifiedInboxSourceState): EmailInboxSourceRead =>
    ({ state, pending: 0, since: null, unsafe: false, paused: false });
  let saved: Awaited<ReturnType<typeof readEmailDropConfig>>;
  try { saved = await readEmailDropConfig(runsDir); } catch { return none('unavailable'); }
  if (saved.state === 'missing') return none('missing');
  if (saved.state !== 'ok' || saved.config === undefined) return none('degraded');
  let scan: ReturnType<typeof readEmailDropInbox>;
  try { scan = readEmailDropInbox(saved.config.inboxDir); } catch { return none('unavailable'); }
  if (scan.state === 'missing') return none('missing');
  if (scan.state !== 'ok') return none('unavailable');
  return {
    state: scan.unsafe ? 'degraded' : 'healthy',
    pending: scan.pending,
    since: scan.newestAtMs === null ? null : new Date(scan.newestAtMs).toISOString(),
    unsafe: scan.unsafe,
    paused: saved.config.enabled === false,
  };
}

/**
 * `*.eml` files still sitting in the email-drop inbox — inbound mail the drop
 * pass has not recorded into MASON-INBOX.md, the bus or the owner thread yet.
 * Every recorded-receipt source is blind to them: a stalled `phm comms cycle`,
 * a paused config or an unsafe folder leaves real pending comms invisible, so
 * the whole backlog lists as ONE warn item — filenames never leave the
 * directory (they can carry addresses), the title carries only the real file
 * count, `since` is the newest entry's filesystem mtime (the last arrival on
 * the pending set, never a parsed Date header) and `expiresAt` stays null.
 * Non-`.eml` files and a missing inbox are not pending mail and never list.
 */
async function emailInboxItems(read: NonNullable<UnifiedInboxOptions['readEmailInbox']>,
  runsDir: string | undefined): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: EmailInboxSourceRead;
  try { result = await read({ runsDir: dir }); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  const items: Omit<UnifiedInboxItem, 'priority'>[] = result.pending > 0 ? [{
    // One runs dir carries one email-drop config, so its hash names the backlog slot without echoing the path.
    id: `email-inbox:${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`,
    source: 'email-inbox',
    kind: 'email-inbound',
    severity: 'warn',
    blocking: false,
    title: oneLine(`${result.pending} inbound email file${result.pending === 1 ? '' : 's'} awaiting ingestion`, TITLE_MAX),
    detail: [
      ...(result.unsafe ? ['the inbox folder is writable by other users — the drop pass refuses it until permissions are fixed'] : []),
      ...(result.paused ? ['the saved email-drop config has enabled:false — polling is paused'] : []),
    ].join('; ') || null,
    since: result.since,
    expiresAt: null,
    act: ['phm comms email-cycle', 'phm comms diagnose --json'],
  }] : [];
  return { report: { state: result.state, pending: pendingCount(result.state, items.length) }, items };
}

/**
 * The same read `phm fleet email-outbox` serves, resolved at the shared runs
 * dir: saved email-drop config → outbox dir (`outboxDir`, else the sibling of
 * `inboxDir`, the rule every consumer applies) → availability probe →
 * `readEmailOutbox`. A missing config or outbox is 'missing'; a config that
 * exists but cannot be used is 'degraded' (the gmail plan-file rule); a probe
 * or listing failure is 'unavailable' — a broken drop folder never reports a
 * healthy empty outbox. Rows are stripped to name/state/reason so recipients,
 * subjects, bodies and paths cannot reach the inbox even by accident.
 */
async function readEmailOutboxSource(runsDir: string): Promise<EmailOutboxSourceRead> {
  const none = (state: UnifiedInboxSourceState): EmailOutboxSourceRead => ({ state, entries: [] });
  let saved: Awaited<ReturnType<typeof readEmailDropConfig>>;
  try { saved = await readEmailDropConfig(runsDir); } catch { return none('unavailable'); }
  if (saved.state === 'missing') return none('missing');
  if (saved.state !== 'ok' || saved.config === undefined) return none('degraded');
  const outboxDir = saved.config.outboxDir ?? join(saved.config.inboxDir, '..', 'outbox');
  let availability: ReturnType<typeof probeOutboxDir>;
  try { availability = probeOutboxDir(outboxDir); } catch { return none('unavailable'); }
  if (availability === 'missing') return none('missing');
  if (availability !== 'ok') return none('unavailable');
  let listing: EmailOutboxListing;
  try { listing = readEmailOutbox(outboxDir); } catch { return none('unavailable'); }
  return {
    state: 'healthy',
    entries: listing.entries.map((entry): EmailOutboxSourceEntry => entry.reason === undefined
      ? { name: entry.name, state: entry.state }
      : { name: entry.name, state: entry.state, reason: entry.reason }),
  };
}

/**
 * `.reply.eml` artifacts the email send pass marked `stuck` — interrupted
 * send claims, oversized or unreadable files, malformed drafted rows. A stuck
 * reply is a recorded delivery failure the owner may be waiting on, and today
 * only `phm fleet email-outbox` and `phm comms diagnose` surface it, so each
 * lists as a warn with the fixed reason and a deep link. A stuck artifact is
 * never auto-resent, so items are non-blocking; entries carry no timestamp,
 * so `since`/`expiresAt` stay null — unknown, never invented. Queued, sent
 * and drafted rows are the send pass's own concern and never list here.
 */
async function emailOutboxItems(read: NonNullable<UnifiedInboxOptions['readEmailOutbox']>,
  runsDir: string | undefined): Promise<{ report: UnifiedInboxSourceReport; items: Omit<UnifiedInboxItem, 'priority'>[] }> {
  const dir = runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let result: EmailOutboxSourceRead;
  try { result = await read({ runsDir: dir }); } catch { return { report: { state: 'unavailable', pending: null }, items: [] }; }
  const items = result.entries.filter(entry => entry.state === 'stuck').map((entry): Omit<UnifiedInboxItem, 'priority'> => ({
    // Artifact names are filenames and can carry secret-shaped text; the id stays opaque.
    id: `email-outbox:${createHash('sha256').update(entry.name).digest('hex').slice(0, 16)}`,
    source: 'email-outbox',
    kind: 'email-stuck',
    severity: 'warn',
    blocking: false,
    title: oneLine(`Stuck email reply ${entry.name}`, TITLE_MAX),
    detail: oneLine(`reason ${entry.reason ?? 'unknown'}`, DETAIL_MAX),
    since: null,
    expiresAt: null,
    act: ['phm fleet email-outbox', 'phm comms diagnose --json'],
  }));
  return { report: { state: result.state, pending: pendingCount(result.state, items.length) }, items };
}

/**
 * One read-only pass over every pending comms source. Never throws; a failed
 * source reports its state and the rest still list.
 */
export async function readUnifiedInbox(options: UnifiedInboxOptions = {}): Promise<UnifiedInbox> {
  const now = options.now ?? Date.now;
  const needs = needsYouItems(options.readNeeds ?? readNeedsMason, options.runsDir);
  const needsDelivery = needsYouDeliveryItems(options.readNeedsDeliveries ?? readNeedsMasonReplyDeliveries, options.runsDir);
  const teammateTasks = teammateTaskItems(options.readTeammateTasks ?? readTeammateTaskLedger, options.runsDir, now);
  const teammates = teammateItems(options.readTexts ?? readTeammateTexts, options.runsDir, now, teammateTasks.coveredResultRowids);
  const ownerThread = ownerThreadItems(options.readOwnerAwaiting ?? readOwnerAwaitingReplies, options.runsDir);
  const ownerDelivery = ownerDeliveryItems(options.readOwnerUndelivered ?? readOwnerUndeliveredReplies, options.runsDir);
  const ownerPair = ownerPairItems(options.readOwnerPair ?? ((o) => readOwnerPairPending(o.configDir)),
    fixedOwnerConfigDir(), now);
  const drafts = await draftItems(options.listPendingDrafts ?? listDrafts, options.listCommsDrafts ?? listCommsAgentDrafts, options.runsDir);
  const commsMail = await commsMailItems(options.readCommsInbox ?? readCommsAgentInbox, options.listCommsDrafts ?? listCommsAgentDrafts, options.runsDir);
  const bus = busItems(options);
  const mailbox = mailboxItems(options.readMailbox ?? readMailboxPending, options);
  const board = boardItems(options.readBoard ?? readBusBoardPending, options);
  const workBoard = workBoardItems(options.readWorkBoard ?? listWorkBoard, options, bus.covered);
  const conversations = conversationItems(options.readConversations ?? readAgentConversations, options, now, bus.covered);
  const wakes = wakeItems(options.readWakes ?? ((o) => readAllWakes(undefined, { root: o.root, runsRoot: o.runsRoot, now: o.now })), options);
  const seats = await seatItems(options.readSeatHandoffs ?? planSeatHandoffs, now);
  const peerDispatch = peerDispatchItems(options.readPeerDispatch ?? readPeerDispatchJournal, options);
  const peerInbox = peerInboxItems(options.readPeerInbox ?? readPeerInboxSource, options);
  const sessionHandoffs = sessionHandoffItems(options.readSessionHandoffs ?? ((o) => listSessionHandoffs(
    o.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'), { state: 'open' })), options);
  const orgOutbox = orgOutboxItems(options.readOrgOutbox ?? readOrgPlaneOutbox, options);
  const gmail = gmailItems(options.readGmailPlans ?? readGmailArchivePlanLatest, options.runsDir);
  const linkedin = linkedInItems(options.readLinkedIn ?? readLinkedInDrop, options.runsDir, now);
  const requests = requestItems(options.readRequests ?? readCommsRequests, now, options.requestTtlMs);
  const emailInbox = await emailInboxItems(
    options.readEmailInbox ?? (async (opts: { runsDir?: string }) => readEmailInboxSource(opts.runsDir ?? join(homedir(), '.ashlr-runs'))),
    options.runsDir);
  const emailOutbox = await emailOutboxItems(
    options.readEmailOutbox ?? (async (opts: { runsDir?: string }) => readEmailOutboxSource(opts.runsDir ?? join(homedir(), '.ashlr-runs'))),
    options.runsDir);
  const teamApprovals = teamApprovalItems(options.readTeamApprovals ?? readTeamApprovals);
  const proposals = proposalItems(options.readInboxProposals ?? readPendingProposals);
  const slack = slackItems(options.readSlackJournal ?? readSlackJournal, options, now);
  const slackSends = slackSendItems(options.readSlackSends ?? readSlackSendReceipts);
  const leaderDelivery = leaderDeliveryItems(options.readLeaderUndelivered ?? readLeaderThreadUndelivered, now);
  const leaderNetwork = leaderNetworkItems(options.readLeaderNetwork ?? readLeaderNetworkState, options.runsDir);
  const leaderReplies = await leaderReplyItems(options.readLeaderReplies ?? readLeaderRepliesLedger, options, now);
  const coordination = coordinationItems(options.readFleetCoordination ?? readFleetCoordinationPending);
  const claimDrift = claimDriftItems(options.readClaimDrift ?? readClaimStoreDrift, options);
  const sendGate = sendGateItems(options.readKillSwitch ?? readKillSwitch, options.probePause ?? probePauseState);
  const routerQueue = await routerQueueItems(options.readRouterQueue ?? readRouterQueueSource, options);
  const jobsStuck = await jobsStuckItems(options.readJobsStuck ?? readJobsStuckSource, options);
  const channelHealth = await channelHealthItems(options);
  const queueParked = await queueParkedItems(options.readQueueParked ?? readQueueParkedSource, options);
  const stuckFixes = await stuckFixItems(options.readStuckFixes ?? readStuckFixesSource, options);
  const strandedWork = await strandedWorkItems(options.readStrandedWork ?? readStrandedWorkSource, options);
  const dispatchStuck = await dispatchStuckItems(options.readDispatchStuck ?? readDispatchStuckSource, options);

  const sources: UnifiedInbox['sources'] = {
    'needs-you': needs.report,
    'needs-you-delivery': needsDelivery.report,
    imessage: teammates.report,
    'teammate-tasks': teammateTasks.report,
    'owner-thread': ownerThread.report,
    'owner-delivery': ownerDelivery.report,
    'owner-pair': ownerPair.report,
    drafts: drafts.report,
    'comms-mail': commsMail.report,
    bus: bus.report,
    mailbox: mailbox.report,
    board: board.report,
    'work-board': workBoard.report,
    conversations: conversations.report,
    wakes: wakes.report,
    seats: seats.report,
    'peer-dispatch': peerDispatch.report,
    'peer-inbox': peerInbox.report,
    'session-handoff': sessionHandoffs.report,
    'org-outbox': orgOutbox.report,
    gmail: gmail.report,
    linkedin: linkedin.report,
    requests: requests.report,
    'email-inbox': emailInbox.report,
    'email-outbox': emailOutbox.report,
    'team-approvals': teamApprovals.report,
    proposals: proposals.report,
    slack: slack.report,
    'slack-sends': slackSends.report,
    'leader-delivery': leaderDelivery.report,
    'leader-network': leaderNetwork.report,
    'leader-replies': leaderReplies.report,
    coordination: coordination.report,
    'claim-drift': claimDrift.report,
    'send-gate': sendGate.report,
    'router-queue': routerQueue.report,
    'jobs-stuck': jobsStuck.report,
    'channel-health': channelHealth.report,
    'queue-parked': queueParked.report,
    'stuck-fixes': stuckFixes.report,
    'stranded-work': strandedWork.report,
    'dispatch-stuck': dispatchStuck.report,
  };
  const pending: Omit<UnifiedInboxItem, 'priority'>[] = [...needs.items, ...needsDelivery.items, ...teammates.items, ...teammateTasks.items, ...ownerThread.items, ...ownerDelivery.items, ...ownerPair.items, ...drafts.items, ...commsMail.items, ...bus.items, ...mailbox.items, ...board.items, ...workBoard.items, ...conversations.items, ...wakes.items, ...seats.items, ...peerDispatch.items, ...peerInbox.items, ...sessionHandoffs.items, ...orgOutbox.items, ...gmail.items, ...linkedin.items, ...requests.items, ...emailInbox.items, ...emailOutbox.items, ...teamApprovals.items, ...proposals.items, ...slack.items, ...slackSends.items, ...leaderDelivery.items, ...leaderNetwork.items, ...leaderReplies.items, ...coordination.items, ...claimDrift.items, ...sendGate.items, ...routerQueue.items, ...jobsStuck.items, ...channelHealth.items, ...queueParked.items, ...stuckFixes.items, ...strandedWork.items, ...dispatchStuck.items];
  const nowMs = now();
  const ranked: RankedAttentionItem<UnifiedInboxItem>[] = pending.map((partial) => {
    const item: UnifiedInboxItem = { ...partial, priority: needsYouPriorityHeuristic(partial, nowMs) };
    return { item, priority: item.priority, path: 'fallback', confidence: 1 };
  });
  ranked.sort(compareRanked);
  const requested = options.filter;
  const filter = requested !== undefined &&
    (requested.source !== undefined || requested.kind !== undefined ||
      requested.severity !== undefined ||
      requested.blocking !== undefined || requested.job !== undefined ||
      requested.since !== undefined || requested.before !== undefined ||
      requested.contains !== undefined)
    ? requested : undefined;
  // --contains is a case-insensitive substring over the item's scrubbed
  // title/detail — the text the row actually shows, so a match is always
  // visible in the row it selects. Whitespace collapses the same way the
  // rendered fields' does; a needle that normalizes to nothing imposes no
  // text constraint, the same empty-needle rule `phm messages --contains`
  // applies.
  const containsNeedle = filter?.contains === undefined ? undefined
    : filter.contains.toLowerCase().replace(/\s+/g, ' ').trim();
  const matched = filter === undefined ? ranked : ranked.filter(({ item }) =>
    (filter.source === undefined || item.source === filter.source) &&
    (filter.kind === undefined || item.kind === filter.kind) &&
    (filter.severity === undefined || item.severity === filter.severity) &&
    (filter.blocking === undefined || item.blocking === filter.blocking) &&
    // A job filter keeps only items whose own citation set names the job —
    // an item with no provable job relation stays out of the match.
    (filter.job === undefined || item.jobIds?.includes(filter.job) === true) &&
    // A since filter keeps only items whose recorded appearance time reaches
    // the cutoff — an undated or unparseable item cannot prove it appeared
    // then and stays out of the match rather than being counted as new.
    (filter.since === undefined ||
      (item.since !== null && Date.parse(item.since) >= filter.since)) &&
    // A before filter keeps only items whose recorded appearance time is
    // strictly before the cutoff — the exclusive upper bound pairing with
    // since's inclusive lower bound into one [since, before) window; an
    // item exactly on the cutoff or unable to prove its time stays out.
    (filter.before === undefined ||
      (item.since !== null && Date.parse(item.since) < filter.before)) &&
    (containsNeedle === undefined || containsNeedle === '' ||
      `${item.title} ${item.detail ?? ''}`.toLowerCase().replace(/\s+/g, ' ').includes(containsNeedle)));
  const total = matched.length;
  return {
    v: 1,
    generatedAt: iso(nowMs),
    sources,
    total,
    omitted: Math.max(0, total - UNIFIED_INBOX_MAX_ITEMS),
    ...(filter === undefined ? {} : { filter }),
    items: matched.slice(0, UNIFIED_INBOX_MAX_ITEMS).map(({ item }) => item),
  };
}
