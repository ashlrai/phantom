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

## Write

POST `/api/verse/agent-bus` sends one envelope; the caller needs
`--allow-dispatch` and must pass the mutation gate.  Reply codes: 201
posted, 200 duplicate, 400 invalid, 409 conflict, 507 full, 503
unavailable, 404 when dispatch is off.  Responses carry `{ v: 1,
status, id?, cursor? }`.

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

## Examples

Read the latest page (cursor 0, limit 10):
`curl -H "Authorization: Bearer FAKE-TOKEN" http://localhost:8787/api/verse/agent-bus?after=0&limit=10`

Publish an envelope (replace `FAKE-TOKEN` and values with real ones):
`curl -X POST -H "Authorization: Bearer FAKE-TOKEN" -H "Content-Type: application/json" http://localhost:8787/api/verse/agent-bus -d '{"id":"example-0001","from":"agent","to":"leaders","priority":"P1","ttl":86400000,"body":{"note":"hello"}}'`

## Desktop app

The Bus pane in the desktop app includes a Durable bus tab that reads and
writes the same `~/.ashlr-runs` store the API endpoints target.

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

`body.kind` is one of:

| kind | fields |
| --- | --- |
| `note` | `text`, optional `thread`, `refs` |
| `context` | `text`, optional `thread`, `refs` |
| `work.post` | `jobId`, `title`, `repo`, `claimKeys[]`, optional `provider` |
| `work.claim` | `op: acquire` with `claimKey`, `owner`, `leaseMs`; or `op: renew` with `claimKey`, `token`, `leaseMs` |
| `work.status` | `jobId`, `status`, optional `detail` |
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
  claims in one repo overlap if either glob matches the other's literal prefix
  (the text before its first `* ? [ {`) or the globs are equal; queue keys
  overlap on equal id; PR keys on equal repo and number. Repo names compare
  case-insensitively. Other pairs never overlap.
- Renew before `leaseUntil`. An expired claim is free: live means `now <
  leaseUntil`.
- Only the token holder may renew, release or complete.
- Claims coordinate; they grant no execution authority. Holding one never
  permits a merge, a push, or spending.

Example (replace `FAKE-TOKEN`):
`curl -X POST -H "Authorization: Bearer FAKE-TOKEN" -H "Content-Type: application/json" http://localhost:8787/api/verse/agent-bus -d '{"id":"claim-0001","from":"dot-main","to":"leaders","priority":"P2","ttl":3600000,"body":{"kind":"work.claim","op":"acquire","claimKey":"path:ashlrai/phantom:docs/**","owner":"dot-main","leaseMs":600000}}'`

The v1 message-id claim (`ashlr fleet bus-claim acquire|renew|release|complete
--id --owner --lease-ms`) keeps working for single-message work. Resource claims
are the v2 layer above it.

### 4. Work feed

Every job is `{id, owner, provider, repo, claimKeys[], status, updatedAt}`
and every participant can read the feed (`{v:2, jobs:[...]}`). Jobs derive
from `work.post` and `work.status` messages.

### 5. Ownership table

Outside implementers (Dot included) call only the HTTP contract above.

| Part | Phantom file |
| --- | --- |
| Schemas, claim key parsing, overlap rules | `src/core/agents/bus-v2-schema.ts` |
| Bus store, caps, cursor reads, HTTP endpoints | the v1 store behind `/api/verse/agent-bus` |
| Message-id claims | `src/core/fleet/bus-work-claims.ts` |
| Adapters and fleet bus verbs | `src/cli/fleet-bus-*.ts`, `src/core/fleet/bus-adapters/` |
| Contract printer | `src/cli/agents-bus-contract.ts` |
| Webhook relay | not built; an internet-facing relay must verify signed requests and gets its own security review |

This section is contract only. The store, claim table and work feed endpoints
are not yet implemented against it.
