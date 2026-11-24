"""macOS provider for the OS-sensor interface. sysctl, vm_stat, pmset and ps only; no sudo,
no private frameworks, no app databases. Every call has a short timeout."""
from __future__ import annotations

import os
import plistlib
import re
from typing import List, Optional

from .sensors import OSSensor, MemoryPressure, Swap, Proc, THERMAL_STATES

_SYSCTL = "/usr/sbin/sysctl"
_VMSTAT = "/usr/bin/vm_stat"
_PMSET = "/usr/bin/pmset"
_PS = "/bin/ps"
_KPL = {1: "normal", 2: "warn", 4: "critical"}   # kern.memorystatus_vm_pressure_level (Apple's own levels)
_UNIT = {"K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}


def parse_vm_stat(text: Optional[str]):
    """{'page_size': int, '<key>': int} from vm_stat output, keys lowercased with spaces -> '_'."""
    if not text: return None
    out = {}
    m = re.search(r"page size of (\d+) bytes", text)
    if m: out["page_size"] = int(m.group(1))
    for line in text.splitlines():
        if ":" not in line: continue
        k, v = line.split(":", 1)
        v = v.strip().rstrip(".")
        if v.isdigit():
            out[re.sub(r"[^a-z0-9]+", "_", k.strip().strip('"').lower()).strip("_")] = int(v)
    return out


def parse_swapusage(text: Optional[str]):
    if not text: return None, None
    def val(key):
        m = re.search(key + r"\s*=\s*([0-9.]+)([KMGT])", text)
        return int(float(m.group(1)) * _UNIT[m.group(2)]) if m else None
    return val("used"), val("total")


def parse_pmset_therm(text: Optional[str]) -> Optional[str]:
    """Map `pmset -g therm` to a THERMAL_STATES name. 'No thermal warning level has been recorded'
    plus no CPU speed limit below 100 -> nominal. Unparseable -> None (unknown)."""
    if text is None: return None
    t = text.lower()
    state = 0
    m = re.search(r"cpu_speed_limit\s*=\s*(\d+)", t)
    if m:
        lim = int(m.group(1))
        # Provider normalization (see FIXED-CONSTANTS in README): speed-limit percent bands.
        state = max(state, 0 if lim >= 100 else 1 if lim >= 70 else 2 if lim >= 40 else 3)
    m = re.search(r"thermal warning level\D{0,20}(\d+)", t)
    if m and int(m.group(1)) > 0:
        state = max(state, 1 if int(m.group(1)) < 2 else 2)
    if "no thermal warning level has been recorded" in t or m or "cpu_speed_limit" in t:
        return THERMAL_STATES[state]
    return None


def parse_ps(text: Optional[str]) -> Optional[List[Proc]]:
    if text is None: return None
    rows = []
    for line in text.splitlines():
        f = line.split(None, 7)
        if len(f) < 8: continue
        try:
            rows.append(Proc(pid=int(f[0]), ppid=int(f[1]), pgid=int(f[2]), uid=int(f[3]),
                             rss_bytes=int(f[4]) * 1024, cpu_pct=float(f[5]), state=f[6],
                             name=os.path.basename(f[7].strip()) or f[7].strip()))
        except ValueError:
            continue
    return rows


class MacOSSensor(OSSensor):
    name = "macos-sysctl-vmstat-v1"
    os_name = "macos"

    def _sysctl(self, key):
        out = self.run([_SYSCTL, "-n", key], 5)
        return out.strip() if out else None

    def _int(self, key):
        v = self._sysctl(key)
        try: return int(v) if v is not None else None
        except ValueError: return None

    def _vm(self):
        if getattr(self, "_vm_cache_ts", None) != self._tick:
            self._vm_cache = parse_vm_stat(self.run([_VMSTAT], 5)); self._vm_cache_ts = self._tick
        return self._vm_cache

    _tick = 0

    def sample(self):
        self._tick += 1          # one vm_stat call per combined sample
        return super().sample()

    def memory_pressure(self):
        lvl = self._int("kern.memorystatus_vm_pressure_level")
        free = self._int("kern.memorystatus_level")   # the same number `memory_pressure` prints as free percentage
        if lvl is None and free is None: return None
        return MemoryPressure(level=_KPL.get(lvl), score=(100.0 - free) if free is not None else None,
                              free_pct=float(free) if free is not None else None)

    def swap(self):
        used, total = parse_swapusage(self._sysctl("vm.swapusage"))
        vm = self._vm() or {}
        if used is None and "swapouts" not in vm: return None
        return Swap(used_bytes=used, total_bytes=total, swapouts_total=vm.get("swapouts"))

    def compressed_memory(self):
        vm = self._vm()
        if not vm or "pages_occupied_by_compressor" not in vm or "page_size" not in vm: return None
        return vm["pages_occupied_by_compressor"] * vm["page_size"]

    def cpu_count(self):
        return self._int("hw.ncpu") or os.cpu_count()

    def memory_total(self):
        return self._int("hw.memsize")

    def load1(self):
        v = self._sysctl("vm.loadavg")
        m = re.search(r"([0-9.]+)", v or "")
        return float(m.group(1)) if m else None

    def load_per_core(self):
        l1, n = self.load1(), self.cpu_count()
        return (l1 / n) if (l1 is not None and n) else None

    def thermal_state(self):
        return parse_pmset_therm(self.run([_PMSET, "-g", "therm"], 5))

    def model(self):
        return self._sysctl("hw.model")

    def processes(self):
        return parse_ps(self.run([_PS, "-axo", "pid=,ppid=,pgid=,uid=,rss=,pcpu=,stat=,comm="], 10))

    def os_version(self):
        out = self.run(["/usr/bin/sw_vers", "-productVersion"], 5)
        return out.strip() if out else None

    def services(self, prefixes=("ai.ashlr.", "com.ashlr.")):
        """launchctl list (labels, pid, last exit) joined with ~/Library/LaunchAgents plists. A plist that
        does not parse is reported with parse_ok False and is never touched."""
        out = self.run(["/bin/launchctl", "list"], 10)
        loaded = {}
        for line in (out or "").splitlines()[1:]:
            f = line.split("\t")
            if len(f) == 3 and f[2].startswith(tuple(prefixes)):
                loaded[f[2]] = {"pid": int(f[0]) if f[0].isdigit() else None, "status": f[1]}
        d = os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents")
        rows = {}
        try: names = sorted(os.listdir(d))
        except OSError: names = []
        for n in names:
            if not n.endswith(".plist") or not n.startswith(tuple(prefixes)): continue
            label, ok = n[:-6], True
            try:
                with open(os.path.join(d, n), "rb") as f: label = plistlib.load(f).get("Label") or label
            except Exception:
                ok = False
            rows[label] = {"label": label, "definition": n, "parse_ok": ok}
        for k, v in loaded.items(): rows.setdefault(k, {"label": k, "definition": None, "parse_ok": None}).update(v)
        return sorted(rows.values(), key=lambda r: r["label"])
