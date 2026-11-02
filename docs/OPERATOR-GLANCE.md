# Operator glance

One typed reading of the fleet serves the phone, Telegram, email, and any
agent that imports it.

- Shape and short text: `src/core/fleet/operator-glance.ts` (`OperatorGlance`, `formatOperatorGlance`)
- Files: `src/core/fleet/operator-glance-read.ts`
- HTTP: `GET /api/verse/fleet/runs/glance`
- Orders: `POST /api/verse/fleet/runs/inbox` with `{ "text": "..." }`, which appends `~/.ashlr-runs/leader/MASON-INBOX.md`

The phone opens on that glance. Telegram and email use the same sentences.
Ask "how's the fleet?" and the reply is a few lines. Any other sentence is an
order. Inbound text is logged. It is never run as a shell command.

Outbound messages are only "Release shipped.", "Needs you.", or "Claude lane
is down. It needs you." Ordinary merges and lane holds stay quiet.

## What Mason supplies

Existing paired devices keep working. Unpaired senders get no data or reply.

| Channel | Where the secret lives | What to do once |
| --- | --- | --- |
| Telegram | `TELEGRAM_BOT_TOKEN` in the environment, or `comms.telegram.botToken` in `~/.ashlr/config.json`. Chat id: `comms.telegram.chatId`. | From the configured private user id, send `/pair <code>` using the private `PHANTOM_OPERATOR_SECRET` or operator-secret file below. This pairs the user id in `~/.ashlr-runs/queue/telegram-pair.json`. Delete that file to pair a different id. The token is never committed or logged. |
| Email | `PHANTOM_OPERATOR_SECRET` in the environment, or mode `0600` file `~/.ashlr/comms/operator-secret`. 16–128 characters, no spaces. | Keep the existing drop folder and `--from` allowlist. The saved `.eml` must include `Authentication-Results` with `dkim=pass` and `header.d=` for the sender's domain. Put the secret on its own line in the first mail. Later mail from that address can be plain language. The secret is removed before the order is logged. |
| Phone | Existing `~/.ashlr/verse-remote.json` (Cloudflare Access) and the Mac pairing code. | Open `/verse/m`. No new step. |

Without an email secret, only an already paired address with a matching DKIM pass is accepted.
The drop folder must be populated by a trusted mail receiver that strips incoming
Authentication-Results headers and writes its own verification result.
A missing or failed DKIM result is refused either way. An invalid secret refuses mail
rather than weakening the check.

Rate limit: 500 messages per 10 minutes per sender. The reply is "Slow down."
and nothing is written.
