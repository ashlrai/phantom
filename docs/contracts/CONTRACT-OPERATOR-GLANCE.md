# Operator glance

One `OperatorGlance` value is the fleet reading for the phone, Telegram, email,
and agents. `formatOperatorGlance` is the only reply text.

## Safety

- Telegram accepts the configured private chat id, then pairs that user id.
  A different id does not replace the pair file.
- Email with `PHANTOM_OPERATOR_SECRET` set requires DKIM pass for the sender
  domain and the secret once. The secret is not written to the inbox.
- An invalid secret refuses mail. A `dkim=fail` result refuses mail.
- Inbound text is an order in `leader/MASON-INBOX.md` or a status ask. It is
  never a shell command.
- Outbound notes are a release, "Needs you.", or the Claude lane being down.
- Tokens and the pairing secret are read from the environment or a private
  file. They are not committed or logged.

## Verify

`test/operator-glance.test.ts` and `src/web-ui/routes/verse/mobile/screens/OperatorGlance.test.tsx`.
