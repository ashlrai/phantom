# iMessage intake

`phm imessage` turns messages you send to yourself from your own handle into
instructions for Phantom, the same way email and Telegram do. macOS only.

What happens to an allowlisted message:

1. It is read from `~/Library/Messages/chat.db`, opened read-only (`sqlite3 -readonly`
   on a `mode=ro` URI). Nothing is ever written to that database.
2. Only the configured owner handle is receipted through the shared channel
   receiver into local `MASON-INBOX.md` and the chief-of-staff queue. Each
   verified-owner receipt is also copied into the unified owner thread
   (`phm comms thread`, `phm comms status`) as a best-effort record — the same
   copy the Telegram, email and Slack receivers get — gated by the iMessage
   owner-thread adapter (`bridge = "loopback"` plus the owner identity);
   without that configuration intake is unaffected and nothing is recorded.
   The copy writes no second inbox entry and its bus mirror stays redacted.
   Other allowlisted handles enter the local teammate inbox with a hashed sender ID,
   and each durable teammate row also mirrors onto the local agent bus as an
   untrusted `note` envelope on the `teammate.findings` topic (see the findings
   mirror below). Owner message bodies never enter the shared agent bus.
3. Repeats of the same words inside ten minutes are one instruction, not two.
4. Owner acknowledgement evidence is written to
   `~/.ashlr-runs/imessage/acks.jsonl` before the send attempt. Since
   RQ-IMSG-REPLY-1 ([#3534](https://github.com/ashlrai/phantom/pull/3534)),
   nonduplicate verified-owner acknowledgements are attempted through the
   outbox to the original owner handle. This caller does not acknowledge
   teammate input. The shared outbox separately supports locally registered
   agents; that does not grant them owner acknowledgement authority.

The journal's legacy `delivery: "recorded-not-sent"` label describes the
pre-attempt record, not a final delivery result. The acknowledgement evidence
reader always reports `deliveryProof: false`. Neither a journal row nor a
successful native send return proves delivery; an absent result does not prove
failure. The receiver's acknowledgement deadline does not cancel a late send,
so a timed-out attempt may still complete. Do not infer a safe retry from this
journal. This documentation changes no send, retry, or KILL behavior.

Text that looks like a secret is refused and never stored.

## Set up

Put your own handle in `~/.ashlr/config.json`. Values stay local; never commit them.

```json
{ "comms": { "enabled": true, "imessageHandle": "<MASON_HANDLE>" } }
```

Optional: `comms.imessageAllow` is an array of handles to accept (your phone number
and your Apple ID email, for example). When it is unset or empty the allowlist is
`[imessageHandle]`. Messages from any other handle are dropped. Only
`imessageHandle` carries operator authority; teammates never inherit it.

## Findings mirror

After each intake batch commits, `src/core/comms/imessage-findings-bridge.ts`
mirrors every durable teammate-inbox row onto the local agent bus so fleet
agents can observe and coordinate on teammate findings (the personal Codex
dot's engineering reports). One row becomes one envelope:

- `to`: `teammate.findings`; `id`: `imessage-teammate-<chat.db rowid>`;
  `from`/`sender.agent_id`: the hashed `imessage:<sha256-16>` sender, never the
  raw handle; `channel`: `imessage`; priority P2; 7-day TTL.
- `body` is a strict v2 `note` — `{kind:'note', text, thread, refs}` — where
  `refs` carries `imessage:teammate:<rowid>` and the conventional claim key
  `queue:teammate.findings.<rowid>`.

Handling is value-blind: the bridge never classifies or routes on content, and
reports carry counts and rowids only — never text or handles. Dedup is by
rowid: the deterministic id makes the store's exact-envelope dedupe idempotent
across retries, and `imessage/findings-bridge.json` (mode 0600) records the
highest handled rowid so an expired envelope is never reposted. Rows that can
never be enveloped (empty, secret-shaped, oversize or older than the 7-day bus
TTL — posting one would stamp a fresh TTL and revive an expired finding) are
counted `refused` and skipped permanently; transient store states stop the
pass and leave them `pending` for the next one. A batch is capped and
serialized under `findings-bridge.lock`; a contended pass reports `busy`.

Findings are untrusted data, never `kind: 'work'` — the work loop cannot claim
them, select argv or execute them. A fleet agent reads the topic with
`phm comms bus read --to teammate.findings`, then coordinates on one finding by
claiming its envelope id (`ashlr fleet bus-claim acquire --id
imessage-teammate-<rowid> --owner <agent> --lease-ms <ms>`); a claim is local
coordination only and grants no execution authority. Owner texts stay off the
bus; the mirror is best effort and never changes a receipt or the cursor.

## Chunked patch transfers

The personal Codex dot can text a patch as a sequence of protocol frames, one
iMessage per frame (message bodies are size-limited, so a diff is chunked).
`src/core/comms/imessage-patch-transfer.ts` reassembles them:

```
PATCH-BEGIN <id> <parts> <sha256>
PATCH-PART <id> <i>/<parts>
<chunk text — the remainder of the message after the first newline>
PATCH-END <id> <sha256>
```

`<id>` is a sender-chosen slug (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`); `<sha256>`
is the lowercase hex digest of the UTF-8 payload — every part's chunk bytes
concatenated in index order. BEGIN declares it and END repeats it; both must
agree before any bytes are trusted.

- Intake consumes each frame from the raw chat.db row (not the scrubbed inbox
  copy) into durable per-transfer state under
  `~/.ashlr-runs/imessage/patches/open/`; `patches/state.json` keeps a bounded
  dedup ring of handled frame rowids and the high-water rowid, so a re-polled
  frame is a `duplicate` and a replay can never apply twice.
- A transfer completes only when END is seen and every part is present; the
  reassembled payload is sha256-verified before `patches/<id>.patch` is
  written (dir 0700, files 0600) next to a `<id>.receipt.json` evidence file
  (outcome, declared sha256/parts/bytes, source rowids, hashed sender — never
  the handle or the patch body).
- Conflicting parts or re-begins, a hash mismatch, oversize payloads, a spent
  transfer id, secret-shaped chunks and malformed frames are terminal:
  `rejected` receipts, no artifact, and the id can never be reused. An open
  transfer unfinished after six hours is expired by the sweep (an `expired`
  receipt), so stale frames are never resurrected and the watermark advances
  past them.
- Frames are protocol traffic, not conversation: the findings mirror counts
  them `protocol` and never posts them as findings. Instead, each verified
  artifact is announced once on `teammate.findings` as
  `imessage-patch-<id>` — a `note` with the artifact name, sha256 prefix and
  part/byte counts, deduped by the `announcedPatchIds` ring in
  `findings-bridge.json`. Nothing applies, stages or executes a patch.

## Local teammate replies

`phm imessage respond --apply --json` polls intake and processes at most three
teammate records per pass. It never prints handles or message bodies. A host
supervisor can schedule this explicit command; ordinary polling alone does not
activate teammate delivery. The live desktop sidecar schedules the same worker
after startup, then thirty seconds after each completed pass. The existing
resident Leader tick invokes it too; private work locks serialize both paths.
The sidecar stops its timer and cancels generation on server shutdown.

Full Disk Access belongs to the actual responsible native process. A successful
foreground CLI check from an authorized app does not qualify a launchd runner.
When `imessage/teammate-status.json` reports `blocked_full_disk_access`, grant
Full Disk Access to the responsible app shown by `imessage doctor` and restart
that app. Phantom never edits the TCC database or works around this permission.

Sending requires all three current local facts: the peer is in
`comms.imessageAllow`, its hashed `imessage:<sha256-16>` identity is explicitly
listed in `[team].identities` in `~/.ashlr/agent-network.toml`, and
`~/.ashlr/comms.toml` has `confirmedByMason = true`. The owner handle remains
separate. Missing configuration leaves the peer pending. Pause applies to this
transport as well.

Replies use only the local model alias `fast` at
`http://127.0.0.1:8123/v1/chat/completions`. Redirects are refused; missing,
timed-out or truncated completions remain drafts. Context comes from bounded
projections of existing leader/fleet records. There are no remote-provider
fallbacks and no tool execution from agent messages.

The private `imessage/teammate-replies.json` journal records bounded work claims,
drafts and send attempts before native delivery. Restarted workers reconcile
exact outgoing text, including attributed-body-only macOS records; an uncertain
send is never repeated while its attempt could still have landed. A send attempt
that still has no chat.db record after thirty minutes returns the durable draft
to the normal send path for a bounded retry — at most three send attempts in
all — after which the row is suppressed and marked answered, so wedged sends
cannot starve newer replies. Pure acknowledgements and artifact-only
updates produce no reply (see the next section). Requests for approval, decisions, or certain actions stay
pending for leader review; they do not prevent later replyable messages in the
same pass from being examined. Pending and uncertain records are preserved when
storage is full. A native transport return alone does not prove delivery.

A healthy pass with an empty inbox establishes that the worker ran. Qualify a
live route with a fresh teammate task question, then inspect the private reply
receipt for an exact outgoing message match and its sent/delivered flags. Keep
that evidence tied to the actual responsible native app and source revision;
a foreground CLI result does not establish desktop background operation.

## Conversational replies

The responder answers what a teammate actually said. For each message it:

1. Picks out the job ids (`RQ-…`, `FIXUP-…`), PR numbers and commit SHAs the
   message names.
2. Looks up the newest lines that mention them in `metrics/jobs.jsonl`,
   `queue/ready.tsv` and `dispatch-events.log`, scrubbed and clipped.
3. Asks the local model with the message, those records, the message again and
   one instruction: answer in plain sentences, and say unknown when the records
   do not show it.
4. Passes the answer through one outbound gate and signs it
   `— Phantom · ref [rowid]`, where the rowid is the message being answered.

The gate refuses secret-shaped text outright. It strips think blocks and control
characters, redacts email addresses, phone numbers and home paths, and cuts the
whole message under 600 characters at a sentence boundary.

Which messages get a reply:

| Message | What happens |
| --- | --- |
| Question or plain request | Model reply |
| Handoff, authorization, receipt, blocker, claim or coordination note | Short confirmation (`acknowledge`) |
| Named review, research or analysis work | Queued, with the job id in the reply |
| Approval, decision or privileged action | Stays pending for leader review |
| Pure ack, short status line, protocol frame, `RESULT <job> <token>` line | No reply |

A confirmation grants nothing: a teammate "authorization" is still untrusted
text. When the model gives no usable answer, a confirmation falls back at once to
a reply that starts `Automatic template reply` and reports the newest matching
record, or that the status is unknown. A question keeps its draft pending for up
to three model attempts or fifteen minutes, then gets the same marked template.
Each teammate gets at most four confirmations an hour; later ones wait as
pending and are sent when the hour has room. They are never suppressed.

The reply journal keeps the newest 150 settled receipts and drops older ones,
as well as any older than seven days. A receipt is dropped only after its
message is marked answered, so trimming never causes a second reply. Every send
gate above still applies, and `phm imessage respond --apply --json` reports the
sent, pending and suppressed counts of each pass.

## Fleet teammate tasks and evidence

Fleet-originated tasks use a separate durable task journal. Inspect configured
peers and existing tasks without sending:

```sh
phm fleet imessage-tasks peers --json
phm fleet imessage-tasks list --json
```

`imessage-tasks enqueue` requires `--peer dot|instinct`, `--job`,
`--kind research|triage|report|rebase`, bounded `--scope`, `--repo owner/name`,
`--format` and a future ISO `--deadline`; optional repeated `--pr` values
name PR numbers. Enqueue previews by default. `--apply` reserves the task
and an exclusive CLAIMED queue job owned by `imsg:<peer>`; it does not send.
`imessage-tasks dispatch` also previews by default; its `--apply` uses the
approved teammate transport, reconciles uncertain sends, and accepts only
a matching task result from the expected peer after the outgoing receipt.
Peer results remain unverified evidence even when the local queue marks DONE.

`imessage-tasks cancel --job <id>` previews withdrawal. With `--apply` it
withdraws only a provably unsent, unexpired queued task and settles its local
claim as BLOCKED. Sending, pending, expired and replied tasks refuse; cancellation
does not assert a remote stop. `teammate-tasks` exposes the older
enqueue/dispatch/list/peers interface; prefer `imessage-tasks` for bounded
receipts that omit private task correlation tokens.

Counts and metadata readers help distinguish configuration, intake and delivery:

```sh
phm fleet imessage-path --json
phm fleet imessage-acks --limit 20 --json
phm fleet imessage-acks --rowid 123 --json
phm fleet teammates --json
phm fleet teammate-latency --window-hours 24 --target-minutes 5 --json
```

`imessage-path` reports bounded local path evidence; its legacy owner-only
transport and unsupported-collaborator states do not assess the separate
teammate task transport described above. `imessage-acks` reads the
acknowledgement journal; no match in its bounded tail does not prove a message
was never ingested. Legacy journal labels such as `recorded-not-sent` are
normalized to `delivery: "unknown"` in CLI/MCP evidence; the original journal
remains unchanged. This source cannot prove delivery or non-delivery, even if
a row claims a successful native return. `deliveryProof` remains false.
`teammates` shows
declared counterparts and masked handles with observed text times. Latency
summarizes recorded replies and unanswered age; missing sources remain unknown.
The read-only fleet MCP equivalents are in the
[fleet MCP onramp](FLEET-MCP-ONRAMP.md#coordination-and-imessage-observations).

## Check it

```bash
phm imessage doctor --json
```

Five checks, each with a `state`, a `detail` and a `fixHint` that names the System
Settings path:

| check | states | meaning |
| --- | --- | --- |
| `config_handle` | `set`, `not_set`, `unavailable` | a handle or allowlist is configured |
| `chat_db_readable` | `ok`, `blocked_full_disk_access`, `missing` | this process can open chat.db |
| `responsible_binary` | `info` | `process.execPath` and the parent app that needs the permissions |
| `sqlite3_present` | `ok`, `missing` | the `sqlite3` CLI is on PATH |
| `automation_messages` | `unknown`, `ok`, `blocked`, `error` | Automation access to Messages, learned from the last send; error `-1743` reads as `blocked` |

Exit code is 0 when nothing is blocked or missing. Phantom never changes macOS
privacy settings; follow the `fixHint` yourself. Full Disk Access belongs to the
app that launched `phm` (Terminal, iTerm, or the desktop app): enable it under
System Settings > Privacy & Security > Full Disk Access, then restart that app.

## Leader replies by text

iMessage is two-way. Texts from your own handle become `MASON-INBOX.md` lines
tagged `[src:imessage]`. Replies the Leader writes for you (entries in
`leader/MASON-OUTBOX.md` and "Reply for Mason" lines in `leader/PLAN-LOG.md`)
can be texted back to that same handle, once each.

```bash
phm imessage replies --json   # sends when comms.leaderRepliesSend is true
```

With `comms.leaderRepliesSend` unset or false, this is a dry run. Setting it to
`true` in `~/.ashlr/config.json` enables sending on this command and on
`poll --apply`; `--json` selects output format and does not force a dry run.
Replies go only to `comms.imessageHandle`, never to anyone else. Each reply is
recorded by hash in `~/.ashlr-runs/imessage/leader-sent.jsonl` (mode 0600), so it
is never sent twice. The first live pass marks existing replies as already seen,
so old history is not texted out. At most three go out per pass, and only one
pass runs at a time. `phm imessage poll --apply` runs the same pass after intake;
the sidecar worker does not send replies yet. Texts from any other handle never
reach `MASON-INBOX.md`.

## Poll

```bash
phm imessage poll --json            # dry run: counts only, no message text, cursor untouched
phm imessage poll --apply --json    # receipt waiting messages and advance the cursor
```

Dry-run output: `{"dryRun":true,"state":"ok","waiting":2,"cursor":4812}`.

The cursor is the highest `message.ROWID` handled, kept in
`~/.ashlr-runs/imessage/cursor.json` (mode 0600). The first `--apply` only
baselines the cursor to the newest message, so old history is never ingested.
If the queue is briefly unavailable the batch stops early (`deferred`) and the
next poll retries from the same message. Schedule `phm imessage poll --apply`
with your usual cron or launchd job; nothing here listens on a network port.

## Limits

- Messages whose body exists only as an attributed blob (some newer macOS
  messages, attachments only) have no plain text and are skipped.
- Tapbacks are ignored.
- Up to 200 messages are read per poll.
