# Queue statistics

`phm queue stats --json` reads the local metadata journal at
`~/.ashlr/queue/visits.jsonl` and returns station and pool aggregates for sliding
1 hour, 24 hour and 7 day windows. `--window <seconds>` selects one window.
The command is read-only and requires no service or credentials. Missing journals
produce empty groups; malformed records fail explicitly without echoing contents.

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
