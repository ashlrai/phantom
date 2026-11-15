# Queue statistics

`phm queue stats --json` reads the local metadata journal at
`$ASHLR_HOME/queue/visits.jsonl` (default `~/.ashlr/queue/visits.jsonl`) and
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
