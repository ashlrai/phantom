# OS sensor interface for the pacing controller

Status: implementation contract for `src/core/resources/os-sensors.ts`.

```ts
readOsSensors(options?: { host?: OsSensorHost; timeoutMs?: number }): Promise<OsSensorSnapshot>
```

The snapshot has `schema: 'os.sensors.v1'`, `platform`, `sampledAtMs`, and these observations:

- `memoryPressure`: macOS `{ kind: 'kernel-level', level: 'normal' | 'warning' | 'critical' }`; Linux `{ kind: 'psi', someAvg10Percent, fullAvg10Percent }`; Windows `{ kind: 'commit', usedPercent }`.
- `swapUsedBytes`: current used swap or pagefile allocation, never committed virtual memory.
- `compressedBytes`: physical resident compressed-store bytes. macOS uses pages occupied by compressor; Linux combines the zswap pool and enumerated zram resident allocations. Windows is unknown because the provider has no stable public compression-size contract.
- `loadPerCore`: one-minute Unix load average divided by logical CPU count. Windows is unknown, never Node's synthetic zero load average.
- `thermal`: macOS `{ kind: 'cpu-speed-limit', percent }` from `pmset -g therm`; Linux/Windows `{ kind: 'max-zone-celsius', celsius }` from available thermal zones. These are different observations, not interchangeable severities or guaranteed CPU die temperatures.

Each observation is `{ value: T | null, source: string, reason: 'unavailable' | 'unsupported' | 'invalid' | 'timeout' | null }`. A measured zero is valid. Failed, missing, malformed or timed-out probes yield null; command errors and raw output are never returned. A source identifies the intended provider even when unavailable.

Pressure kinds must be interpreted separately. Linux PSI percentages describe stalled time; Windows commit percentage describes committed allocation against its limit, not physical RAM pressure or pagefile usage. No provider silently maps these to macOS kernel pressure levels. Sampling is read-only and never changes admission, starts work, installs anything or requests privilege. Calls run concurrently within a bounded deadline, with bounded output and an injectable host for fixtures.

Consumers should reject stale snapshots using `sampledAtMs`, preserve unknowns and choose explicit policy per pressure/thermal kind. This change does not replace existing pacing thresholds or host-admission decisions.

Provider references: [Linux PSI](https://docs.kernel.org/accounting/psi.html), [Linux memory fields](https://www.kernel.org/doc/html/v6.14/filesystems/proc.html), [zram accounting](https://docs.kernel.org/admin-guide/blockdev/zram.html), [Windows pagefile usage](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-pagefileusage), [Windows thermal counters](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/examples--requirements-and-diagnostics).

Delivery note: this worktree copy is available early for integration. The requested external handoff copy may be unavailable in this execution environment; the job result records whether that copy succeeded.
