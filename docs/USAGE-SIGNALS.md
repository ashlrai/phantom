# Event-driven operations usage readings

## Hourly Mac refresh

`contrib/mac/com.ashlr.usage-hourly.plist.in` is a launchd template for a
signed-in Mac pool. Fill its placeholders with XML-escaped absolute paths to
Node, the built `dist/cli/usage-signal.js`, the private operations directory,
the private reader configuration, HOME and a PATH containing Phantom Secrets.
Provision all five read-only readers first, then install the rendered plist in
the user's LaunchAgents and load it with launchctl. The template runs at load
and every 3600 seconds; it does not launch a model or consume Grok usage.
The hourly event refuses non-macOS hosts, partial reader configurations and
pool overrides. It uses the same per-pool 30-minute debounce and lock as events.
Installation and provisioning are not performed by a repository merge.

Grok still requires a verified current usage surface and an available signed-in
session. An absent or unverified surface yields unknown, not a numeric reading.
The reader's original weekly reset pin expires, so a fresh verification is needed
after that reset. Do not treat an unknown row as evidence of remaining quota.

The operations bridge can invoke this one-shot entrypoint on `dispatch-start`,
`pr-merge`, `429`, `limit-message`, `manual-reading`, or `hourly`. The entrypoint
never starts a watcher, interval or trailing debounce timer. Producers invoke it;
the daemon's protected dispatch and merge hooks are not changed by this feature.

From a source checkout:

```sh
npx tsx src/cli/usage-signal.ts --directory /absolute/private/ops \
  --event dispatch-start --readers /absolute/private/usage-readers.json
```

After compilation, use `node dist/cli/usage-signal.js` with the same options.
Without `--pool`, all five pools are selected. Repeat `--pool` to select a subset:
`grok-ultra`, `codex-personal`, `claude-max`, `terra`.

The store must be an owned canonical directory with mode 0700. Existing
`fleet.json` and `usage-readings.log` files must be owned regular files with mode
0600 and one hard link. Symlinks are refused. Use a dedicated operations store,
separate from native provider profiles. Existing unrelated fleet fields are preserved.

## Reader contract

`--readers` names an owned 0600 JSON file mapping pool IDs to absolute paths of
operator-provisioned read-only reader executables. No shell strings, arguments,
keys, cookies or tokens belong in that file. Each selected, eligible reader runs
as `phantom exec -- /absolute/reader`, with only PATH, HOME, TMPDIR, LANG and LC_ALL
inherited. Phantom Secrets owns any credential resolution. Readers must inspect
only already-authorized usage surfaces, never sign in, copy browser credentials,
read Codex auth files, submit forms or change provider state.

The external Phantom Secrets `phantom` executable must already be on PATH. This
entrypoint does not install it or create credentials. Reader wrapper scripts
should replace themselves with their reader process so the deadline owns that
process, rather than spawning detached work.

Each executable returns one JSON object on stdout:

```json
{
  "pool": "grok-ultra",
  "pctUsed": 68,
  "resetAt": "2026-11-02T01:21:00.000Z",
  "source": "grok-reader",
  "fetchedAt": "2026-10-26T20:46:00.000Z"
}
```

This is a synthetic protocol example, not a live reading. Percentages must be
finite and between 0 and 100. Dates use canonical UTC ISO timestamps. Readings
must be less than 30 minutes old and cannot be future dated. Missing, malformed,
wrong-pool, failed or unavailable readers produce null usage, never zero capacity.
Sources are assigned by the writer; extra reader fields and error text are discarded.
Reader processes have a 15-second deadline and an 8 KiB output cap. No provider
reader is enabled by default. The Grok dependency's returned reading fits this
contract; its optional log append must be disabled so this writer owns journaling.
Its verified-page requirement still applies. Personal Codex needs an explicitly
provisioned reader; Terra needs a separate explicit reader. Existing CMP journal
rows retain their historical identity and cannot supply personal Codex capacity.

## Persistence and signals

