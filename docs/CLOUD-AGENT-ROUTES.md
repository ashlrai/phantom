# Cloud-independent agent claim and return routes

An off-host agent can read the host's work board and record a result through
the reachable Verse server. Claiming work requires a shell on that host.
These routes do not depend on a particular cloud agent provider.

## Read state

All reads are evidence projections; they grant no execution or merge authority.
HTTP GETs use the server's existing read-session boundary.

| HTTP method and path | Returns |
| --- | --- |
| GET `/api/verse/fleet/work-board` | Recent durable bus requests, newest first, with state, named claim owner, claim receipt, evidence source, missing evidence and `asOf`; no message bodies. |
| GET `/api/verse/fleet/work-board/orders` | Inbox order states with sanitized owner job/lane, PR, missing evidence, `asOf`, and trace/live/lane availability; no order bodies. |

The board accepts optional `limit` (integer clamped to 1–100, default 20),
`thread` (exact channel reference, at most 200 characters) and `state`
(one of RECEIVED, ASSIGNED, RUNNING, BLOCKED, VERIFIED — the response then
also reports `state` and `matched`, the true filtered total across the whole
settled scan before the display cap) query parameters.
It reports `inbox`, `claims` and `truncated`; unavailable evidence is not an
empty healthy board. The orders GET accepts `since` (integer hours, 1–720),
returns at most 20 orders, and bounds each evidence read to eight seconds.

The isolated fleet MCP server is read-only by design: its module header says
"no gateway discovery, forwarding, or mutation tools." Tools read the
server-owned state; callers cannot select a root, path or working directory.
An MCP server running on another computer reads that computer's state,
not automatically the host's state.

