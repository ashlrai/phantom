# Owner thread

One ordered thread for the owner. Desktop, Telegram, email, iMessage and Slack
all land here. A leader reply goes back to the channel the owner used and to
the desktop thread. Ordinary owner-thread messages and replies are not broadcast
into agent group chats. The separately gated, explicit agent-chat share below is
an opt-in exception for selected text, not a mirror of this thread.

Claim key: `queue:RQ-COMMS-UNIFIED-1`. A claim coordinates work and grants no
execution authority. The leader inbox handoff is `createLeaderMailbox` in
`src/core/comms/leader-mailbox.ts`.

```sh
phm comms status --json
phm comms thread --json
phm comms send-owner --text "Synthetic reply" --json
```

MCP tools: `ashlr_comms_thread` (read) and `ashlr_comms_send_owner` (append;
KILL refuses it). `ashlr_comms` includes the same adapter rollup as
`phm comms status --json`.

The thread read joins the per-channel delivery receipts written at send time:
`receipts` maps each outbound message id to `{ channel: { state, reason? } }`
with `delivered`, `pending` or `failed`. A channel with no record is unknown —
never reported as delivered — and the human `phm comms thread` output appends
`[channel:state ...]` to outbound lines that have receipts. The receipt journal
is bounded, so older messages simply have no entry.

## Rotation, history and pulling

When the live thread passes its message or byte cap it archives the oldest
half to `owner-thread-archive-<first>-<last>.json` beside it in the leader
runs directory. Sequence numbers keep counting, and archived idempotency keys
still dedupe replays.

```sh
phm fleet owner-history --limit 50 --json   # read-only; page back with --before <seq>
phm fleet owner-pull --channel telegram     # pull remote channels into the thread
```

`owner-pull` skips a channel that is not configured and enabled, and does
nothing while `~/.ashlr/KILL` or the comms pause is set.

## Adapters

Each adapter is disabled until that channel's owner identity is in
`~/.ashlr/agent-network.toml` under both `[mason].identities` and
`[team].identities`, and `~/.ashlr/comms.toml` contains `confirmedByMason = true`.
Remote channels also need a Phantom Secrets handle name in
`~/.ashlr/comms/owner-adapters.toml`. The file stores names, never values.

```toml
[telegram]
secretHandle = "phm_TELEGRAM_BOT_TOKEN"

[email]
secretHandle = "phm_EMAIL_CREDENTIAL"

[slack]
secretHandle = "phm_SLACK_BOT_TOKEN"

[imessage]
bridge = "loopback"
```

| Channel | Works once the identity is saved | One-time owner setup |
| --- | --- | --- |
| Desktop | Yes. Native. No secret. Inbound from the desktop composer and `send-owner` both land on this thread. | Add `{ channel = "bus", id = "local-owner" }` to `[mason]` and `[team]`, and `{ channel = "bus", id = "leader" }` to `[team]`. Set `confirmedByMason = true`. |
| Telegram | The thread records owner messages that already pass the Telegram receiver. `send-owner` delivers with the existing bot client when the chat id matches. | 1. Create a bot with BotFather and store the token as Phantom Secrets handle `phm_TELEGRAM_BOT_TOKEN` (the environment name `TELEGRAM_BOT_TOKEN` stays in existing custody). 2. `phm channels add telegram <numeric chat id>`. 3. `phm comms pair-telegram`. 4. Add `{ channel = "telegram", id = "telegram:<chat id>" }` to `[mason]` and `[team]`. 5. Write the handle name in `owner-adapters.toml` as above. |
| Email | The thread records allowlisted drop-folder mail. `send-owner` uses the existing Mail.app outbox and only the saved `from` address. | 1. `phm comms setup-email`. 2. `phm comms email-drop <inboxDir> --from <verified-address> --save-config --send-replies`. 3. Add `{ channel = "email", id = "email:<verified-address>" }` to `[mason]` and `[team]`. 4. Store the mail credential as `phm_EMAIL_CREDENTIAL` and name that handle in `owner-adapters.toml`. |
| iMessage | Loopback only, on macOS. Ordinary text stays in the private thread and the local leader inbox. The bus mirror is redacted; explicit agent-chat shares are the separately gated exception below. `send-owner` uses the existing self-only transport. | 1. Put your own handle in `~/.ashlr/config.json` as `comms.imessageHandle` and set `comms.enabled` to true. 2. Add `{ channel = "imessage", id = "<that handle>" }` to `[mason]` and `[team]`. 3. Set `[imessage] bridge = "loopback"` in `owner-adapters.toml`. 4. Grant Automation for Messages and Full Disk Access to the terminal that runs the bridge. No remote host is accepted. |
| Slack | The thread can record an owner message passed to the adapter. `send-owner` delivers only through the existing Slack leader path, and only when the original thread reference is present. | 1. Name `phm_SLACK_BOT_TOKEN` in `owner-adapters.toml`. The token value stays in existing Slack custody. 2. Add `{ channel = "slack", id = "<your Slack user id>" }` to `[mason]` and `[team]`. 3. Finish the existing Socket Mode bridge (`phm channels slack status --json`) so a thread reference exists. This command does not open a new paid Slack app. |

