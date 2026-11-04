# Chief-of-staff intake

A verified plain-language instruction becomes a durable READY job in the same
queue used by `phm queue`. The original text remains the job scope. The acceptance
field retains a JSON route with the originating channel, verified sender and
message ID. The existing inbox, secret-shape checks and channel acknowledgements
remain in use. `ashlr ask` continues to provide portfolio RAG.

## Command contract

```sh
phm cos ask "Prepare a weekly project brief" --channel cli --json
phm cos status cos-0123456789abcdef0123456789abcdef --json
```

Ask returns `{id, ack, status:"queued"}` after the job is durable. Status returns
`{job, draft?, delivery?, needsYou}`. Errors return `{error}` and a nonzero exit
code. `--channel` accepts cli, desktop, telegram, email, mobile or page. A local
CLI channel label records attribution; it does not authenticate a remote sender
or authorize a send. Credentials are never command arguments. Use Phantom
Secrets binding names in the existing transport configuration.

The handler lives in `src/cli/cos.ts`. Top-level `phm cos` registration and
desktop/Verse custom-sink wiring require edits outside the task's named files.
Until that scope is extended, those two entry points are not available. Telegram
and email use the default shared receiver and queue accepted instructions now.

## Background work and completion

The queue is dispatch-neutral. An existing worker must claim and execute the
job; intake itself starts no model or provider process. A worker completes an
intake job by supplying a result:

```sh
phm queue claim cos-0123456789abcdef0123456789abcdef --owner brief-worker --json
phm queue done cos-0123456789abcdef0123456789abcdef --owner brief-worker --result "The project brief is ready for review." --json
```

Completion writes a private result draft under `<runsDir>/cos/` and adds a
needs-you item to `NEEDS-MASON.md`. It sends nothing. Inspect the entire draft,
including recipient, thread and text, before approving its digest through a
trusted approval surface. No CLI approval command is introduced here.

The trusted surface can call `deliverTelegramCosResult` or
`deliverEmailCosResult` with that approved digest. Telegram replies to the
original message and records its delivered message ID in the existing thread
map. Email places an approved reply in the existing outbound drop directory
with In-Reply-To and References headers. The mail transport remains external.
The generic `deliverCosResult` seam supports an approved desktop transport.
These are internal helpers, not new network endpoints. Approval UI wiring is
not included in the named-file scope.

## Timing, retries and limits

The same-channel acknowledgement follows durable queue persistence. Queue lock
contention is bounded to 250 ms; the shared bus and acknowledgement waits are
each bounded to two seconds. The normal local path targets an acknowledgement
within five seconds. Disk stalls, earlier serialized receives and transport
failures can prevent that target; this is not a remote delivery guarantee.

Duplicate receipt IDs reuse the same queue job and preserve its first origin.
A failed queue write reports failure and can be retried without another inbox
entry. Unknown senders are refused before any queue write. Existing cross-channel
inbox attribution continues to use the shared receiver's identity rules.

An exclusive delivery claim prevents concurrent or repeated sends. A transport
failure becomes `uncertain`; a crash can leave `sending`. Reconcile those states
against the channel before any manual retry. A successful send reports `sent`.
The needs-you item remains in the normal ledger for operator resolution. Changed
result text cannot reuse the original draft approval.
