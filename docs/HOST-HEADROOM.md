# Host memory admission

On macOS, `spawnEngine` samples `/usr/bin/vm_stat` and
`/usr/sbin/sysctl vm.swapusage` immediately before launching a CLI engine.
New launches are refused below 30% free memory or above 8 GiB used swap.
Running engines are not interrupted by this check.

After a refusal, the host process holds its CLI lanes until a later launch
attempt observes at least 35% free memory and at most 6 GiB used swap.
This recovery margin prevents repeated starts and stops near the thresholds.
The latch is shared by lanes in one process and resets when that process
restarts. It does not coordinate separate Phantom processes or reserve RAM
for simultaneous launches. Existing callers decide when to retry a refusal.

Free memory counts unallocated and speculative pages divided by physical
RAM. Inactive, purgeable, and compressed pages are excluded. Swap is the
`used` value, not the total allocated swap capacity. The collector exposes
`freePercent` and `swapGb`; GB here means binary gigabytes (GiB).

Missing, malformed, or failed macOS telemetry holds launches until a valid
recovery reading. Each command has a one-second timeout and a 64 KiB output
limit. Refusal messages contain only memory measurements and recovery
thresholds, never command stderr. Other operating systems retain their
existing admission behavior.

The collector and pure policy live in `src/core/run/host-headroom.ts`.
Subscription headroom remains in the browser-safe routing module. This
gate covers the `spawnEngine` CLI path; separate resource-worker transports
and API requests do not pass through it.