`~/.ashlr/KILL` and the comms pause stop every adapter before a transport is called. Nothing in this path spends money or sends to a non-owner address.

### Short Slack status replies

With the existing owner verification and delivery gates satisfied, a short
status ask such as `Phantom status` uses the fixed status reader, not a model.
Specific requests such as `status of the release PR #12` stay on the Leader
path. `recheck`, `orders`, `review`, `owners`, `bridge`, and `peers` have their
own readers; they do not use the status layout below.

The status body starts with the digest. Socket Mode also supplies an optional
runtime/channel-health line below the heading. A work-board summary follows,
reading at most 20 retained items and showing counts plus up to three items
needing attention. An unreadable board yields `Work items: unknown`, not zero.
The body drops work-board lines first, then the optional runtime line when
space is tight; an absent or throwing runtime-line reader adds no line.

The Slack composer separately appends a newly read snapshot with `Runtime:`,
`Fleet state:`, and `Claims:` lines, reserving space by shortening the earlier
body within the 1,500-character reply budget. Fleet freshness means time since
the last state write, not proof of current execution. Live claims are reported
separately from running-worker evidence when available. Unavailable fields say
`UNKNOWN`; a failed snapshot read produces `Runtime: UNKNOWN (snapshot
unavailable)`. A failed digest produces the fixed status-read fallback, still
followed by snapshot evidence when available.

These are read-only observations, not claims of completed work or permission
to dispatch. This describes the source implementation; it does not establish
that a particular Slack bridge has installed it or delivered a live reply.

### Explicit sharing into agent chat

The native iMessage receiver can separately accept an exact `agent-chat.share`
JSON object from the configured, verified owner handle, after private intake.
Only its selected `text` goes to the specified channel and run/outcome thread;
ordinary messages and private history are not copied. See [Agent group chat](AGENT-CHAT.md)
for the JSON shape, required native source identity, recipient approval,
replay limits and refusal behavior. This is not a generic desktop, Slack,
email or Bus write endpoint, and it does not upgrade a note into a command.
An accepted share receipt proves local Bus append, not agent consumption,
execution, remote delivery or installation on a particular host.

### Copy Leader plan replies into the conversation

The Leader conversation in the desktop app and the phone view already shows
each **Reply for Mason** from the plan log as a Leader message at its heading
time, oldest first; no command is needed. To read them in a terminal, run
`phm leader replies` (one line each, newest first; `--json` adds a stable `id`
per heading). The leader's usual line,
`**Reply for Mason** (for OUTBOXFALLBACK to copy): "..."` under a
`## 2026-11-16 ~22:55 ET` heading, is read as the plain quoted text at 22:55
ET. A heading with no time shows its time as "unknown".

The desktop Home and the phone Home show the newest of these in a **From your
leader** card (three on the desktop, one on the phone). The card reads
`GET /api/verse/fleet/runs/leader-replies?limit=N`, which returns the same
`leader.replies.v1` report as `phm leader replies --json`: `schema`,
`version`, `sourceState`, an optional `reason`, and `replies`, newest first,
each `{at, text, source}` with `source` `plan-log` or `outbox`. Identical text
appears once, each reply is capped at 1,200 characters, and a reply with no
dated heading above it has `at` `unknown`. `entries` keeps the dated plan-log
replies with their ids. The reader looks at the last 200 KB of the plan log
and of the `MASON-OUTBOX.md` beside it, and sends nothing.

The plan log path comes from `--file`, then `PHANTOM_PLAN_LOG`, then the
`comms.leaderPlanLogPath` config key (unset by default), then
`leader/PLAN-LOG.md` under the runs directory.

Run `phm leader replies sync --json` to copy new dated **Reply for Mason**
blocks from `~/.ashlr-runs/leader/PLAN-LOG.md` into the existing Leader thread.
The same typed function, `syncLeaderReplies()` in `leader-thread.ts`, serves
agent callers. Reply text appears directly in the conversation; Telegram
messages enter the existing delivery queue.

Run `phm outbox from-log --apply --json` each hour to also put the newest
**Reply for Mason** in `MASON-OUTBOX.md` beside the plan log, as one
`## <ISO time> (leader)` entry, so it reaches Mason between daily digests. It
skips text the outbox already holds, shows the same text in the Leader chat
through the sync above, and without `--apply` only prints what it would add.
No reply block is a no-op (exit 0). JSON schema: `outbox.from-log.v1`.

The command reads only the last 256 KiB and considers the newest 30 blocks.
It never writes the plan log. Dated headings identify replies, including when
text repeats; editing an already posted heading does not post it again.
JSON returns `posted` and `skipped` heading hashes, `sourceState`, and `unknown`
ids for interrupted writes. Missing sources report `missing`; unreadable
sources report `unknown`. Unknown writes are held for inspection rather than
replayed. Phone receipt is not proven by a successful local append.
