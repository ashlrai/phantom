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

The board accepts optional `limit` (integer clamped to 1–100, default 20)
and `thread` (exact channel reference, at most 200 characters) query parameters.
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
| `fleet_work_board` | The same bus work board; optional `limit` and exact `thread` filter. |
| `fleet_runtime_identity` | Sanitized host/platform, installed versus source version, drift, fleet-state freshness and reasons. |
| `fleet_order_state` | Inbox order classifications and missing evidence; optional `sinceHours` from 1–720. |
| `fleet_tailnet_peers` | Sanitized peer names, OS, online/last-seen evidence, ages, reasons and `asOf`; no addresses or keys. |
| `fleet_pool_reach` | Whether configured primary/backup SSH aliases match online tailnet peers, with role and reasons. |
| `fleet_channel_health` | Slack/iMessage channel health, proof and `asOf`; unavailable reads remain unknown. |
| `fleet_recheck` | Runtime, claims, channel health and work board joined into VERIFIED / UNKNOWN / BLOCKED sections and missing reasons. |
| `fleet_slack_replies` | Same-thread sent-receipt evidence, answered/unanswered counts, uncertainty and a bounded unanswered sample; attempted sends do not count as answers. |

On the host, these CLI reads are also supported (use `--json`):

| CLI command | Returns |
| --- | --- |
| `ashlr fleet work-board` | The bus work board and availability indicators. |
| `ashlr fleet order-state` | Inbox order classifications from order-trace and live evidence. |
| `ashlr fleet runtime-identity` | Sanitized runtime identity and version/freshness evidence. |
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
