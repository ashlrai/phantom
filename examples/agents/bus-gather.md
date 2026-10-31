# Gather fan-out responses without posting

Poll the inbox for worker replies matching a fan-out manifest, without writing to the bus:

```sh
npx tsx examples/agents/bus-gather.ts --file fanout.json --timeout-ms 5000
```

`--file` is required and must contain a JSON object with `coordinator` and a `requests` array (1–20 entries, each with `requestId` and `worker`). `--after` defaults to `0`. `--timeout-ms` is required (max 300 000 ms). The script polls, waits up to 250 ms between polls, and stops when all replies arrive, the timeout elapses, or a signal is received.

The single JSON object on stdout includes `status` ("complete" at exit 0, "timeout" at 5, "interrupted" at 130, or other error codes), `replies` (matching inbox receipts in manifest order), `pending` request IDs, and `nextCursor` for resuming. Other statuses: "read-failed" and "wait-failed" (exit 4), "invalid-arguments"/"file-unavailable"/"invalid-manifest" (exit 2).
