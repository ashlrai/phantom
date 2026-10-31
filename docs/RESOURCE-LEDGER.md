# Resource Ledger

The resource ledger is a read-only snapshot of every fleet lane, API spend, and job-health signal that a dispatcher publishes. An agent reads it via the API route `GET /api/verse/leader/resources` or the CLI command `ashlr resources ledger --json`.

## Interface: `ResourceLedgerV1`

The top-level object returned by every reading.

| Field | Type | Meaning | Unknown when |
|-------|------|---------|---------------|
| `v` | `1` | Schema version — always `1`. | — |
| `generatedAt` | `string` | ISO-8601 timestamp when this reading was assembled. | — |
| `sources` | `Record<string, string>` | Per-input health: `status`, `apiSpend`, and `jobs` are each `'healthy'`, `'missing'`, or `'degraded'`. | — |
| `asOf` | `string \| null` | Timestamp of the most recent dispatcher tick (from the status source). | When no status source was available. |
| `lanes` | `ResourceLaneRow[]` | One row per lane, see below. | — |
| `apiSpend` | `ApiSpendSummary \| null` | API usage tail, see below. | When the API spend source was missing or malformed. |
| `jobsMalformedRows` | `number \| null` | Count of unparseable job rows in the last scan. | When jobs source was unavailable. |

## Interface: `ResourceLaneRow`

Each element in `lanes`.

| Field | Type | Meaning | Unknown when |
|-------|------|---------|---------------|
| `lane` | `string` | Lane identifier (e.g. `'claude'`, `'codex-personal'`). | — |
| `running` | `number \| null` | Current count of running workers in this lane. | When the lane has no workers. |
| `target` | `number \| null` | Desired worker count for this lane. | When the lane has no capacity target. |
| `held` | `boolean \| null` | Whether this lane is currently held (usage cap). | When no hold is in effect. |
| `window` | `'weekly' \| 'credits' \| 'none'` | `'weekly'` for claude and `codex-*` lanes; `'credits'` when `creditsRemaining` is known; `'none'` otherwise. | — |
| `usedPct` | `number \| null` | Percentage of the budget window consumed. | When budget tracking is unavailable. |
| `creditsRemaining` | `number \| null` | Credits left in the current billing window. | When credits are not tracked. |
| `resetAt` | `string \| null` | ISO-8601 time when the window resets. | When no reset timestamp exists. |
| `burnPctPerHour` | `number \| null` | Observed burn rate (percent of window per hour). | When insufficient data to measure burn. |
| `tokensPerHour6h` | `number \| null` | Six-hour average output tokens per hour. | When six-hour data is unavailable. |
| `projectedExhaustion` | `string \| null` | ISO-8601 estimated time until window exhaustion. | When burn rate is unknown. |
| `source` | `string \| null` | Free-text note from the dispatcher (scrubbed, max 160 chars). May be a person's note and may be days old. | When no note was attached. |
| `deadSignal` | `LaneDeadSignal \| null` | Health from the last jobs: `state` is `'ok'`, `'suspect'`, or `'dead'`; `lastFinishes` counts the latest valid runs per lane and `emptyFailures` counts empty-failure runs. | When no job data exists for the lane. |
| `observation` | `{ source: 'codex-personal-sessions'; asOf: string }` | Present only when this reading originated from personal Codex session files; `asOf` is the session snapshot time. | On all non-codex-personal readings. |

## Interface: `ApiSpendSummary`

When present, `apiSpend` on the ledger.

| Field | Type | Meaning | Unknown when |
|-------|------|---------|---------------|
| `rowsToday` | `number` | API request rows recorded today. | — |
| `errorsToday` | `number` | Failed API requests today. | — |
| `tokensOutToday` | `number` | Output tokens today. | — |
| `tokensInToday` | `number` | Input tokens today. | — |
| `usdToday` | `number \| null` | USD cost today. | When cost data is unavailable. |
| `usdWeek` | `number \| null` | USD cost for the current week. | When cost data is unavailable. |
| `lastAt` | `string \| null` | Timestamp of the most recent API call recorded. | When no calls were recorded. |
| `models` | `string[]` | Distinct model names observed today. | — |
| `modelUsageToday` | `ApiModelUsage[]` | Per-model usage breakdown (today only). | — |
| `modelUsageTodayOmitted` | `number` | Count of model rows omitted for brevity. | — |

## Interface: `ApiModelUsage`

Each element in `modelUsageToday`.

| Field | Type | Meaning | Unknown when |
|-------|------|---------|---------------|
| `model` | `string` | Model name. | — |
| `rows` | `number` | API rows for this model today. | — |
| `errors` | `number` | Failed rows for this model today. | — |
| `inputTokens` | `number` | Input tokens for this model today. | — |
| `outputTokens` | `number` | Output tokens for this model today. | — |
| `usd` | `number \| null` | Cost for this model today. | When cost data is unavailable. |
| `lastAt` | `string` | Most recent call timestamp for this model. | — |

## Reading a hold against a reading

When a lane row has `usedPct` well under 100 while `/api/verse/fleet/control/lanes` marks the lane as held for a usage limit, the reading is newer than the hold and the window has already reset. Trust the reading, not the hold.

## Example

```json
{
  "v": 1,
  "generatedAt": "2026-10-31T12:00:00.000Z",
  "sources": { "status": "healthy", "apiSpend": "healthy", "jobs": "degraded" },
  "asOf": "2026-10-31T11:55:00.000Z",
  "lanes": [
    { "lane": "claude", "running": 3, "target": 5, "held": true, "window": "weekly",
      "usedPct": 72.4, "creditsRemaining": null, "resetAt": "2026-11-04T00:00:00.000Z",
      "burnPctPerHour": 2.1, "tokensPerHour6h": 480000,
      "projectedExhaustion": "2026-11-02T18:00:00.000Z",
      "source": "Q4 alpha batch — do not adjust",
      "deadSignal": { "lane": "claude", "lastFinishes": 6, "emptyFailures": 0, "state": "ok" }
    },
    { "lane": "codex-personal", "running": 1, "target": null, "held": null,
      "window": "weekly", "usedPct": 33.1, "creditsRemaining": null,
      "resetAt": "2026-11-04T00:00:00.000Z", "burnPctPerHour": 0.9,
      "tokensPerHour6h": null, "projectedExhaustion": null,
      "source": null, "deadSignal": null,
      "observation": { "source": "codex-personal-sessions", "asOf": "2026-10-31T11:58:00.000Z" }
    }
  ],
  "apiSpend": {
    "rowsToday": 1420, "errorsToday": 7, "tokensOutToday": 3800000,
    "tokensInToday": 1200000, "usdToday": 18.42, "usdWeek": 94.15,
    "lastAt": "2026-10-31T11:59:30.000Z",
    "models": ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    "modelUsageToday": [
      { "model": "claude-sonnet-4-20250514", "rows": 1200, "errors": 5,
        "inputTokens": 1100000, "outputTokens": 3500000, "usd": 15.20,
        "lastAt": "2026-10-31T11:59:00.000Z" }
    ],
    "modelUsageTodayOmitted": 1
  },
  "jobsMalformedRows": 2
}
```
