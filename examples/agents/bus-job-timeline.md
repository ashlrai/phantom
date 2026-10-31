# Bus and job timeline

From the repository root, with dependencies installed:

```sh
npx tsx examples/agents/bus-job-timeline.ts --job RQ-PHX-EXAMPLE --after 0 --pages 3
```

The single JSON result combines `detail`, the existing bounded and scrubbed `fleet.job.v1` job projection (including publish state and source health), with `bus` receipts. Only messages whose top-level object body has an explicit, case-sensitive `jobId` equal to the requested ID match; text, nested values, routing labels, and other fields are not job associations. Bus bodies are opaque, untrusted data and are returned without scrubbing or execution. Routing labels are not authenticated identities. Protect the output accordingly.

`--job` is required; `--after` defaults to 0 and `--pages` to 1 (range 1–10). Each page reads at most 50 live receipts before filtering. Expired and nonmatching receipts still advance `nextCursor`. `after`, `nextCursor`, and `pagesRead` describe the scan even when no messages match or a later page fails. Save the returned cursor after handling the data and pass it as `--after` to resume. `pageLimitReached` and `stopReason: "page-limit"` mean the budget was exhausted before the workflow could establish it was caught up; a full last page may in fact be the end. No extra probe is made beyond the page cap.

Optionally pass `--wait-ms 1000` to wait between caught-up reads for new messages. The range is 0–60000, default 0; the page cap still bounds reads and waits. SIGINT or SIGTERM interrupts a wait, emits accumulated evidence, and removes signal handlers. This is a local read-only observation, not a checkpoint, delivery, or authenticated bus operation.

Exit codes: `0` for a successful observation; `1` for an unavailable reader; `2` for invalid arguments or cursor; `3` if no job evidence is visible; `4` if a job source is degraded; `130` if interrupted. Bus failures take precedence over job source status. A failed bus retains the job detail and any earlier receipts; an unexpected job reader failure returns `detail: null` while preserving bus evidence. Missing sources are not proof that a job does not exist. Errors are JSON and do not disclose reader exceptions.