| MCP tool | Returns |
| --- | --- |
| `fleet_work_feed` | The bus v2 work feed — announced jobs with status, provider, tier, claim-key hold coverage and the same filter set as `phm fleet work-feed`; `matched`/`omitted` report honest truncation under `limit`. |
| `fleet_agent_inbox` | One agent's addressed bus inbox — the same readAgentInbox projection as `phm agents bus inbox`: delivery kinds, sender/channel/job filters, live held/holder and job feed-state annotations; `agent` is required, `after`/`limit` page by cursor and `matched` reports the true filtered total. |
| `fleet_agent_work` | One agent's pending-work digest — the same readBusWorkMineWithSeats projection as `phm agents bus work mine`: claims joined to blocked feed jobs, open/announced jobs, next claimables and handoffs, waiting/awaiting/blocked threads, wakes, inbox page, legacy mailbox, board digest, channels and seat handoffs, each section with its own honest read state; `agent` is required, `job`/`since`/`before`/`contains` apply the CLI's shared filters. |
| `fleet_agent_wakes` | One agent's wake hints — the same readAgentWakes projection as `phm agents bus wakes`: per-hint live message referents with held/holder and job feed-state evidence, claim-holder `wh-…` citation re-derivation, `scope` identity-or-label honesty and queue-tail `matched`/`truncated`; `agent` is required and `since`/`job`/`from`/`excludeFrom`/`priority`/`contains` apply the CLI's shared filters. |
| `fleet_agent_messages` | The fleet-wide agent-to-agent message timeline — the same readAgentMessages projection as `phm messages` and the agent-bus messages HTTP read: classified kind, resolved from/to, conversation, job/pr links and jobState feed evidence per row; every filter is optional (`since`/`before`/`agent`/`with`/`kind`/`priority`/`job`/`thread`/`channel`/`contains`/`from`/`excludeFrom`/`inReplyTo`/`limit`) and `source`/`matched`/`skipped` keep store honesty. |
| `fleet_agent_channels` | The agent-bus channel roster — the same listBusChannels projection as `phm agents bus channel list [--agent]`: every registry channel's name, creator, creation time and member handles, or only the channels one resolved identity belongs to; `agent` is optional and an unregistered ref answers `unknown-agent`, `source` keeps missing-vs-unreadable honest. |
| `fleet_agent_identity` | One agent's bus identity card — the same busAgentView projection as `phm agents bus id show <ref>`: the canonical `agt_` id, handle, display name, aliases and runtimes a ref resolves to, plus its `agent:<handle>` address and member-channel names; `agent` is required (the shared server has no per-caller `PHM_AGENT_ID`, so the self view never runs) and `unknown`/`invalid`/`unavailable` pass through untouched — never a guessed match. |
| `fleet_agent_conversations` | The shared agent-to-agent conversation threads — the same readAgentConversations projection as `phm agents conversations` and the agent-conversations HTTP read: reply-chain threads with participants, scrubbed subject, state (waiting/answered/blocked/done), waiting detail, job links and member messages; every filter is optional (`agent`/`waiting`/`blocked`/`state`/`job`/`waitingOn`/`since`/`before`/`contains`/`inReplyTo`/`channel`/`priority`/`from`/`excludeFrom`/`limit`) and `source`/`matched`/`waiting`/`skipped` keep store honesty — an unreadable store or registry leaves the counts null, never an invented empty list. |
| `fleet_bus_channel` | One agent-bus channel transcript — the same readAgentChannel projection as `phm agents bus channel read`: presence-free room posts with topic, sender handle and live held/holder plus job feed-state annotations; `channel` is required, `topic`/`from`/`excludeFrom`/`thread`/`priority`/`job`/`since`/`contains` apply the CLI's shared filters, `after`/`limit` page by cursor and `matched` reports the true filtered total. |
| `fleet_bus_show` | One retained bus envelope by wire id — the same readBusEnvelopeById projection as `phm agents bus show <id>`: the citation resolver for the ids every other bus read emits, with live receipt, resolved sender handle, tri-state held/holder evidence, job feed state and `wh-…` wake-hint resolution; `id` is required and every lookup status passes through untouched. |
| `fleet_bus_thread` | One reply thread's retained live context — the same readBusThread projection as `ashlr fleet bus-thread --id <id>`: the root receipt plus every live envelope whose own `inReplyTo` field transitively cites it, including the kindless replies the classified projections never group; `id` is required, `rootFound`/`complete`/`sourceFailure` keep miss-versus-unreadable honest. |
| `fleet_bus_status` | The unified agent-bus health probe — the same readUnifiedBusStatus projection as `phm agents bus status`: per-section store states for every bus dependency plus the `sendGate` open/blocked/unknown verdict; takes no arguments and every lookup status passes through untouched. |
| `fleet_bus_claims` | The live coordination claims — the same listBusClaims projection as `phm agents bus claim list`: `key`/`owner`/`origin`/`jobs` apply the CLI's shared filters and `source` keeps missing verified-empty versus unavailable honest; read-only, no caller roots, never acquires or releases. |
| `fleet_bus_board` | The shared task board's fleet-wide pending digest — the same readBusBoardPending/BusBoard.pendingAll read `phm comms inbox`'s board source projects: every unacknowledged delivery and every task whose observed hold is not `held`, with `job`/`contains`/`since` the same filters the `work mine` board section shares; `source` keeps missing verified-empty versus unavailable honest; read-only, no caller roots, never acknowledges or claims. |
| `fleet_seat_handoffs` | The fleet-wide bot-seat handoff plan — the same planSeatHandoffs projection as `phm bots handoffs`: every roster seat's projected lifecycle state, handoff eligibility and pending (unjournaled) handoff records; takes no arguments, `apply` stays false, and an unreadable plan reports `unavailable`, never an invented empty roster. |
| `fleet_work_board` | The same bus work board; optional `limit` and exact `thread` filter. |
| `fleet_coordination_claims` | Read-only fresh host advisory coordination claims, newest first. Reading a claim never creates one. |
| `fleet_claim_execution` | Read-only sanitized evidence of which live advisory claims have started executing. Grants no claim authority. |
| `fleet_claim_notices` | Read-only Slack claim-notice evidence: bound threads, sent bus notes and a dry-run plan of pending notices. Authority none: it never sends, ledgers or writes. |
| `fleet_runtime_identity` | Sanitized host/platform, installed versus source version, drift, fleet-state freshness and reasons. |
| `fleet_review_pick` | Read-only unowned review task route, also available as `ashlr fleet review-pick`: repository, PR/head and current owner; unavailable ownership evidence withholds the pick. Grants no claim. |
| `fleet_order_state` | Inbox order classifications and missing evidence; optional `sinceHours` from 1–720. |
| `fleet_tailnet_peers` | Sanitized peer names, OS, online/last-seen evidence, ages, reasons and `asOf`; no addresses or keys. |
| `fleet_pool_reach` | Whether configured primary/backup SSH aliases match online tailnet peers, with role and reasons. |
| `fleet_channel_health` | Slack/iMessage channel health, proof and `asOf`; unavailable reads remain unknown. |
| `fleet_recheck` | Runtime, claims, channel health and work board joined into VERIFIED / UNKNOWN / BLOCKED sections and missing reasons. |
| `fleet_bridge_check` | One READY or BLOCKED verdict on whether the live runtime, the claims ledger and the peer ledger all read cleanly; `missing[]` names what did not. Reachability only. |
| `fleet_peer_ledger` | Peer bus budget metadata: sends left per pair, row capacity and origins near the hop cap. Optional exact pair lookup; grants no send authority. |
| `fleet_slack_replies` | Same-thread sent-receipt evidence, answered/unanswered counts, uncertainty and a bounded unanswered sample; attempted sends do not count as answers. |

On the host, these CLI reads are also supported (use `--json`):

