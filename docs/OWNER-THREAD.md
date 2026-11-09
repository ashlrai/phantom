# Owner thread

One ordered thread for the owner. Desktop, Telegram, email, iMessage and Slack
all land here. A leader reply goes back to the channel the owner used and to
the desktop thread. It never goes to anyone else.

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
| iMessage | Loopback only, on macOS. Text stays in the private thread and the local leader inbox. The bus mirror is redacted. `send-owner` uses the existing self-only transport. | 1. Put your own handle in `~/.ashlr/config.json` as `comms.imessageHandle` and set `comms.enabled` to true. 2. Add `{ channel = "imessage", id = "<that handle>" }` to `[mason]` and `[team]`. 3. Set `[imessage] bridge = "loopback"` in `owner-adapters.toml`. 4. Grant Automation for Messages and Full Disk Access to the terminal that runs the bridge. No remote host is accepted. |
| Slack | The thread can record an owner message passed to the adapter. `send-owner` delivers only through the existing Slack leader path, and only when the original thread reference is present. | 1. Name `phm_SLACK_BOT_TOKEN` in `owner-adapters.toml`. The token value stays in existing Slack custody. 2. Add `{ channel = "slack", id = "<your Slack user id>" }` to `[mason]` and `[team]`. 3. Finish the existing Socket Mode bridge (`phm channels slack status --json`) so a thread reference exists. This command does not open a new paid Slack app. |

`~/.ashlr/KILL` and the comms pause stop every adapter before a transport is called. Nothing in this path spends money or sends to a non-owner address.
