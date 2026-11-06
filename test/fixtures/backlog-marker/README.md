# Backlog marker baseline

`value-filter.ts.b64` contains the exact UTF-8 source of
`src/core/portfolio/value-filter.ts` at commit
`1a57744bd43ea5668f469bd8eaa394808a7f9bea`, encoded as base64.
The evaluator test pins the decoded SHA-256 to
`439bba673ce05b6d20993b7ffdfa35f7347d5f1842422625a4361d1cf657b6a1`.

Keep this historical baseline unchanged. It must fail the fixed evaluator,
while the fixture-only repair must pass all 142 classification cases.
Vendoring the bytes keeps shallow and source-only checkouts independent of
Git history and network access.
