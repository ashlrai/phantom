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

## Verify

`test/channels.test.ts` — status shape, attribution, custody reporting, the
bad-input refusals, and that no output path contains a secret value.
