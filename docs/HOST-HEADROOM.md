# Host memory admission

The macOS `spawnEngine` memory hold is **OFF by default**. Set
`ASHLR_HOST_MEMORY_HOLD=1` in the Phantom host process to opt in. Unset it or
set it to `0` to disable the hold. Only the exact value `1` enables it;
other operating systems retain their existing admission behavior. The switch
is checked on every launch attempt. A disabled check discards prior samples
and runs no telemetry commands. Changing a shell environment requires
restarting an already-running Phantom process to pass it the new value.

When enabled, each launch attempt samples `/usr/bin/vm_stat` and
`/usr/sbin/sysctl vm.swapusage`. New launches are held only when used swap
grows by **more than 2 GiB within the preceding ten minutes**, relative to
the lowest observed swap in that window. Exactly 2 GiB is allowed. A first
valid sample establishes a baseline and allows the launch. Flat 19.35 GiB
swap is allowed, including on a host with few free pages. Absolute swap and
free-page percentages are diagnostics, not pressure triggers: macOS can
retain swap and use RAM for reclaimable caches after pressure has cleared.

Each host process shares a rolling window across its CLI lanes, using a
monotonic clock. Sampling happens on launch attempts, not in a background
monitor. History retains one minimum per second, at most 601 observations;
partially expired buckets can omit less than one second of history, but
expired observations never hold a launch. A gap longer than ten minutes
establishes a fresh baseline. A hold clears when observed growth is at most
2 GiB, either because swap falls or old observations expire. No absolute
swap recovery target or permanent latch is used.

Missing, malformed, or failed telemetry holds that enabled attempt without
exposing command stderr. Valid subsequent telemetry is evaluated normally.
Each command has a one-second timeout and a 64 KiB output limit. Collection
is synchronous and can block the host event loop for up to roughly two
seconds per enabled attempt. Disabled admission does not run these commands.
Running engines are not interrupted, and held launches write no spawn
custody record or custody callback. Existing callers decide when to retry.

The collector reports `freePercent` (free plus speculative pages divided by
physical RAM) and `swapGb` (used swap in GiB). Inactive, purgeable, and
compressed pages are excluded from the diagnostic free-page count.

The collector and policy live in `src/core/run/host-headroom.ts`, separate
from the browser-safe subscription routing model. The gate covers the
`spawnEngine` CLI path; separate resource-worker transports and API requests
do not pass through it. It does not coordinate separate Phantom processes
or reserve RAM for simultaneous launches.
