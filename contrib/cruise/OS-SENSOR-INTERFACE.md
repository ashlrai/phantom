# OS-sensor interface (ashlr.os-sensor.v1)

Owner: Phantom Core (CRUISE-1). Shared with PCEB-19 (cross-platform line), which adopts this
file if it lands first. Code: `contrib/cruise/cruise/sensors.py`.

## Rules for every provider

- Cheap: bounded subprocess timeouts (5 to 15 s) or a `/proc` read. One combined `sample()` per tick.
- No privileges: no sudo, no private frameworks, no app databases, no keychain, no TCC.
- Never raises. An unreadable signal is `None`; the controller treats `None` as unknown and holds.
- Raw measurements in SI units. No thresholds inside a provider; the controller learns them per node.
- Process rows carry pid, ppid, pgid, uid, rss, cpu percent, state and the executable basename only.
  Argument vectors are never read.

## Methods

| method | returns | macOS (first provider) | Linux | Windows (stub, PCEB-19) |
|---|---|---|---|---|
| `memory_pressure()` | `MemoryPressure(level, score, free_pct)`; level is the OS's own class `normal/warn/critical` or None; score 0..100, higher worse | `kern.memorystatus_vm_pressure_level` (1/2/4), score = 100 - `kern.memorystatus_level` | PSI `/proc/pressure/memory` some avg10 as score; full avg10 > 0 = warn; MemAvailable | PDH `Memory\Available MBytes`, commit charge |
| `swap()` | `Swap(used_bytes, total_bytes, swapouts_total)` | `vm.swapusage`, vm_stat Swapouts | `/proc/meminfo` SwapTotal/SwapFree, `/proc/vmstat` pswpout | `Paging File\% Usage`, `Memory\Pages Output/sec` |
| `compressed_memory()` | bytes held by the compressor | vm_stat "Pages occupied by compressor" x page size | zram `mm_stat` mem_used_total + `Zswap` | `Memory\Compressed` (memory compression store) |
| `load_per_core()` | load1 / logical CPUs | `vm.loadavg` / `hw.ncpu` | `/proc/loadavg` / cpu_count | Processor Queue Length / cores |
| `thermal_state()` | `nominal/fair/serious/critical` (Apple's NSProcessInfoThermalState names) or None | `pmset -g therm` CPU_Speed_Limit and warning level | thermal zones vs trip points (active/passive/hot/critical) | ACPI `MSAcpi_ThermalZoneTemperature` |
| `processes()` | `[Proc]` | `ps -axo pid,ppid,pgid,uid,rss,pcpu,stat,comm` | `/proc/<pid>/stat`, status Uid | `Get-Process` (no command lines) |
| `services(prefixes)` | fleet units `[{label, pid, status, definition, parse_ok}]` | `launchctl list` + `~/Library/LaunchAgents/*.plist` (plistlib; unparseable = parse_ok false) | `systemctl --user list-units ashlr*` | `schtasks /query /fo csv` |
| `cpu_count()`, `memory_total()`, `load1()`, `model()`, `os_version()` | scalars | sysctl, sw_vers | os, /proc/meminfo | os |

Rates (compressed-memory growth, swap growth, swap-out rate) are computed OS-neutrally by the
controller from two consecutive samples, so providers stay stateless.

`detect()` picks the provider from `platform.system()`.
