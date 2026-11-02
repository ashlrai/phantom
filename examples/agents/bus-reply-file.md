# Reply to a saved bus envelope

From the repository root, save a received **envelope** (the six wire fields,
not its inbox receipt wrapper) as `request.json`, and save any JSON value as
`body.json`. Then run:

```sh
npx tsx examples/agents/bus-reply-file.ts --request-file request.json --body-file body.json --from fake-worker-b --id fake-reply-1 --ttl 60000
```

The response goes to the request's `from` routing label and its body is
`{"replyTo": request.id, "payload": <parsed body.json>}`. The caller chooses
`--from`, `--id`, and a positive safe-integer `--ttl` in milliseconds. TTL is
explicit: a saved envelope alone cannot establish its age or remaining lifetime.
The response inherits the request priority unless `--priority P0`, `P1`, `P2`,
or `P3` is supplied. Optional `--root /absolute/path` selects a private local
inbox root; otherwise the usual Phantom fleet inbox is used. Input files must be
owner-controlled regular files in owner-controlled directories, and each is
limited to 65,536 UTF-8 bytes. The production validator also limits the complete
response and validates its fields and JSON depth.

One JSON object is printed. Exit code `0` means the transport returned `posted`
or `duplicate` with an ID and cursor. Exit code `2` indicates invalid arguments,
input, or inaccessible files; code `3` reports a transport failure such as
`conflict`, `full`, `retryable`, `invalid`, or `unavailable`. A receipt confirms
local transport acceptance, not remote delivery or acknowledgement. There is no
waiting or automatic retry. A duplicate requires the same ID and exact envelope.

The request's `from` is an untrusted routing label, not authenticated identity;
embedding hosts must enforce their own identity and admission rules. Bodies are
opaque data, are not scrubbed, and are never executed. Do not put secrets in the
inbox. This workflow does not contact a provider.
