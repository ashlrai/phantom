# Chief-of-staff desktop API

Local Hub routes that let the desktop app queue a chief-of-staff task, list
recent tasks, read a task's status and approve the drafted reply. Intake
itself is described in [COS.md](COS.md). Implementation:
`src/core/verse/fleet-cos-api.ts`.

All routes require `ctx.allowDispatch` (404 otherwise). `POST` routes also
require the mutation token and a JSON content type (`passesMutationGate`: 401
without the token, 415 for a wrong content type). The remote gateway does not
allow any of these routes; `approve` is local-only.

Identity is server-side: the channel is always `desktop` and the sender is the
fixed id `verse-cos-operator`. Nothing in a request body is identity. A bare
64-hex value is redacted by the response sanitizer, so digests on the wire are
`sha256:` plus the first 24 hex characters of the draft digest.

## POST /api/verse/fleet/cos/ask

Body exactly `{ "text": string }`, trimmed, 1..16000 characters, no other keys.
The text is appended to `MASON-INBOX.md` (source `Phantom desktop task`) and a
READY `cos-*` job is queued.

| Status | Body |
| --- | --- |
| 201 | `{ v: 1, id, ack, status: 'queued', duplicate: false }` |
| 200 | same with `duplicate: true` and the original `id` (a repost queues nothing) |
| 400 | `{ code: 'VERSE_INVALID' }` |
| 422 | `{ code: 'COS_REFUSED', reason }` (for example secret-shaped text) |
| 503 | `{ code: 'COS_UNAVAILABLE' }` |

`id` is `cos-` plus 32 hex characters. `ack` is the shared channel ack text.

## GET /api/verse/fleet/cos/status?id=cos-<32 hex>

200 `{ v: 1, id, jobStatus, channel, draft, delivery, needsYou }` where `draft`
is `null` or `{ text, digest }`, `delivery` is `null`, `'sending'`, `'sent'` or
`'uncertain'`, and `needsYou` is true while a draft awaits approval. Sender and
thread ids are never returned. 400 `VERSE_INVALID` (bad id), 404
`{ code: 'COS_UNKNOWN' }`, 503 `COS_UNAVAILABLE`.

## GET /api/verse/fleet/cos/list?limit=<1..50>

Read-only, like `status`: no mutation token. 200 `{ v: 1, tasks: [...] }` with
recent intake jobs newest first, at most `limit` (default 20, maximum 50).
Each task is `{ id, jobStatus, channel, needsYou, delivery, hasDraft, request
}` where `delivery` is `null`, `'sending'`, `'sent'` or `'uncertain'`,
`needsYou` is true while a draft awaits approval, `hasDraft` reports whether a
reply draft exists, and `request` is the task text scrubbed, on one line and
at most 140 characters (empty when it carries a private path). Sender and
thread ids, draft text and digests are never returned. 400 `VERSE_INVALID`
(bad `limit`), 503 `COS_UNAVAILABLE` (queue unreadable).

## POST /api/verse/fleet/cos/approve

Body exactly `{ id, digest }` with the wire digest from status. The route never
accepts reply text: approval binds to the stored draft, and the full digest is
passed to the transport for the draft's origin channel.

| Origin | Transport |
| --- | --- |
| telegram | `deliverTelegramCosResult` |
| email | `deliverEmailCosResult` (outbox from the saved email-drop config) |
| desktop, cli | claim only; the reply is already shown on the desktop |
| mobile, page | 422 `{ code: 'COS_NO_TRANSPORT', channel }` (email with no outbox is also this) |

| Status | Body |
| --- | --- |
| 200 | `{ v: 1, id, delivery: 'sent' }` |
| 400 | `VERSE_INVALID` |
| 404 | `COS_UNKNOWN` |
| 409 | `COS_APPROVAL_STALE` (no draft, or digest is not the current draft's) |
| 409 | `COS_ALREADY_CLAIMED` (a delivery was already claimed; never retried) |
| 502 | `COS_DELIVERY_UNCERTAIN` (transport failed; status shows `uncertain`) |
| 503 | `COS_UNAVAILABLE` |