Debounce is a leading-edge rolling 30-minute window per pool, across event types,
process restarts and concurrent bridge invocations. Suppressed events do not run
readers or append readings. A cross-process lock protects the journal and snapshot.
Busy invocations fail closed with a nonzero exit; the bridge can retry the event.
There is no background retry loop. Backward clock changes stay suppressed until
the recorded window expires.

Each accepted reading appends one JSONL record to `usage-readings.log` before
updating `fleet.json.readings[pool]`. A later event repairs an interrupted snapshot
from the journal without rereading a debounced pool. Torn or malformed journals
fail closed. Store files are capped at 8 MiB; archive/rotate the store during a
controlled stop, retaining the latest record per pool to preserve debounce and
cut state. All writers of this dedicated store must use the same lock.

`burnRatePctPerHour` is the nonnegative percentage-point change per elapsed hour
between two numeric readings with the same known reset. A decreased counter,
changed/unknown reset or unknown reading gives null burn and projection. A
positive burn produces `projected100At` only if exhaustion precedes the reset.
Flat usage below 100% has zero burn and no projection. A comparable 100% reading
uses its observation time as the exhaustion time. These are linear estimates.

At Grok usage >=80%, stdout `signals` contains a `cut` transition and
`fleet.json.usageSignals["grok-ultra"]` persists the active signal. The bridge
must consume that signal to stop routing work to the pool. The writer does not
alter scheduling authority. Subsequent high readings do not emit duplicate
transitions. Unknown readings retain the active cut; a numeric reading below
80 clears it and rearms the next transition. After a crash, use the persistent
signal rather than relying solely on stdout delivery.

## Two-hourly router append (built-in status readers)

For the router's 2-hourly pool readings, `--status-readers` replaces `--readers` with
built-in readers that run no operator executables:

```sh
npx tsx src/cli/usage-signal.ts --directory "$HOME/.ashlr-runs" --event manual-reading \
  --status-readers --codex-personal-home /absolute/personal/pool/home --dry-run
```

`--dry-run` runs the readers and prints the rows that would be appended (`preview`)
without touching `usage-readings.log` or `fleet.json`; drop it to append. Only
`codex-personal` (Codex App Server rate-limit read with fixed argv and an explicit pool
HOME) and `claude-max` (Phantom's own sanitized `rate_limit_event` store, `utilization`
as a 0..1 fraction) are read. No `~/.codex`, `~/.claude`, auth file, keychain or
environment is read, nothing calls login/logout, and only numeric fields are logged.
Other pools stay unread; the 30-minute debounce makes a 2-hour cadence safe.

## Live usage tracker

`phm usage live` keeps usage, limits, resets and alerts current. One pass by
default; `--watch` repeats and wakes ten seconds after the earliest `reset_at`
it has read, never later than `--interval` (60 to 3600 seconds, default 300).

1. Official readouts first: Devin's org API, the Codex App Server, Claude's
   rate-limit status and Phantom's own accounting (the same pull as
   `phm usage sensors --refresh`).
2. With `--browser`, a lane that has no official readout is read from its usage
   page in one persistent profile under `~/.ashlr-runs/usage-browser/`:
   claude.ai Settings > Usage, ChatGPT Codex usage, Devin billing, z.ai and
   Google AI Studio. Only the rendered visible text is parsed, and only
   `NN% used` or `N of M ACUs` shapes. The driver is Playwright, loaded only
   when installed; without it the pass is official readouts only. Add
   `--headed` once to sign in, the normal way, in that browser. The driver has
   no cookie, token, storage or keychain access and refuses a profile outside
   the usage browser directory or inside a Codex home. A page that shows a
   sign-in is recorded as a needs-signin item with its exact URL and the pass
   continues.
