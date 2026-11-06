# Grok Ultra runway

Record the remaining **points** displayed by the signed-in app with
`phm fleet grok-usage`. The current supported source is manual entry. No safe
automatic local source was verified in the installed apps on October 26, 2026.
This change does not claim live collection or install a background service.

## Record and inspect

From the repository, use `npm run dev -- fleet grok-usage` instead of
`phm fleet grok-usage` when running from source. Node 22.15 or newer and the
repository dependencies are required.

The shared file defaults to `/workspace/phantom-work/fleet.json`. On a Mac,
set `PHANTOM_FLEET_FILE` to an absolute path ending in `fleet.json` in an
owned directory. Use the same setting for the CLI and the Phantom remote
server. Existing files and directories must not be writable by other users;
symlinks and hard-linked files are refused. The writer creates missing
directories with mode 0700 and the file with mode 0600.

The following **writes local usage history**. Replace the illustrative
numbers with points actually shown in the app; do not convert dollars,
percentages or model tokens into points:

```sh
phm fleet grok-usage record --remaining-points 800 --total-points 1000
```

`--at 2026-10-26T12:00:00.000Z` records an earlier observation time. It must
be a canonical UTC ISO timestamp, no later than now, and newer than the last
reading. Identical retries are idempotent. A conflicting or older timestamp
is rejected; invalid history is never silently replaced. `--json` provides
machine-readable output. Inspect without writing or sending telemetry:

```sh
phm fleet grok-usage status --json
```

The Fleet surface displays the same history through authenticated
`GET /api/verse/fleet/grok-ultra`. The remote gateway permits only that exact
GET path without query parameters. It exposes the latest numeric reading and
computed runway, never the surrounding fleet document, local paths, claims,
messages or app state. It has no web mutation endpoint. The tile refreshes
every 30 seconds while visible; that refresh does not create a reading.

## Persistence and calculations

`fleet.json` gains a namespaced `grokUltra: { v: 1, readings: [...] }`
extension. Every reading contains only `source`, `timestamp`,
`remainingPoints`, and `totalPoints`. Manual entries use `source: "manual"`.
The contract reserves `"app-local"` for a future verified adapter; no current
command can claim that provenance. Other top-level fleet fields survive writes.
There is no invented `fleet.v1` envelope in this branch: the parent fleet
dashboard work is not present in its base.

Writes use the existing local-store locking and durable atomic-file utilities.
All writers updating this shared document must acquire
`<fleet-directory>/.fleet-locks/fleet.json.lock` and preserve other fields;
an uncoordinated writer can overwrite this extension. The file is bounded to
2 MiB and history to 10,000 readings. At the bound, recording fails without
pruning history. Unknown/corrupt history requires operator inspection and
reconciliation before further writes.

Burn is points per hour over the full preceding 1, 6 and 24 hours, ending at
the latest observation. The left boundary is linearly interpolated between
readings; sparse manual observations therefore produce an average, not
minute-level usage. Insufficient history stays unknown. A balance increase,
capacity change or provenance change starts a new segment, so no rate crosses
a suspected replenishment or source change. A replenishment hidden between
manual readings cannot be detected; record promptly around resets.

The deadline is **Sunday, November 1, 2026 at 8:21 PM America/New_York**, or
`2026-11-02T01:21:00.000Z` (EST after the clock change). Each available rate
projects remaining points from the latest observation to that deadline.
Negative values retain the predicted shortfall. Ideal pace is remaining
points divided by hours from the observation to the deadline. Projections
stop after the deadline. A reading older than 20 minutes (two intended
10-minute sampling intervals) is stale: its balance and timestamp remain
visible, while rates, ideal pace and forecasts are withheld.

## PostHog

After persisting a manual reading, the CLI sends
`phantom_grok_ultra_runway` only when an existing public ingestion project key
is provided through `PHANTOM_POSTHOG_PROJECT_KEY`. No credentials are minted,
discovered or copied from either app. `PHANTOM_POSTHOG_HOST` accepts only
`https://us.i.posthog.com` (default) or `https://eu.i.posthog.com`.
The [PostHog public capture API](https://posthog.com/docs/api) is used with a
five-second timeout, refused redirects and no person profile processing.

Properties contain points, timestamps, provenance, state, ideal pace and
the three burn/projection pairs. Missing values are null. The distinct ID
is the fixed pool identifier `phantom-fleet-grok-ultra`; no user or account
identifier is sent. A stable event UUID permits an identical reading retry
without creating a new logical event. No automatic retry occurs. CLI output
reports `sent`, `disabled` or `failed`; an emission failure exits 1 but retains
the successfully saved reading, which can be retried with the same `--at`.
Status and dashboard reads never send telemetry. Live ingestion requires
existing operator configuration and has not been verified by this change.

## Why automatic collection is unavailable

Read-only inspection on the Mac found these boundaries:

| Evidence inspected | Finding |
| --- | --- |
| Grok Bot 0.75.8 shipped `app.asar`, SHA256 `7d6fe1a476e2c575c11429772959728333eb9d3d442f71f89bbd9c6f180dd779` | Renderer `index.eager-app-BPR02W4s.js` constructs `usageSummary` through an in-memory observable calling `desktop.getCursorUsageSummary()`, without a persistence adapter. |
| Shipped `dist/electron-main/main-app.cjs` | `fetchSandUsageSummary` calls authenticated DashboardService methods, including `getSandUsageStatus` and `getCurrentPeriodUsage`, through `getValidAccessToken`. Replaying them externally would require access to app credentials. |
| Electron preload bridge and developer route table | Usage is exposed internally through Electron IPC. No credential-free local usage HTTP route was found; developer control is restricted to unpackaged applications. |
| `desktop-status.json` keys and writer | Only version, PID, app version, start time and sign-in state; no points. |
| Cursor global and five workspace `state.vscdb` key-name queries | No usage/quota key names matched. Values were not selected. This is bounded discovery, not proof that every possible cache is absent. |
| Existing Phantom Grok native probe | Provides percentage/reset metadata rather than Ultra points, and native startup can refresh authentication/settings. It does not satisfy strictly read-only local collection. |

No browser or app was launched. No cookies, authentication stores, encrypted
gateway descriptor, credential values, or mixed SQLite values were read.
No endpoint was called and no credentials were created. Chromium caches and
mixed local/session stores were not scraped because they can contain session
material. Manual entry is the deliberate fallback, not a claim of zero usage.

Automatic ten-minute sampling remains unavailable until an app supplies a
verified usage-only local file or a credential-free, read-only local method.
That adapter must preserve the provider observation time, distinguish stale
cache data, validate point units and account/pool binding, label actual
observations `app-local`, and use the shared store lock. A ten-minute timer
must never replay a manual observation with a fresh timestamp. No daemon or
launchd configuration was changed for this fallback.
