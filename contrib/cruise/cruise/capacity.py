"""Fleet-owned versus foreign host load (Eng Ops 2:47 ET bug in the ledger headroom rule).

The ledger rule max_slots_memory = floor(0.85 * mem_total / (memory_used / total_running)) charges
ALL used memory (and max_slots_cpu all of load1) to dispatchd sessions, so a 22 GB, 108-239% CPU
fseventsd pins every lane's host_headroom_limit to 0. Here per-session cost is measured from OUR
registered process groups only, and foreign use is subtracted from capacity instead:

  per_session_mem = owned_rss / running
  mem_slots       = running + (mem_total * avail_frac - used_total) / per_session_mem
  per_session_cpu = owned_cpu_cores / running
  cpu_slots       = running + (ncpu * cpu_frac - total_cpu_cores) / per_session_cpu

avail_frac and cpu_frac are the controller's learned level limits (pressure_score limit and
load-per-core limit), not fixed 0.85 / 1.0."""
from __future__ import annotations

import math


def split(procs, own_pgids):
    tot_cpu = own_cpu = 0.0; tot_rss = own_rss = 0
    for p in procs or []:
        tot_cpu += p.cpu_pct; tot_rss += p.rss_bytes
        if p.pgid in own_pgids: own_cpu += p.cpu_pct; own_rss += p.rss_bytes
    return {"total_cpu_cores": tot_cpu / 100.0, "owned_cpu_cores": own_cpu / 100.0, "foreign_cpu_cores": (tot_cpu - own_cpu) / 100.0,
            "total_rss_bytes": tot_rss, "owned_rss_bytes": own_rss, "foreign_rss_bytes": tot_rss - own_rss,
            "cpu_share": (own_cpu / tot_cpu) if tot_cpu > 0 else None, "mem_share": (own_rss / tot_rss) if tot_rss > 0 else None}


def headroom_slots(sp, running, mem_total, free_pct, ncpu, mem_limit_score, load_limit_per_core):
    out = {"mem_slots": None, "cpu_slots": None, "host_slots": None}
    if running and running > 0:
        if sp.get("owned_rss_bytes") and mem_total and free_pct is not None:
            used = mem_total * (100.0 - free_pct) / 100.0
            allow = mem_total * (mem_limit_score / 100.0)
            out["mem_slots"] = max(0, int(math.floor(running + (allow - used) / (sp["owned_rss_bytes"] / running))))
        if sp.get("owned_cpu_cores") and ncpu:
            out["cpu_slots"] = max(0, int(math.floor(running + (ncpu * load_limit_per_core - sp["total_cpu_cores"]) / (sp["owned_cpu_cores"] / running))))
    caps = [v for v in (out["mem_slots"], out["cpu_slots"]) if v is not None]
    out["host_slots"] = min(caps) if caps else None
    return out
