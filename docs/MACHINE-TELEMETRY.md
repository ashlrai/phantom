# Local machine telemetry

Enable `telemetry.machine.enabled = true` in Phantom configuration, then run
`phm resources sample --json`. Collection is disabled by default. The command
writes only the `resources.machine` member of `~/.ashlr-runs/fleet.json` and
prints that observation. It uses local files and fixed OS commands, without
network requests, listeners, redirects, shell commands, sudo or credentials.
Unknown flags, including bind addresses and URLs, are rejected.

The existing concurrent daemon dispatch resource read invokes the same adapter,
including when provider readings come from its cache. The external queue bridge
must call `phm resources sample --json` on each of its own dispatch ticks. That
bridge is outside this repository; no bridge activation is performed here.

## Queue input and measurements

The sampler reads `~/.ashlr-runs/queue/status.json`. Its supported input is an
object with `running` (or `jobs`) as an array of objects containing numeric `pid`
fields. An optional `status` field excludes rows unless it equals `running`.
Job identifiers in the observation are root PIDs. Job labels, prompts, command
arguments and all other queue fields are discarded.

`memguard` accepts `pause`/`paused` or `{ "paused": true }` to pause. Explicit
clear states are `normal`, `run`, `running`, `resume` or `{ "paused": false }`.
An object with `state` can carry the same states. An absent, unreadable or
unrecognized guard is unknown and yields zero headroom.

CPU percentages use per-core counter deltas between observations, with no sleep
for an interval. The first observation reports null percentages. Load averages
are the OS 1-, 5- and 15-minute values. Per-job CPU and RSS sum each root's full
process tree from a single numeric-only `ps` snapshot. Process CPU percentages
are OS lifetime averages, not the same interval as host CPU. Missing roots or
failed process reads yield null job measurements.

macOS RAM free is free plus speculative pages from `vm_stat`, falling back to
OS free memory if that command fails. Linux uses `MemAvailable` from
`/proc/meminfo`. RAM used is total minus that available memory. All memory and
disk counters are bytes. Disk free includes each local mounted volume.

macOS pressure uses the kernel's pressure level plus `memory_pressure -Q`'s free
percentage and `vm_stat` pageouts. GPU and ANE residency are read from
unprivileged `powermetrics` only. Permission denial or timeout yields null.
Linux reads a GPU busy percentage from the primary DRM device's sysfs counter
when supported; other GPU interfaces and ANE utilization remain null.
Commands run in parallel with 100 ms timeouts and bounded output. The total
sampler time must still be measured on the dispatch host under its actual load.

## Headroom and persistence

`headroom` is advisory extra slots, not permission to launch jobs. It equals
`floor(freeBytes * 0.75 / estimatedJobRssBytes)`. The estimate is the larger of
1 GiB (or the configured positive `telemetry.machine.estimatedJobRssBytes`) and
the largest measured running-job tree RSS. This reserves 25% of available RAM
and uses the largest observed job rather than a smaller average.

Swap growth is the nonnegative change in used swap bytes per second. A first,
nonmonotonic, cross-platform or older-than-five-minute baseline is unknown.
Positive or unknown growth, unknown job RSS, unknown guard state, a memguard
pause or critical macOS memory pressure forces headroom to zero. A falling
swap reading gives zero growth. Persisted numeric baselines allow successive
one-shot CLI invocations to measure these deltas.

Consumers must reject stale observations using `sampledAtMs` and their dispatch
tick interval. A failed write leaves the last observation in place and does not
establish current capacity. Each tick should require a fresh successful sample.
All fleet read/modify/write owners must share `fleet.json.machine.lock` using
Phantom's local-store lock helper. It recovers a verified dead owner and refuses
live or unknown owners without waiting. The sampler rereads the fleet after
probes and refuses a visible intervening change before its atomic replacement;
this cannot provide mutual exclusion against a writer that ignores the lock.
Malformed, linked, unowned or group/world-writable fleet state is not replaced.
