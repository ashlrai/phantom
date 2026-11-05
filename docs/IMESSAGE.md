# iMessage intake

`phm imessage` turns messages you send to yourself from your own handle into
instructions for Phantom, the same way email and Telegram do. macOS only.

What happens to an allowlisted message:

1. It is read from `~/Library/Messages/chat.db`, opened read-only (`sqlite3 -readonly`
   on a `mode=ro` URI). Nothing is ever written to that database.
2. It is receipted through the shared channel receiver: a `MASON-INBOX.md` entry
   attributed to `imessage`, a mirror on the agent bus (`phm comms bus read`),
   and a chief-of-staff queue job (see [COS.md](COS.md)).
3. Repeats of the same words inside ten minutes are one instruction, not two.
4. An acknowledgement line is written to `~/.ashlr-runs/imessage/acks.jsonl`.
   It is **recorded, not sent**. Sending replies is a separate change
   (RQ-IMSG-REPLY-1); until it lands, this channel has no send path.

Text that looks like a secret is refused and never stored.

## Set up

Put your own handle in `~/.ashlr/config.json`. Values stay local; never commit them.

```json
{ "comms": { "enabled": true, "imessageHandle": "<MASON_HANDLE>" } }
```

Optional: `comms.imessageAllow` is an array of handles to accept (your phone number
and your Apple ID email, for example). When it is unset or empty the allowlist is
`[imessageHandle]`. Messages from any other handle are dropped. Everything on the
allowlist is treated as you, so list only your own handles.

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
