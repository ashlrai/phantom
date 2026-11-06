# Channels CLI

`phm channels` is the one path to bring a channel up (`add`) and read its state
(`status`). The six kinds are `INBOUND_CHANNELS`: email, telegram, mobile,
desktop, page, cli.

## Safety

- `add` writes configuration only: `comms.*` in `~/.ashlr/config.json` for
  telegram, `queue/email-drop.json` for email. It starts no transport, pairs
  nothing, and polls nothing.
- Credentials never move. Telegram reads `TELEGRAM_BOT_TOKEN` or
  `comms.telegram.botToken`; email reads `PHANTOM_OPERATOR_SECRET` or
  `~/.ashlr/comms/operator-secret`. `add` accepts no token argument, stores no
  secret, and prints no secret value — custody fields report `environment`,
  `config`, `file`, `none-needed`, or `missing`.
- `status` is read-only. Counts are measured (`received` from the bounded inbox
  tail, `pendingOutbound` from the Leader thread index or the email outbox);
  a source that cannot be read reports `unknown`, never a fabricated number.
- `cli`, `desktop`, and `page` are built in — `add` writes nothing and reports
  the existing path. `mobile` points at the `~/.ashlr/verse-remote.json`
  gateway file; it is never written by this command.

## Slack bridge subcommands

`phm channels slack` inspects and runs the agent-network Slack bridge; it is not
one of `INBOUND_CHANNELS` and shares none of the `add` paths.

- `slack status [--json]` parses `~/.ashlr/agent-network.toml` and
  `~/.ashlr/comms.toml`, and reads the bounded `slack-bridge` journal under the
  runs dir. It reports `phm_` reference names only, never a token value.
- `slack map [--topic <t>] [--snapshot <file>] [--json]` is a dry run: the
  topic/channel table, one topic's route, and the audience gates and send-policy
  verdict for an operator-supplied `{conversation, members}` snapshot.
- Neither verb opens a socket, calls a Slack API, reads or resolves a
  credential, or posts anything. Exit codes: 0 report, 1 input error, 2 usage.
- `slack probe [--json]` authenticates the exact configured workspace/user/bot using host-injected credential references. Reports observation time without tokens.
- `slack run --seconds <1-300> [--json]` opens a bounded Socket Mode session, appends receive events to the existing durable bus, and acknowledges only after persistence or deliberate policy refusal. Outbound delivery verifies current audience and human approval, persists intent before one post, and reconciles uncertain sends without automatic replay. Private iMessage/email bodies stay local.
- Offline `ready` is configuration readiness, not a live transport claim. Dot's signed HTTP peer-ingress adapter remains opt-in; it opens no listener.

## Verify

`test/channels.test.ts` — status shape, attribution, custody reporting, the
bad-input refusals, and that no output path contains a secret value.
`test/agent-network-slack.test.ts` — `[slack]` config parsing, inbound event
decisions, audience evaluation, outbound planning, backoff, the journal and
the CLI dry runs.
