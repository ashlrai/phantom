# iMessage intake

`phm imessage` turns messages you send to yourself from your own handle into
instructions for Phantom, the same way email and Telegram do. macOS only.

What happens to an allowlisted message:

1. It is read from `~/Library/Messages/chat.db`, opened read-only (`sqlite3 -readonly`
   on a `mode=ro` URI). Nothing is ever written to that database.
2. Only the configured owner handle is receipted through the shared channel
   receiver into local `MASON-INBOX.md` and the chief-of-staff queue. Other
   allowlisted handles enter the local teammate inbox with a hashed sender ID,
   and each durable teammate row also mirrors onto the local agent bus as an
   untrusted `note` envelope on the `teammate.findings` topic (see the findings
   mirror below). Owner message bodies never enter the shared agent bus.
3. Repeats of the same words inside ten minutes are one instruction, not two.
4. Owner acknowledgement evidence is written to
   `~/.ashlr-runs/imessage/acks.jsonl`; nonduplicate owner acknowledgements pass
   through the existing owner-only transport. That transport still cannot send
   to teammates.

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
`~/.ashlr/comms.toml` has `confirmedByMason = true`. The desktop console's
Needs-you drawer shows "Confirm Comms limits" while it is unset: it lists the
limits and sets the flag in one click from the unlocked app. No agent, CLI or
MCP path writes it. The owner handle remains
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
send is never automatically repeated. Pure acknowledgements and artifact-only
updates produce no reply. Requests for approval, decisions, or certain actions stay
pending for leader review; they do not prevent later replyable messages in the
same pass from being examined. Pending and uncertain records are preserved when
storage is full. A native transport return alone does not prove delivery.

A healthy pass with an empty inbox establishes that the worker ran. Qualify a
live route with a fresh teammate task question, then inspect the private reply
receipt for an exact outgoing message match and its sent/delivered flags. Keep
that evidence tied to the actual responsible native app and source revision;
a foreground CLI result does not establish desktop background operation.

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
phm imessage replies --json   # dry run by default: counts what is waiting, sends nothing
```

To send for real, set `comms.leaderRepliesSend` to `true` in `~/.ashlr/config.json`.
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
