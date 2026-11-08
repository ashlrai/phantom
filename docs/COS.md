# Chief of staff

A verified plain-language instruction becomes a durable READY job in the queue
used by `phm queue`. The original text is the job scope. The acceptance field
holds a JSON route with the originating channel, verified sender and message ID.
Intake runs the shared inbox, secret-shape checks and channel acknowledgement.
Intake starts no model process. A separate pass answers the job (see Worker).
Every verb below is `phm fleet cos …`; `ashlr fleet cos …` is the same command.

## Ask

```sh
phm fleet cos ask "Prepare a weekly project brief" --channel cli --json
phm fleet cos status cos-0123456789abcdef0123456789abcdef --json
```

Ask returns `{id, ack, status:"queued"}` once the job is durable. Status returns
`{job, draft?, delivery?, needsYou}`. Errors return `{error}` and exit nonzero.
`--channel` accepts cli, desktop, telegram, email, mobile or page. On the CLI it
is an attribution label; it does not authenticate a sender or authorize a send.
Credentials are never arguments; use Phantom Secrets binding names in the
transport configuration.

Other ways in:

- **Desktop:** tick "Run as task" in the Verse interject box. The Tasks card
  and list show state and the draft. Wire details: [COS-DESKTOP-API.md](COS-DESKTOP-API.md).
- **Telegram and email:** accepted instructions from the configured receivers
  are queued by the shared receiver.
- **iMessage:** `phm imessage poll --apply` ingests allowlisted messages. The
  sender is stored as a hash, never the raw handle. The acknowledgement is
  recorded to `<runs>/imessage/acks.jsonl` and not sent.

## Worker

```sh
phm fleet cos-work [--apply] [--runs-dir <abs>] [--json]
```

Dry run by default: it counts the READY `cos-*` jobs without claiming or
spawning. With `--apply` it runs one bounded pass; call it once per tick, it
never loops. It claims the oldest
READY `cos-*` job whose dependencies are done and runs one headless model turn
on the declared planner slate (10 minute timeout, output capped at 64 KB, draft
at 16,000 characters, secrets scrubbed). The request is passed as untrusted data.
`ashlr fleet cos-loop --duration-ms 3600000 --json` repeats that pass for a
bounded window — a host timer (for example launchd) or an agent can start it
once and queued tasks get drafted without a person; the loop only drafts, and
sending still needs digest approval.

- **paused:** the PAUSE runs switch is on; the queue is not touched.
- **idle:** no workable job, or another claim won the race.
- **drafted:** the reply is saved as a private draft, the job is DONE and a
  needs-you item is added to `NEEDS-MASON.md`.
- **blocked:** no usable runner leaves the job READY. A failure after the claim
  marks it BLOCKED with a short fixed reason (not model output); replay it with
  `phm queue replay --failed`.

Exit 0 for idle, paused and drafted, 1 for blocked, 2 for bad usage. A drafted or
blocked pass posts one best-effort bus notice.

`ashlr fleet cos-loop --duration-ms 3600000 --json` repeats the worker pass
for a bounded window — a host timer (for example launchd) or an agent can
start it once and queued tasks get drafted without a person; the loop only
drafts, and sending still needs digest approval.

Stored memory (doctrine, then preferences, then facts, up to 4000 characters)
is added to the prompt. See `phm memory`. Memory never authorizes an action.
The worker sends nothing.

## Approve

Read the whole draft, including recipient, thread and text, before approving.
Approval binds to the draft digest; changed text cannot reuse an earlier approval.

- **Desktop:** the Tasks card shows the draft and an Approve button. The API
  takes `{id, digest}` only and never reply text.
- **Telegram:** replies to the original message and records the sent message ID
  in the thread map.
- **Email:** writes the reply to the email outbox drop directory with
  In-Reply-To and References headers. The mail transport stays external.
- **desktop, cli and mobile origins:** approval only records the claim; the
  reply is already on screen (mobile reads it through `cos/status`).
- **No transport yet:** page and iMessage. The API answers
  `COS_NO_TRANSPORT`. Email with no outbox configured is the same.

There is no CLI approval command.

## Uncertain delivery

An exclusive claim prevents concurrent or repeated sends. A failed transport
becomes `uncertain`; a crash can leave `sending`. Check the channel, then record
what you found:

```sh
phm fleet cos-reconcile <id> --delivered   # it arrived: mark sent, close the needs-you item
phm fleet cos-reconcile <id> --retry       # it did not: allow one more approved send
```

Neither sends anything. A `sending` claim is refused until it is 10 minutes old.
Exit 1 means the state is refused.

## Limits

The acknowledgement follows durable queue persistence. Queue lock contention is
bounded to 250 ms; the bus and acknowledgement waits are each bounded to two
seconds. The local path targets an acknowledgement within five seconds. Disk
stalls, earlier serialized receives and transport failures can miss that target;
it is not a remote delivery guarantee.

Duplicate receipt IDs reuse the same job and keep the first origin. A failed
queue write reports failure and can be retried without another inbox entry.
Unknown senders are refused before any queue write.
