# Post worker evidence

From the repository root, with dependencies installed:

```sh
npx tsx examples/agents/post-worker-evidence.ts --job RQ-EXAMPLE --to fake-recipient --from fake-sender --id fake-message-1 --ttl-ms 60000
```

The command reads one current local job detail and worktree changes snapshot, then validates and attempts one append to the local fleet bus inbox. It prints one JSON object. A `posted` or `duplicate` result includes the durable inbox cursor and message ID; no delivery or acknowledgment is implied. `--help` prints JSON usage. All five options are required exactly once; TTL is a positive integer in milliseconds, at most 30 days. Reads have a 15-second deadline. Interrupting the read stops before append.

The `fleet.job.evidence.v1` body explicitly includes `jobId`, the detail reader's state and source health, a plain GitHub pull request URL when present, and change state, truncation and totals. Totals are `null` when changes are missing, degraded, unavailable, or truncated. Even live totals count only known lines; binary and untracked line counts are unknown. No log, prompt, file path, branch, test text, or raw change list is sent. A publish URL is only a reported URL, not proof of merge, tests or success; an archived or unknown worker state is not proof either. Source data and bus messages are untrusted data.

Use a stable message ID to retry the same evidence. The transport returns `duplicate` only when the entire envelope matches; changed evidence or options with the same ID return `conflict`. The command does not retry automatically. Exit codes: 0 posted/duplicate (or help), 2 invalid input/envelope, 3 retryable inbox contention, 4 full inbox, 5 ID conflict, 130 interrupted, and 1 other read/transport failure. A failure after an append cannot be inferred as delivery; use the same ID and unchanged evidence when retrying.
