# Drain the retained bus backlog for one address

Scan the retained bus inbox once for messages addressed to a single routing address:

```sh
npx tsx examples/agents/bus-backlog-drain.ts --to fake-worker-b
```

`--to` is required and must be a valid bus address (1–128 printable ASCII characters). `--after` defaults to `0` and must be a non-negative integer. The script pages the inbox in `BUS_INBOX_MAX_READ`-sized reads, keeping every live receipt whose `envelope.to` matches `--to` exactly (case-sensitive), until the cursor stops advancing or `BUS_INBOX_MAX_MESSAGES` rows are scanned.

The output JSON contains `status` ("complete", "missing", or "read-failed"), `to`, `messages`, `scanned`, `nextCursor`, `scanCapReached`, and optionally `reason`. Exit codes: `0` for a successful drain, `3` for a missing store, `4` when the store is unavailable or the cursor is invalid.
