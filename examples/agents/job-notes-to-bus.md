# Post a job's worker notes to the local bus

From the repository root, read one job's notes through getFleetJobText and
post exactly one validated envelope through appendBusInbox (priority P2, 10
minute TTL, 64 KiB envelope limit):

```sh
npx tsx examples/agents/job-notes-to-bus.ts --job fake-job-1 --from fake-worker-a --to fake-worker-b --id msg-001
```

`--job`, `--from`, `--to`, and `--id` are all required. No optional flags
exist beyond `--help`. The transport fields are validated by
`validateBusEnvelope` before any reader call.

The single JSON object on stdout is the transport receipt: `{status, id,
cursor}` on success. Error JSON has `{error, usage}` (exit `2`:
invalid-arguments/invalid-envelope/notes-too-large) or `{error}` (exit `1`:
notes-missing/notes-unreadable/notes-unavailable/job-mismatch/transport
failure). Exit codes: `0` posted/duplicate, `1` notes missing/unreadable/unavailable/job-mismatch or transport failure, `2` invalid arguments/envelope/too-large, `3` retryable, `4` full, `5` conflict, `6` notes-too-large.
