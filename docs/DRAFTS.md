# Drafts

Mail to anyone other than you waits for your approval. Replies to your own
verified email address still go out directly.

## What happens

1. The email outbox finds a `*.reply.eml` addressed to one person who is not on
   your allowlist.
2. It writes a pending draft to `~/.ashlr-runs/drafts/drafts.jsonl` (mode 0600)
   and moves the file to `outbox/drafted/`. Nothing is sent.
3. The draft shows up as a needs-you item with Approve and Reject.
4. You read it with `phm drafts show` and decide.

Approve records your decision. It does not send. Turning an approved draft into
a send is a separate, security-reviewed step, so until that lands approving a
draft never makes an email leave the machine.

Mail with no recipient or several recipients is refused and stays in the outbox.
Text that looks like a secret is refused and never written to the store. Keep
credentials in Phantom Secrets and refer to them by binding name only.

## Commands

Every command takes `--json`.

```sh
phm drafts list --json
phm drafts list --status pending --json
phm drafts show d-0123456789abcdef --json
phm drafts approve d-0123456789abcdef --digest 0a1b2c3d --json
phm drafts reject d-0123456789abcdef --json
```

- `list` shows metadata only (no body). `--status` is `pending`, `approved` or
  `rejected`.
- `show` prints the full draft including the body and its digest.
- `approve --digest <prefix>` binds your approval to the text you read. Use at
  least 8 characters of the digest from `show`. A mismatch is refused.
- A decided draft cannot be changed. Exit codes: 0 ok, 1 not found or already
  decided, 2 bad usage.

## Record format

One JSON object per line. Each decision appends a new snapshot and the last line
for an id wins. A line that is malformed, altered (digest mismatch) or
secret-shaped is ignored.

```json
{"id":"d-0123456789abcdef","status":"pending","channel":"email","to":"client@example.com","subject":"Quote","body":"...","source":"a.reply.eml","digest":"<sha256>","createdAt":"2026-11-04T12:00:00.000Z"}
```

The id comes from the source file name and the text, so a retried pass never
creates a second draft for the same message.

## For developers

- Store, approve and reject, and the needs-you producer: `src/core/cos/drafts.ts`.
- Routing: `sendEmailOutbox({ draftsRunsDir })` in `src/core/comms/email-outbox.ts`.
  Without `draftsRunsDir` a non-allowlisted recipient is refused, as before.
- The needs-you producer exports `needsYouItems()` and `refreshDraftsNeedsYou()`.
  Its items carry no HTTP route, so the decision is taken with the commands above.
  Registering it with the Verse activity route is a separate contract change.
