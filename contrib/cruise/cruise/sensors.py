"""OS-sensor interface (ashlr.os-sensor.v1). See ../OS-SENSOR-INTERFACE.md.

Contract for every provider:
  * Each method is cheap (bounded subprocess timeouts or a /proc read), needs no privileges,
    and never raises: an unreadable signal returns None, and the controller treats None as
    "unknown" (hold, never raise concurrency on missing data).
  * Values are raw OS measurements in SI units. No thresholds live here; the controller
    learns what "normal" means per node from these raw values.
  * Process rows carry only pid/ppid/pgid/uid/rss/cpu/state and the executable basename.
    Argument vectors are never read, so secrets passed on a command line cannot leak.
"""
from __future__ import annotations

import os
import platform
import subprocess
import time
from dataclasses import dataclass, field, asdict
from typing import Callable, List, Optional

SCHEMA = "ashlr.os-sensor.v1"
THERMAL_STATES = ("nominal", "fair", "serious", "critical")   # ordinal 0..3, same names as Apple's NSProcessInfoThermalState
PRESSURE_LEVELS = ("normal", "warn", "critical")


@dataclass
class MemoryPressure:
    level: Optional[str]          # OS's own classification ("normal"/"warn"/"critical") or None when the OS has none
    score: Optional[float]        # 0..100, higher is worse (macOS: 100 - kern.memorystatus_level; Linux: PSI some avg10)
    free_pct: Optional[float]     # OS-reported available memory percent, when it has one


@dataclass
class Swap:
    used_bytes: Optional[int]
    total_bytes: Optional[int]
    swapouts_total: Optional[int]  # monotonic pages-swapped-out counter (for a rate)


@dataclass
class Proc:
    pid: int
    ppid: int
    pgid: int
    uid: int
    rss_bytes: int
    cpu_pct: float
    state: str
    name: str                      # executable basename only; argv is never read


@dataclass
class Sample:
    schema: str = SCHEMA
    ts: float = 0.0
    os: str = ""
    provider: str = ""
    ncpu: Optional[int] = None
    mem_total_bytes: Optional[int] = None
    pressure_level: Optional[str] = None
    pressure_score: Optional[float] = None
    free_pct: Optional[float] = None
    swap_used_bytes: Optional[int] = None
    swap_total_bytes: Optional[int] = None
    swapouts_total: Optional[int] = None
    compressed_bytes: Optional[int] = None
    load1: Optional[float] = None
    load_per_core: Optional[float] = None
    thermal: Optional[str] = None
    model: Optional[str] = None
    errors: List[str] = field(default_factory=list)

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, d):
        keys = cls.__dataclass_fields__.keys()
        return cls(**{k: v for k, v in (d or {}).items() if k in keys})


Runner = Callable[[List[str], float], Optional[str]]


def default_runner(argv: List[str], timeout: float) -> Optional[str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.stdout if p.returncode == 0 else None
    except Exception:
        return None


class OSSensor:
    """Base provider. Subclasses override the six signal methods plus processes()."""
    name = "base"
    os_name = "unknown"

    def __init__(self, runner: Runner = default_runner, clock: Callable[[], float] = time.time):
        self.run = runner
        self.clock = clock

    # ---- the interface -------------------------------------------------
    def memory_pressure(self) -> Optional[MemoryPressure]: return None
    def swap(self) -> Optional[Swap]: return None
    def compressed_memory(self) -> Optional[int]: return None          # bytes held by the compressor (zram/zswap on Linux)
    def load_per_core(self) -> Optional[float]: return None            # load1 / logical cpus
    def thermal_state(self) -> Optional[str]: return None              # one of THERMAL_STATES
    def cpu_count(self) -> Optional[int]: return os.cpu_count()
    def memory_total(self) -> Optional[int]: return None
    def load1(self) -> Optional[float]:
        try: return os.getloadavg()[0]
        except (OSError, AttributeError): return None
    def model(self) -> Optional[str]: return platform.machine() or None
    def processes(self) -> Optional[List[Proc]]: return None
    def os_version(self) -> Optional[str]: return platform.release() or None
    def services(self, prefixes=("ai.ashlr.", "com.ashlr.")) -> Optional[List[dict]]:
        """Fleet service units on this node: [{"label", "pid", "status", "definition", "parse_ok"}].
        macOS: LaunchAgents; Linux: systemd --user units; Windows: scheduled tasks."""
        return None

    # ---- one combined sample (never raises) ----------------------------
    def sample(self) -> Sample:
        s = Sample(ts=self.clock(), os=self.os_name, provider=self.name)
        def g(fn, label):
            try: return fn()
            except Exception as e:   # a provider bug must not stop the loop; record and continue
                s.errors.append("%s:%s" % (label, type(e).__name__)); return None
        s.ncpu = g(self.cpu_count, "ncpu")
        s.mem_total_bytes = g(self.memory_total, "mem_total")
        mp = g(self.memory_pressure, "pressure")
        if mp:
            s.pressure_level, s.pressure_score, s.free_pct = mp.level, mp.score, mp.free_pct
        sw = g(self.swap, "swap")
        if sw:
            s.swap_used_bytes, s.swap_total_bytes, s.swapouts_total = sw.used_bytes, sw.total_bytes, sw.swapouts_total
        s.compressed_bytes = g(self.compressed_memory, "compressed")
        s.load1 = g(self.load1, "load1")
        s.load_per_core = g(self.load_per_core, "load_per_core")
        s.thermal = g(self.thermal_state, "thermal")
        s.model = g(self.model, "model")
        return s


def detect(runner: Runner = default_runner) -> OSSensor:
    sysname = platform.system()
    if sysname == "Darwin":
        from .sensors_macos import MacOSSensor
        return MacOSSensor(runner)
    if sysname == "Linux":
        from .sensors_linux import LinuxSensor
        return LinuxSensor(runner)
    if sysname == "Windows":
        from .sensors_windows import WindowsSensor
        return WindowsSensor(runner)
    return OSSensor(runner)
