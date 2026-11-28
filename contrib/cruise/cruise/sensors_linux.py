"""Linux provider: /proc and /sys only (PSI, meminfo, vmstat, zswap/zram, thermal zones)."""
from __future__ import annotations

import glob
import os
import re
from typing import Optional

from .sensors import OSSensor, MemoryPressure, Swap, Proc, THERMAL_STATES


def _read(p):
    try:
        with open(p) as f: return f.read()
    except OSError:
        return None


def parse_meminfo(text):
    out = {}
    for line in (text or "").splitlines():
        m = re.match(r"(\w+):\s+(\d+)(?:\s+kB)?", line)
        if m: out[m.group(1)] = int(m.group(2)) * (1024 if "kB" in line else 1)
    return out


def parse_psi(text):
    m = re.search(r"some avg10=([0-9.]+)", text or "")
    f = re.search(r"full avg10=([0-9.]+)", text or "")
    return (float(m.group(1)) if m else None), (float(f.group(1)) if f else None)


class LinuxSensor(OSSensor):
    name = "linux-proc-v1"
    os_name = "linux"
    root = ""   # tests point this at a fixture tree

    def _p(self, rel): return _read(self.root + rel)

    def memory_pressure(self):
        mi = parse_meminfo(self._p("/proc/meminfo"))
        some, full = parse_psi(self._p("/proc/pressure/memory"))
        free = (100.0 * mi["MemAvailable"] / mi["MemTotal"]) if mi.get("MemTotal") and "MemAvailable" in mi else None
        if some is None and free is None: return None
        # The kernel has no named level. "full" stall time (every task blocked on memory) > 0 is reported as warn;
        # the controller learns severity from the raw score, so no critical cut-off is invented here.
        level = None if full is None else ("normal" if full == 0 else "warn")
        return MemoryPressure(level=level, score=some if some is not None else (100.0 - free), free_pct=free)

    def swap(self):
        mi = parse_meminfo(self._p("/proc/meminfo"))
        vs = self._p("/proc/vmstat") or ""
        m = re.search(r"^pswpout (\d+)", vs, re.M)
        if "SwapTotal" not in mi and not m: return None
        tot, free = mi.get("SwapTotal"), mi.get("SwapFree")
        return Swap(used_bytes=(tot - free) if tot is not None and free is not None else None, total_bytes=tot,
                    swapouts_total=int(m.group(1)) if m else None)

    def compressed_memory(self):
        tot = 0; seen = False
        for d in glob.glob(self.root + "/sys/block/zram*"):
            mm = (_read(d + "/mm_stat") or "").split()
            if len(mm) >= 3: tot += int(mm[2]); seen = True     # mem_used_total
        mi = parse_meminfo(self._p("/proc/meminfo"))
        if "Zswap" in mi: tot += mi["Zswap"]; seen = True
        return tot if seen else None

    def memory_total(self):
        return parse_meminfo(self._p("/proc/meminfo")).get("MemTotal")

    def load1(self):
        t = self._p("/proc/loadavg")
        try: return float(t.split()[0]) if t else None
        except (ValueError, IndexError): return None

    def load_per_core(self):
        l1, n = self.load1(), self.cpu_count()
        return (l1 / n) if (l1 is not None and n) else None

    def thermal_state(self):
        worst = None
        for z in glob.glob(self.root + "/sys/class/thermal/thermal_zone*"):
            try: t = int((_read(z + "/temp") or "").strip())
            except ValueError: continue
            trips = {}
            for tp in glob.glob(z + "/trip_point_*_type"):
                typ = (_read(tp) or "").strip()
                try: trips.setdefault(typ, int((_read(tp.replace("_type", "_temp")) or "").strip()))
                except ValueError: pass
            st = 0
            if trips.get("critical") and t >= trips["critical"]: st = 3
            elif trips.get("hot") and t >= trips["hot"]: st = 3
            elif trips.get("passive") and t >= trips["passive"]: st = 2
            elif trips.get("active") and t >= trips["active"]: st = 1
            worst = st if worst is None else max(worst, st)
        return THERMAL_STATES[worst] if worst is not None else None

    def processes(self):
        rows = []
        try: pids = [p for p in os.listdir(self.root + "/proc") if p.isdigit()]
        except OSError: return None
        page = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
        for p in pids:
            st = self._p("/proc/%s/stat" % p)
            if not st: continue
            try:
                name = st[st.index("(") + 1:st.rindex(")")]
                f = st[st.rindex(")") + 2:].split()
                status = self._p("/proc/%s/status" % p) or ""
                um = re.search(r"^Uid:\s+(\d+)", status, re.M)
                rows.append(Proc(pid=int(p), ppid=int(f[1]), pgid=int(f[2]), uid=int(um.group(1)) if um else -1,
                                 rss_bytes=int(f[21]) * page, cpu_pct=0.0, state=f[0], name=name))
            except (ValueError, IndexError):
                continue
        return rows

    def services(self, prefixes=("ashlr",)):
        out = self.run(["systemctl", "--user", "list-units", "--all", "--no-legend", "--plain", "ashlr*"], 10)
        if out is None: return None
        rows = []
        for line in out.splitlines():
            f = line.split(None, 4)
            if f: rows.append({"label": f[0], "status": f[2] if len(f) > 2 else None, "sub": f[3] if len(f) > 3 else None, "pid": None, "definition": None, "parse_ok": None})
        return rows