| CLI command | Returns |
| --- | --- |
| `ashlr fleet work-board` | The bus work board and availability indicators. |
| `ashlr fleet order-state` | Inbox order classifications from order-trace and live evidence. |
| `ashlr fleet runtime-identity` | Sanitized runtime identity and version/freshness evidence. |
| `ashlr fleet runtime` | Runtime identity plus coordination ledger state (active claims, newest return age) in one sanitized snapshot with one `asOf`. |
| `ashlr fleet bridge-check` | The same READY or BLOCKED reachability verdict (`--json`); exits 0 when READY, 3 when BLOCKED. |
| `ashlr fleet peer-ledger` | Peer bus rate-limit, capacity and hop budget (`--json`, or `--from-agent` with `--target` for one exact pair). |
| `ashlr fleet tailnet-peers` | Sanitized tailnet peer evidence. |
| `ashlr fleet pool-reach` | Primary/backup alias-to-peer reachability evidence. |
| `ashlr fleet coordination board` | The separate local advisory coordination ledger: claims, messages, proposals and expired-claim count. |

## Record a result

POST `/api/verse/fleet/work-board/result` accepts a JSON object containing
`requestId`, `replyId` and `result`, with no other top-level fields.
`result` must be exactly one of `{pr, head}`, `{tests}`, `{artifact}` or
`{blocked}`. A PR is a positive integer with a nonempty head; tests and
artifact are nonempty text. A blocked dependency is nonempty, at most 200
characters, and cannot be the word `unknown`.

The V1 gate in `verse-api.ts` runs before the route: dispatch must be enabled
or it returns 404. Supply the mutation token through the `x-ashlr-token`
header and use `Content-Type: application/json`. A missing/invalid token
returns 401; a non-JSON content type returns 415. No token value belongs in
this document, an example, or a result receipt.

Example body for an existing request (all example IDs are fictitious):

```json
{"requestId":"req-example-1","replyId":"reply-example-1","result":{"blocked":"Host owner must claim this work"}}
```

The result handler returns 200 for posted or duplicate, 400 for invalid input,
404 for a missing/expired request, 409 for a reply ID with a different body,
503 for other transport refusals, and 413 for a body over 16 KiB.
Retry with the same explicit reply ID and body to preserve idempotency.

The host CLI posts the same evidence-shaped reply:

```sh
ashlr fleet work-result --request-id req-example-1 --reply-id reply-example-1 --blocked "Host owner must claim this work" --json
```

Use exactly one form: `--pr` with `--head`, `--tests`, `--artifact`, or
`--blocked`. The CLI's optional `--root` selects a local store; it does not
connect to a remote host. The HTTP route uses the host's default fleet store.

The HTTP module header states:
> A result receipt is evidence, not authority: it does not complete or release a claim, and routing labels do not authenticate the responder.

## Claim work

There is no HTTP or MCP claim route.
Claims are host-local through `ashlr fleet coordination claim`.
This is an advisory ledger; a lease does not authorize execution or spawn work.
It is separate from the durable bus claim evidence shown by the work board;
creating a coordination claim does not itself assign a bus request.

`ashlr fleet coordination release` and `ashlr fleet coordination handoff`
require the owner agent and private lease. Keep the lease from claim/handoff
private: it fences release and later handoffs. Never put it in a result.

Return a claim with exactly one result form: `--pr` with `--head`, `--tests`,
`--artifact`, or `--blocked`. It releases the claim only with the owner's lease
and posts a `return-<claim-id>` RESULT message to all. A retry after success
reports `already-returned`. If the outcome is `released-unposted`, the claim
was released but the receipt was not posted; report that, not VERIFIED. The
return is evidence and does not merge, verify or close anything.

```sh
ashlr fleet coordination return claim-example --agent agent-example --lease <lease> --pr 42 --head abc1234 --json
```

An off-host agent without a shell on the host can read the board and record
results, but cannot claim. It must ask the host owner and report BLOCKED
with the specific host-claim dependency instead of acting as if it holds a
claim. Use the result route above when the request exists; a missing request
must be reported as unavailable, not treated as a successful receipt.

## Status words

The bus work board uses `classifyWorkItem` via `work-board.ts`:

| State | Required structured evidence |
| --- | --- |
| RECEIVED | No higher state is proven; named owner or durable claim receipt is missing. |
| ASSIGNED | Both named owner and durable claim receipt exist, with no higher state proven. |
| RUNNING | Running source and timestamp are present, no older than 30 minutes and no more than five minutes in the future. |
| BLOCKED | A named dependency other than `unknown`, with source and valid timestamp. |
| VERIFIED | PR plus head, tests, or artifact, with source and valid timestamp. This is recorded evidence, not independent verification or claim completion. |

Precedence is VERIFIED, BLOCKED, RUNNING, ASSIGNED, then RECEIVED.
Free text such as “routed” or “dispatched” proves none of these states.
Queued order owner hints are not claims. Unavailable claims mean ownership
is unknown, not absent; use the availability and missing-evidence fields.

## Reaching the host

The Verse server must be reachable at `<host>` through an existing authorized
Tailscale or remote gateway route, with the existing read session and mutation
credentials supplied through their supported boundaries. Network reachability
alone grants no claim authority. A second Mac's local CLI is not the host CLI.
This document changes no network or security settings and provisions no access.
