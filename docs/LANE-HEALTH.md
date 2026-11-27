# Lane health

Every lane card on the Fleet screen shows four numbers over the last 12 hours:
calls, error rate, p50 latency and the deployed commit. One command prints the
same numbers:

```sh
phm lanes health --json
```

Example (trimmed):

```json
{"schema":"lanes.health.v1","window":{"hours":12},"commit":"3f9a1c07d2e4",
 "lanes":[{"lane":"codex","calls":14,"errorRate":0.07,"latencyP50Ms":612000,
 "latencyP95Ms":1900000,"commit":"3f9a1c07d2e4",
 "stuck":[{"runId":"r-81","repo":"ashlrai/phantom","phase":"producing","phaseAgeMs":2820000,"timeoutMs":2700000}]}]}
```

Without `--json` the command prints one line per lane, for example
`codex: 14 calls · 7% errors · 10m p50 · commit 3f9a1c07d2e4  [stuck · producing 47m]`.

## What each number means

- **Calls**: runs that started on the lane inside the window.
- **Error rate**: runs that ended `failed` divided by runs that finished. It is
  `null` ("unknown") until a run in the window has finished.
- **Latency**: start-to-end time of finished runs (p50 and p95); `null` until
  one has finished.
- **Commit**: the git commit of the Phantom build serving the view. It is
  `null` ("unknown") for an install with no git checkout; it is never guessed.

Error rate and latency use runs with a recorded outcome and a readable end
timestamp between their start and the end of the report window, inclusive.
A current phase start inside that interval also sets a lower bound on the
end timestamp.
A run with a valid start in the window still counts as a call if its
completion evidence is missing or invalid.

Both the screen and the CLI derive these from the same live snapshot as
`GET /api/verse/fleet/live`, so they agree. Nothing shown is a credential, and
output goes through the public-JSON scrubber.

## Stuck runs

A run that stays in one phase past its timeout gets a **stuck** badge with the
phase and how long it has been there, instead of silently hanging. Timeouts:
queued 30m, producing 45m, verifying 20m, judging 10m, landing 10m, reverting
10m. `parked`, `watching`, and runs handed off to the owner lane wait by
design and are never flagged as stuck. An owner-lane handoff still counts as a
call when its start is inside the window.
A stuck verdict requires a readable timestamp for the current phase. That
timestamp must be at or before report time and at or after the run start when
one is recorded and readable. Queued runs can qualify using their phase
timestamp alone. A run can still count as a call when its phase age is unknown.
An end timestamp suppresses the alert only when it is readable and falls
between the current phase start and report time, inclusive.

## Lane truth quota evidence

`phm fleet pace` and `phm pool why` use the quota reading's own
`observed_at` or `as_of` to date percentages from dispatcher status. A fresh
dispatcher tick cannot refresh a cached percentage. A nested `use_it_all`
percentage needs its own timestamp. Undated and future readings leave pace
unknown unless a dated provider file or usage history supplies evidence.

Fleet lane cards select the latest usage journal reading at or before report
time. Future readings cannot hide measured quota or mark a lane as drained.
When the usage journal has only future readings, it supplies no credit evidence.

`phm fleet lane-truth --json` compares dated quota readings within each
provider window. Ordering and reset detection use readable observation times
at or before report time. If a window has no such reading, the lane verdict
is unknown. The Runs History API's meter field shows the newest reading at
or before report time, or null when there is none.
A reading must predate its own reset to support a reset comparison.
A reset comparison uses the newest fresh, valid prior reading with an earlier
observation time. Unusable readings between that sample and the current one
do not prevent the comparison. An unusable current reading leaves the verdict
unknown.
A previous window can expire by report time and still establish a rollover
if its reading was taken before it expired.
The default reader scans personal Codex rollouts in descending file
modification order and uses the first rollout with a quota observation dated
at or before report time. Rollouts with only future or unreadable observation
times are skipped. A dated reading with invalid quota fields still counts
as evidence that the window is unknown.
An out-of-range Codex reset timestamp is recorded as an unknown reset without
discarding the other readings in the rollout. If it is the latest reading for
its window, the lane verdict stays unknown.

Lane truth uses the modification time of `queue/slots.json` to qualify its
running count, queued count and hold state. The file is read under the
resolved runs directory (`ASHLR_RUNS_DIR`, else `~/.ashlr-runs`), the same
override the other fleet readers honor. These fields are null when the
file is more than 15 minutes old or dated after report time. The configured
target remains visible.

The `idle_with_work` verdict requires a positive lane target, queued work,
zero running workers, no hold and remaining quota in every observed window.
A current reading of 100% used in any window suppresses the stall verdict,
as does a measured target of zero. A missing target leaves the idle check
unknown.

## Memory shed plan

Both `phm fleet shed-plan` and `phm lanes pressure` classify the work
market's on-host executors, `codex-local` and `omlx`, as local by default.
For `phm lanes pressure`, a valid `memory_class` in `queue/slots.json`
takes precedence.

Run `phm fleet shed-plan` for the next suggested action, or add `--json` for
`fleet.shed-plan.v1`. The read-only plan uses `~/.ashlr-runs/queue/status.json`:
free memory at or below 30% is high pressure, matching the dispatcher's fallback.
The snapshot's `last_tick` must be readable, at most 60 seconds old, and at or
before report time. Otherwise the report keeps lane names and kinds, shows
memory and lane measurements as unknown, and withholds shed and keep advice.
Swap is shown as context; it has no independent threshold in this plan. Active
local lanes come before cloud lanes, ordered within each kind by 24-hour merged
PRs divided by lane RAM (`lanes.<lane>.ram_gb`, total GiB). Missing measurements
are `null`, and unmeasured lanes sort after measured lanes, with lane name as a
deterministic tie-break. Idle lanes are kept open in the recommendation.
Unknown lane kinds and missing running counts are not selected for shedding.

The current dispatcher does not publish lane RAM or consume this plan. Until
those gaps are closed, the order within a kind may be unmeasured and this
command neither changes admission nor proves a lane can admit work. Check memory
again after any operator action.