3. Output, all in the queue directory (`--queue-dir`, default `~/.ashlr-runs/queue`):
   `usage-live.json` (a `usage.sensors.v1` snapshot, readable by
   `phm usage sensors --file`), `usage-live-budget.json` (lane entries in the
   status.json budget shape: `weekly_used_pct`, `reset_at`, `source`,
   `burn_pct_per_hour`, `projected_exhaustion`, plus `estimated`, which is true
   for anything scraped or derived) and `usage-live-state.json` (alert dedupe).
   Alerts append to `usage-live-alerts.jsonl` in the bus directory (`--bus-dir`,
   default `~/.ashlr-runs/bus`): `cap-80`, `cap-95` and `expire-unspent`, each
   once per reset window, plus `needs-signin` once per site per day. The first
   pass writes `usage-live-first-readings.md` there, including the sites that
   need a one-time sign-in.

A relative reset such as "in 2 hr 15 min" is re-derived on each pass, so a new
instant within ten minutes of the earlier one keeps the earlier one. Unknown
stays unknown: a page with no matching numbers produces no reading and never a
zero. The `browser-visible` source is estimated, not provider-official.

## Live resource sidecar

`phm usage resource-live` reads every allowance and writes
`~/.ashlr-runs/state/resource-live.json` (`resource-live.v1`). It is the only
writer of that file. The Eng Ops `ai.ashlr.resource-pool` builder merges it
into `state/resource-pool.json` and stays the only writer of that one, so the
two never race. The sidecar is replaced by rename, and a lock file beside it
keeps two passes from overlapping.

Allowances: Claude weekly, the Claude Fable share, the Claude API included
credit, Codex personal, Devin, Devin Flash, GLM Lite, Gemini,
Antigravity, Dot, Instinct, local models, Grok and Cursor.

Sources are tried in order and the first current reading wins:

1. `official`: the provider's own API or CLI status, through the readers
   above. Claude weekly comes from `metrics/claude-quota.json`, the Fable share
   from the Fable weekly sensor file, Codex from the App Server on an explicit
   pool home (`PHANTOM_SENSOR_CODEX_PERSONAL_HOME`), Devin from the org API, the Claude
   API credit from the grant store (`PHANTOM_RESOURCE_LIVE_ACCOUNTS_ROOT`),
   Grok from its runway store, local models from loopback `/v1/models`.
2. `own-call`: rate-limit data returned to calls Phantom already made. That is
   the Claude `rate_limit_event` store and the GLM Lite window in
   `queue/resources.json`.
3. `visible-window`: with `--browser`, the rendered text of the usage page in
   the dedicated usage browser, as in the live usage tracker above.

A reading older than 15 minutes is kept only when no later source has a
current one. Devin Flash, Antigravity, Dot, Instinct and Cursor have no
supported source yet.

Every reading records `source`, `source_tier`, `observed_at` and
`stale_after`. An allowance with no verified reading has `verified: false`, a
fixed `reason` and null for every number. It is never zero. No credential,
cookie, keychain item, app database or TCC store is read, and no path under
`~/.codex*`.

Cadence under `--watch`: an allowance whose lane is running jobs (from
`queue/status.json`) is read about every 60 seconds. A reading that did not
change doubles the wait, up to 10 minutes. An idle lane waits 10 minutes, and
is read within a minute once it becomes active. An allowance is read again as
soon as its `reset_at` passes. `--force` reads everything now. `--show` prints
the stored sidecar and reads nothing else.

### Burn-down plan

`burn_down` in the sidecar paces each allowance to about zero at its deadline:
`target_rate_per_hour = remaining / hours_to_deadline`, where the deadline is
the reset or a fixed expiry, whichever comes first. `observed_rate_per_hour`
comes from readings in the same window, and `pace` is `behind`, `on-pace` or
`ahead` within 15 percent of the target.

Spend order, in `lane_order`:

1. Free and expiring: Dot, local models, and Devin Flash through Nov 30.
   After its end date an expiring allowance ranks
   with the included ones.
2. Included subscriptions, most urgent first (largest share of the allowance
   that must be spent per hour).
3. The Claude API, only up to its included credit.
4. Reserve lanes: Grok and Cursor.

The plan orders and paces. It does not set slots: lane targets, floors and
ceilings stay with their owners, so a steady-load rule keeps its share. An
allowance with no current reading is `steady`, which means existing rules
apply unchanged. Two cases are `hold` and drop the lane from `lane_order`: an
allowance used up until its reset, and the Claude API when its included credit
is spent or cannot be verified, because past that point every call is new
spend.

