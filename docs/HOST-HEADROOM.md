# Host memory admission

On macOS, `spawnEngine` samples `/usr/bin/vm_stat`,
`/usr/sbin/sysctl vm.swapusage`, and
`/usr/sbin/sysctl -n kern.memorystatus_vm_pressure_level` immediately before
launching a CLI engine. Only kernel pressure level 1 (normal) allows a launch;
level 2 (warning) and level 4 (critical) hold it. Running engines are not
interrupted. Each attempt samples afresh and the operating system handles
pressure recovery; there is no separate process latch or memory reservation.
Existing callers decide when to retry a refusal.

The `freePercent` diagnostic counts unallocated and speculative pages divided
by physical RAM. It is raw free memory, not freely allocatable memory; inactive,
purgeable, and compressed pages are excluded. `swapGb` is used swap, not total
allocated capacity, in binary gigabytes (GiB). Neither diagnostic sets the
launch threshold.

Missing, malformed, or failed macOS telemetry holds launches. Each command has
a one-second timeout and a 64 KiB output limit. Refusal messages never expose
command stderr. Other operating systems retain their existing admission behavior.

The collector and pure policy live in `src/core/run/host-headroom.ts`.
Subscription headroom remains in the browser-safe routing module. This gate
covers the `spawnEngine` CLI path; separate resource-worker transports and API
requests do not pass through it.
