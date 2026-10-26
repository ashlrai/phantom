# Coding pool cost feed (#933)

The #933 spend extension is a version 1 metadata contract in
`src/core/observability/coding-cost-feed.ts`. This checkout had no prior #933
record or coding pools dashboard. Producers supply one `spend` record per
**incremental** usage observation, with a stable `recordId`, logical `taskId`,
`attemptId`, `repo`, `pool`, `taskClass`, `engine`, `model`, UTC `timestamp`,
`tokensIn`, `tokensOut`, `costUsd`, and `costBasis`. Set unavailable counts and
cost to `null`; costBasis is `reported`, `estimated`, or `unknown` (null cost).
Never infer a model, task class, token count or subscription dollar charge.
Use `unknown` as an explicit dimension when attribution is unavailable.

Supply a `merged` record with `repo`, `prNumber`, UTC `timestamp`, and all
contributing `taskIds` when a trusted merge observation arrives. Both record
types require `schemaVersion: 1` and `kind`. Include failed/retried attempts,
review and repair usage in the task's spend. Do not send cumulative snapshots
as incremental spend. Task IDs are scoped to a repo and may belong to one PR;
split work into separate task IDs when it produces multiple PRs.

Run the offline adapter against a complete JSONL snapshot:

```sh
npx tsx src/cli/coding-cost-feed.ts /path/to/spend-events.jsonl > /tmp/coding-cost-feed.json
```

Output includes `byTaskClass` (repo/pool/class/engine/model), `byMergedPr`
(repo/PR plus dimension groups), and `posthogEvents`. Totals are known
subtotals, accompanied by missing-token, missing-cost and estimated-cost
counts. `missingTasks` identifies merged tasks with no spend records. Reward
consumers must inspect coverage before treating a subtotal as complete cost;
this feed does not grant routing or merge authority. No time filter runs before
the PR join, so historical attempts remain in the cost of a newly merged PR.

Identical replay records collapse. Conflicting record IDs or PR observations,
and a task attributed to multiple PRs, fail the entire feed. The JSONL adapter
prints only a fixed error on invalid input. Records reject extra fields.
Do not put prompts, responses, paths, user identities or credentials in metadata.

`coding_spend_recorded` events account for total spend;
`coding_merged_pr_spend` events attribute each spend observation to a PR at its
merge timestamp. Do not add these event families together. Stable top-level `uuid`
values deduplicate replay at capture; persist sent IDs in a durable uploader
outbox rather than relying on indefinite server deduplication. Late spend adds
new events without replacing cumulative snapshots. Corrections to previously
sent records require reconciliation, not a new record ID for the same spend.
See [PostHog's duplicate-event contract](https://posthog.com/docs/data-pipelines/troubleshooting#why-am-i-seeing-duplicate-events).

[posthog-coding-pools.json](posthog-coding-pools.json) is a dashboard recipe:
create each tile as a saved insight, then attach it to a dashboard. It contains
[PostHog SQL query nodes](https://posthog.com/docs/sql), with a 30-day display
window and explicit coverage columns. It is not an API dashboard-create payload.
Its [JSON Schema](posthog-coding-pools.schema.json) is validated in Vitest using
the existing MCP SDK validator; no new dependency is needed.

The adapter performs no network calls and reads no keys. A separately authorized
uploader must use **Phantom Secrets `phantom exec -- <uploader> ...`** for all
PostHog credentials and Locus for account access. Never resolve a raw key into
this process, a file, shell substitution, CLI argument, or report. No live
capture or dashboard provisioning is required to compute or test the feed.