### Consumers

- The world model reads the sidecar on each build, so `GET /api/verse/world`
  and the desktop resource bar's lane rows show used, remaining, reset, source,
  observed time and freshness, plus `pacePerHour`, `requiredPacePerHour` and
  `runwayHours` from the plan. A reading past `stale_after` shows as stale and
  is not headroom.
- The fleet scheduler's pace input (`planLanes`) takes the same readings, so a
  lane is narrowed from live remaining and reset values.
- The dispatcher reads the plan only through the merged pool file. That change
  is a Security package draft in `handoff/RQ-RESOURCE-LIVE-1/`.

### Reset rule

The reset rule only drafts a decision. No agent clicks a reset.

- Fable reset: Fable is at or above 95 percent of its share with more than 24
  hours before the weekly reset.
- Weekly reset: the weekly allowance is at or above 95 percent with more than
  24 hours left.
- Never both inside one week unless both are exhausted. When both cross 95
  percent in one pass and they are not both exhausted, only the weekly reset
  is drafted.

When it fires, one file is written to `~/.ashlr-runs/bus/masbot/`
(`resource-live.reset-decision.v1`, `audience: mason-only`,
`agent_may_act: false`) covering every draft from that pass. It fires once per
weekly window.

## Self-maintained lane budgets (no human reading)

`src/cli/usage-self.ts` is a one-shot refresh that keeps `weekly_used_pct`, `credits_remaining`,
`reset_at`, `source`, `estimated` and `as_of` fresh for claude, codex-personal, devin, zai, gemini
and omlx in `queue/budget-overrides.json`, the file dispatchd copies into `status.json` `budget`.
`contrib/mac/com.ashlr.usage-self.plist.in` runs it every 10 minutes (installing it is an operator step).

```sh
npx tsx src/cli/usage-self.ts --runs-dir /absolute/runs --codex-personal-home /absolute/personal/pool/home --dry-run
```

Per lane, in order: a sanctioned reading, then an estimate, then unknown.

| Lane | Sanctioned reading | Estimate when none |
| --- | --- | --- |
| claude | Phantom's parsed `/usage` reading (`metrics/claude-quota.json`), else its sanitized `rate_limit_event` store | last reading plus `jobs.jsonl` tokens, weekly reset rolled forward 7 days |
| codex-personal | Codex App Server `account/rateLimits/read` with an explicit pool HOME (`--codex-personal-home`; no `~/.codex*` path is accepted) | same as claude |
| devin | org cycle ACU reader (`devin-api-v3-org-cycle`) | last reading plus `acus` from `jobs.jsonl`; the next cycle end is unknown, so `reset_at` becomes null |
| zai | the `zai` row of `queue/resources.json` while fresh | 10 000 credits per week from `docs/lanes/zai.md`, credits computed from `jobs.jsonl`, reset Monday 00:00 UTC |
| gemini | none verified | none: all numbers null, `source: unknown:no-sanctioned-reader` |
| omlx | loopback `/v1/models` model count (capacity only, no percent, no reset) | none |

Rules: a reading is re-read when missing, estimated, older than 30 minutes, or past `reset_at`. A fresh
non-estimated entry from any other writer is kept. Estimates set `estimated: true` and are calibrated
only from data (units per percent derived from the last reading), never from an invented limit; with no
calibration the percent stays null and the autopilot holds the current target. Jobs without token or ACU
counts are reported in `unmeasured_jobs`, so an estimate is then a lower bound. Only the fields above are
rewritten; other keys in a lane block (`allowance`, `gift`, `compact`) are preserved.

`phm resources autopilot --overrides FILE` gives a quota lane with no usable reading its budget entry,
so an estimate keeps the lane paced instead of held. The zai, gemini and omlx entries reach `status.json`
only after the dispatchd change staged in `contrib/mac/staged-pin/RQ-USAGE-SELF-2-dispatchd.md` is pinned by Security.
