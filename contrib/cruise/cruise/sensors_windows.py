"""Windows provider (stub). Reports only what Python exposes portably; everything else is None,
so the controller holds instead of ramping on unknown data. PCEB-19 owns the full provider
(PDH counters: Memory\\Available MBytes, Paging File\\% Usage, Processor Queue Length, ACPI thermal zones)."""
from __future__ import annotations

from .sensors import OSSensor


class WindowsSensor(OSSensor):
    name = "windows-stub-v0"
    os_name = "windows"

    def load1(self):
        return None   # Windows has no load average; the full provider maps Processor Queue Length here

    def services(self, prefixes=("ashlr",)):
        out = self.run(["schtasks", "/query", "/fo", "csv", "/nh"], 15)
        if out is None: return None
        rows = []
        for line in out.splitlines():
            f = [x.strip('"') for x in line.split('","')]
            if f and "ashlr" in f[0].lower(): rows.append({"label": f[0], "status": f[2] if len(f) > 2 else None, "pid": None, "definition": None, "parse_ok": None})
        return rows
