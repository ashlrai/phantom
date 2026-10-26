# Development loop metrics

Run `phm fleet loop --json` with an authenticated `gh` CLI to refresh `loop.v1`
development-loop observations. The command reads GitHub and local evidence,
updates only `fleet.json`'s `loop` key, and emits aggregate PostHog events when
configured. It creates a missing fleet file; it refuses to overwrite malformed
or unsafe existing state. Exit 0 means complete sources and successful or
disabled telemetry; exit 1 means partial data, failed telemetry or a failed
refresh; exit 2 means invalid arguments. Partial reports remain useful JSON.

The seven repositories match the coding fleet: `ashlrai/phantom`,
`ashlrai/phantom-secrets`, `ashlrai/locus`, `ashlrai/lexicon`, `ashlrai/ashlr-md`,
`ashlrai/ashlr-stack`, and `ashlrai/ashlr-plugin`.

## Sources and paths

| Variable | Default | Input |
| --- | --- | --- |
| `PHANTOM_FLEET_PATH` | `/workspace/phantom-work/fleet.json` | Fleet snapshot and spend evidence; loop output |
| `PHANTOM_ROUTER_QUEUE_PATH` | `router-queue.md` beside fleet.json | Queue claim timestamps and agents |
| `PHANTOM_CI_TIME_PATH` | `ci-efficiency/ci-time-per-pr.jsonl` beside fleet.json | Per-head CI totals |

Files must be bounded regular files in owned, non-writable-by-others directories;
symlinked or writable-by-others fleet files are refused. Reads are limited to
8 MiB. Writes use private atomic replacement and preserve other fleet fields.
The fleet snapshot is re-read after network requests to retain unrelated updates.
This is a snapshot writer, not a transaction with other processes: concurrent
writers must coordinate if they also update fleet.json.

GitHub reads paginate PR lists, lifecycle timeline events, reviews, head check
runs (including reruns), and head commit statuses. Each endpoint has a ten-page
cap and each `gh` process has a 15-second timeout and a 4 MiB output limit.
Caps, malformed responses and read failures make sources incomplete. No GitHub
mutation is performed. PR bodies and review/comment bodies are never selected.

Queue tables use these header names (spaces or hyphens also work):

```markdown
| repo | pr | task | queued_at | claimed_at | agent |
| --- | --- | --- | --- | --- | --- |
| phantom | #12 | RQ-EXAMPLE-1 | 2026-10-25T08:00:00Z | 2026-10-25T08:30:00Z | codex-1 |
```

`pr` can be a number, `#number`, or a GitHub PR URL. A task-only row can match
an exact branch path segment. Ambiguous claims remain unattributed. Queued work
can have an empty `claimed_at`; incomplete stages then have null durations.
Timestamp columns require ISO timestamps, not relative prose or inferred times.

The additional CI file contains one JSON object per line:

```json
{"schema":"ci_time.v1","repo":"ashlrai/phantom","pr":12,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","recorded_at":"2026-10-25T11:00:00Z","duration_ms":120000}
```

`ci_time_ms` is accepted as an alias for `duration_ms`, and `ts` for
`recorded_at`. Only exact repo/PR/head matches count. The newest matching record
is retained in `prs[].ci_ledger_ms`; tied conflicting records are unknown.
The GitHub check sum takes precedence; the ledger supplies a fallback, never an
additional check to double-count.

## Measurements

The population is all currently open PRs plus PRs merged during the last seven
days. Merged outcome counts and revert rate use only that seven-day cohort.
Each stage reports its sample count and nearest-rank p50/p90 in milliseconds:

| Stage | Duration |
| --- | --- |
| `queue_wait` | Claimed minus queued from the queue table |
| `agent` | PR opened minus claimed |
| `ci` | Sum of check durations on the PR head SHA, including reruns and overlapping jobs |
| `review` | First approval or successful CodeRabbit check/status after ready, minus ready |
| `merge` | Merged minus ready |

Ready comes from the first lifecycle transition, or PR creation when evidence
shows it started non-draft. Missing timeline pages prevent readiness inference.
CodeRabbit passes require its app identity or its bot's successful commit status;
comment prose is not interpreted as a pass. Unknown, backwards and future
timestamps do not produce duration samples. Running checks keep CI totals unknown.

`bottleneck` selects the stage with the largest observed p90; it is provisional
when sources or eligible stage samples are incomplete. These are historical observed durations, not an
active-stage aging estimate. Merge latency includes time spent in CI/review;
the five stages overlap and must not be summed into a cycle time. Null means
unknown or no denominator, never zero. `sources` identifies incomplete reads.

Revert rate counts merged PRs whose titles start with “Revert” divided by merged
PRs in the window. It does not detect direct revert commits or reverts with
unrelated titles. This basis is explicit in `revert_rate.basis`.

## Dollars and Grok Ultra points

Quota percentages, fractional usage and generic `pool-unit` costs cannot establish
dollars or points. Provide explicit window-scoped evidence under fleet.json's
`spend` key:

```json
{
  "spend": {
    "complete": true,
    "window_start": "2026-10-19T12:00:00Z",
    "window_end": "2026-10-26T12:00:00Z",
    "entries": [
      {"at":"2026-10-25T09:00:00Z","pool":"grok-ultra-weekly","usd":2,"points":10,"repo":"ashlrai/phantom","pr":12,"agent":"grok-worker"},
      {"at":"2026-10-25T09:00:00Z","pool":"codex-cmp","usd":3}
    ]
  }
}
```

The complete ledger covers all consumed work in the seven-day window, including
work that did not merge. A seven-day snapshot ending at most five minutes before
collection supplies the report's reproducible window; `generated_at` records
collection time. Stale, future or misaligned spend stays unknown. Alternatively,
every unique, non-shared pool can provide `id`, `complete:true`, `window_start`,
`window_end` and `spend_usd`; this supplies dollars only.

Outcome per dollar is merged PRs divided by pool spend USD. Grok Ultra points per
merged PR uses total consumed points divided by that same merged cohort. Agent
breakdowns attribute points to explicit consuming agents, or an unambiguous queue
claim for the referenced PR. Their denominators count merged PRs linked to that
agent's spend. Unlinked points remain in `unattributed_points`; missing values
and zero denominators stay null.

## Telemetry and panel

Set `PHANTOM_POSTHOG_TOKEN` to the existing PostHog project token to emit five
`phantom_loop_stage` events and one `phantom_loop_bottleneck` event per refresh.
`PHANTOM_POSTHOG_HOST` accepts `https://us.i.posthog.com` (default) or
`https://eu.i.posthog.com`. No token means telemetry is disabled. Requests have a
five-second timeout and refuse redirects. The payload contains only the schema,
window length, completeness, stage names, sample counts and timing aggregates;
it contains no PR bodies, identifiers, agent names, paths, or secrets. The project
token is sent only to the configured ingest host and never included in output.
The batch format follows the [PostHog HTTP API](https://posthog.com/docs/getting-started/install).

Dashboard PR #939 was closed without merging when this implementation was
prepared. The report therefore includes a serializable `panel` with stage rows
and the bottleneck for a future dashboard consumer.
