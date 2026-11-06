# Pack bus worker-notes as upstream context for a job

Collect retained bus worker-notes addressed to an address and pack them as upstream context for a job:

```sh
npx tsx examples/agents/bus-notes-context.ts --to fake-worker --job fake-job-1 --upstream fake-upstream-1 --byte-budget 65536
```

`--to` and `--job` are required (`--to` must be valid printable-ASCII ≤ the bus address length, `--job` must pass the fleet job-ID check). At least one `--upstream` (up to 20, distinct, valid job IDs) is required. `--byte-budget` defaults to empty (no budget), must be a positive integer ≤ 65 536. `--after` defaults to `0`.

The script reads retained inbox pages once (bounded at `BUS_INBOX_MAX_MESSAGES`), selects bodies shaped `{"kind":"worker-notes","jobId":<upstream>,"text":<string>}` addressed to `--to`, and passes them to `buildNodeContextPack` with tasks empty. Output JSON: `status` ("ok" or "read-failed"), `jobId`, `pack`, `bytes`, `selected` (note count), `citedUpstreamJobIds`, `missingUpstreamJobIds`, `nextCursor`, and `complete`. Exit codes: `0` ok, `2` invalid-arguments or invalid-cursor, `4` read-failed (partial selection still emitted).
