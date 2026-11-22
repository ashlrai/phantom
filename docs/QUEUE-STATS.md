# Queue statistics

`phm queue stats --json` reads the local metadata journal at
`$ASHLR_HOME/queue/visits.jsonl` when `ASHLR_HOME` is an absolute path, otherwise
`~/.ashlr/queue/visits.jsonl`, and
returns station and pool aggregates for sliding
1 hour, 24 hour and 7 day windows. `--window <seconds>` selects one window.
The command is read-only and requires no service or credentials. Missing journals
produce empty groups; malformed records fail explicitly without echoing contents.

`GET /api/queue/stats?window=<seconds>` serves the identical payload to the
operator console (the Fleet Dashboard station graph polls it). It is a
read-authority route like `/api/pulse`: the server boundary requires a read
session, and the handler is read-only.

Producers can call `recordQueueVisit` from `src/core/queue/journal.ts` with an
opaque visit `id`, `station`, `pool`, and epoch-millisecond `arrivedAt`. Append a
snapshot with `startedAt` when service begins and `completedAt` when it ends.
All snapshots for a visit must retain the same arrival time, station and pool;
the last appended snapshot wins. A retry or station transfer gets a new visit ID.
Do not put prompts, credentials or task descriptions in these labels. Existing
fleet events do not contain these timestamps: producers must record visits before
the estimator can report them. The journal currently has no automatic retention.

`phm queue visits-sync` is the fleet producer: it folds `metrics/jobs.jsonl`
and the live `- READY` rows of `queue/router-queue.md` into visits and appends
new or progressed snapshots to the journal. Dry run by default; `--apply`
writes, `--json` prints a `queue.visits-sync.v1` report, and `--jobs`,
`--queue`, `--journal` override the default paths. The resident daemon runs
the same fold (`syncQueueVisits` in `src/core/queue/visit-sync.ts`) as a
`visit-sync` off-tick job on the self-improvement cadence, so the journal
stays fed without a manual pass; it reads the newest bounded tail of the jobs
ledger like the sibling evidence syncs and reports its health in the tick's
off-tick job list. Re-running is idempotent:
a visit appends again only when it gains a transition, and a candidate less
complete than the journal's latest snapshot is refused.

Station mapping (visit id `<job>:a<attempt>`, pool = the launch lane):

- **READY** — queue dwell. Arrival is the earliest `enqueue`/`queued` stamp
  or `launch_failed` receipt with `action=retry` before the attempt's launch
  (attempt 1 also accepts enqueue stamps; later attempts only retry receipts);
  departure is the `launch` stamp, with `startedAt === completedAt` because
  dispatch service is instantaneous. Jobs still listed `- READY` in
  router-queue.md with zero recorded launches produce open visits (arrival
  from the ledger enqueue stamp or the line's `enq=` epoch-seconds token). A
  job resolved `DONE-NOOP` before any launch completes its READY visit at the
  outcome stamp.
- **claimed** — `launch` to the first of `finish`, `publish` or a matched
  terminal outcome; service starts at launch (dedicated worker), so `wait` is
  zero and `rho` measures mean concurrency.
- **publish** — `finish` to `publish` (or an outcome `PUBLISHED` row); a
  finish without publish stays open as publisher-slot WIP.
- **pr-ci** — `publish` to `ci_complete`, a matched `MERGED`/`CLOSED` outcome,
  or stays open; `ci_start` is the service start when the ledger carries it,
  otherwise the whole dwell reports as wait.
- **merge-queue** — `ci_complete` to `MERGED`/`CLOSED`; needs the CI boundary,
  otherwise absent.
- **merged** — zero-dwell marker at the merge stamp for throughput.

Known gaps stay unknown: `planned`, `released`, `fix-main`, review and release
stations have no ledger boundaries; re-queued attempts (a second launch after
a non-launch-failure requeue) have no recorded re-arrival, so their READY wait
is not emitted; `checkout`, `model` and check phases inside claimed/pr-ci are
not split. URL-bearing outcomes match the attempt that published that PR;
URL-less outcomes follow the dispatcher's current-attempt rule.

Windows are half-open `[now - window, now)`. Arrivals divided by window seconds
are `lambda`; `mu` is completed visits divided by their total service seconds
(the observed per-worker service rate), and `rho = lambda / mu` is offered load
in worker equivalents, not a capacity-adjusted utilization percentage. No service
sample yields null `mu` and `rho`; zero-duration service alone also yields null.

`queueLength` is time-average waiting occupancy; `wip` is time-average total
occupancy, integrating overlapping visits and clipping carry-in and unfinished
visits to each window. `currentQueueLength` and `currentWip` are endpoint counts.
`wait` is mean arrival-to-start time for visits completed within the window.
Rates use seconds and wait/residence durations use seconds, while window bounds
and `windowMs` use milliseconds.

The Little's law check compares measured `L = wip` with `lambda * W`, where `W`
is mean arrival-to-completion residence for departures in the window. Relative
drift is `abs(L - lambda*W) / L`, flagged only above 20%. Two zeros have zero
drift; zero L with nonzero expectation has drift 1. No departures yields null
W, drift and flag. Short windows, changing load and censored visits can flag
legitimate boundary effects; the check is diagnostic, not an admission control.

## Station graph

The Fleet Dashboard renders the live station graph from this payload: one node
per reported station in pipeline order (`planned → READY → claimed → publish →
pr-ci → merge-queue → merged → released → fix-main`; unknown-but-safe station ids
sort after the canonical set), filled by rho band:

- **idle** — no arrivals, no queue and no in-service work in the window.
- **green** — rho below 0.7; queue wait stays near service time.
- **amber** — rho in [0.7, 0.9); an M/M/1 mean wait is already 2.3x–9x service.
- **red** — rho at or above 0.9; wait grows steeply as rho nears and passes 1.
- **unknown** — arrivals or pending work but no completed service in the window,
  so `mu`/`rho` are undefined rather than zero.

Each node shows `ρ` (or `—`) and the current queue length `q`, the count of
visits waiting right now; hover carries λ, μ, mean wait and in-service count.
The **bottleneck** — the active station with the highest rho, where a station
with pending work but no measured service rate outranks every finite rho, ties
broken by larger current queue then earlier pipeline position — is outlined and
named above the graph. Stations whose Little's law check drifted past 20% get a
dashed outline and a summary note. Pools are listed compactly beneath.
