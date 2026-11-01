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
