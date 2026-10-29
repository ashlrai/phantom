# Devin usage source

`ashlr devin usage --json` emits one `resource.v1` object for fleet consumers.
This read-only source does not launch sessions, authorize spending or change
connection settings. Run with an existing Phantom Secrets mapping for
`DEVIN_API_KEY` and a non-secret `DEVIN_ORG_ID`:

```sh
phantom exec -- ashlr devin usage --json
```

Never pass a key as a command argument, print it, or store it in repository
configuration. This source reads only the injected environment; it does not
read the Keychain or create tokens. Without credentials it works locally.

The sanctioned API is [organization daily consumption](https://docs.devin.ai/api-reference/v3/consumption/organizations-consumption-daily).
It requires `ViewOrgConsumption`. The source issues one GET with `time_after`
and `time_before` for the last 24 hours. Requests reject redirects, expire after
five seconds, and accept at most 1 MiB of response data. Errors and provider
bodies are never logged. ACUs are organization totals across products, not a
claim of fleet-only or subscription-included usage. Provider daily aggregation
may differ from exact session time; its day boundary is 08:00 UTC.

If credentials, permission, transport or valid API evidence are unavailable,
read `~/.ashlr-runs/metrics/jobs.jsonl`. Each completed-job record has:

```json
{"jobId":"example","lane":"devin","startedAt":"2026-10-26T10:00:00Z","finishedAt":"2026-10-26T11:00:00Z"}
```

Timestamps are ISO date strings. Only `lane=devin` contributes. Intersections
with the last 24 hours are summed in seconds; concurrent jobs each contribute
wall time. Repeated job IDs count once. Old jobs and other lanes contribute
nothing. Malformed, incomplete, reversed or future records mark the result
partial; valid records still contribute. Missing or unreadable files yield
unknown usage, while an empty readable file yields zero. Wall time is never
converted to ACUs.

| Field | Meaning |
| --- | --- |
| `schema`, `lane` | `resource.v1`, `devin` |
| `source` | `acu` or `walltime` |
| `unit` | `acu` or `seconds` |
| `used` | Observed amount, or null when unavailable |
| `left`, `reset` | null: neither source establishes remaining credit or a reset |
| `burnRate` | `used / 24`, or null when unavailable |
| `burnRateUnit` | `acu/hour` or `seconds/hour` |
| `windowStart`, `observedAt` | ISO timestamps bounding the observation window |
| `status` | `ready`, `partial`, or `unavailable` |

Consumers must display unknown quota without a percentage bar. Never interpret
null as unlimited or zero remaining. This checkout contains no Codex resource.v1
contract; this document pins the Devin producer's explicit shape for integration.
