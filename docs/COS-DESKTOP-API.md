# Chief-of-staff desktop API

Local Hub routes that let the desktop app queue a chief-of-staff task, read its
status, list drafted replies and approve one. Intake itself is described in
[COS.md](COS.md). Implementation: `src/core/verse/fleet-cos-api.ts`.

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

## GET /api/verse/fleet/cos/drafts?limit=N

Every reply draft under `<runsDir>/cos/`, newest first by draft file mtime
(`listCosDrafts` in `src/core/cos/drafts.ts`, read-only). `limit` is an
integer 1..200, default 50; anything else is 400 `VERSE_INVALID`.

200 `{ v: 1, drafts, malformed, withheld }`. Each draft is
`{ id, channel, text, digest, delivery, draftedAt }`: `digest` is the wire
digest that `approve` accepts, `delivery` is `'pending'`, `'sending'`, `'sent'`
or `'uncertain'` (an unreadable claim file reads as `uncertain`, never
`pending`), and `draftedAt` is ISO. Sender and thread ids are never returned.
`malformed` counts draft-named files that fail the draft shape; `withheld`
counts drafts in the page whose text fails the projection guard (a private
path) and were dropped rather than echoed. 503 `COS_UNAVAILABLE`.

## POST /api/verse/fleet/cos/approve

Body exactly `{ id, digest }` with the wire digest from status or drafts.
Approval is desktop-only: a request carrying `x-ashlr-channel: mobile` is 403
`{ code: 'COS_APPROVE_DESKTOP_ONLY' }` after the mutation gate. The route never
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
| 403 | `COS_APPROVE_DESKTOP_ONLY` |
| 404 | `COS_UNKNOWN` |
| 409 | `COS_APPROVAL_STALE` (no draft, or digest is not the current draft's) |
| 409 | `COS_ALREADY_CLAIMED` (a delivery was already claimed; never retried) |
| 502 | `COS_DELIVERY_UNCERTAIN` (transport failed; status shows `uncertain`) |
| 503 | `COS_UNAVAILABLE` |
