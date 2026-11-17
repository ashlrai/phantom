"""CPU placement room for the dispatchd load gate (RQ-LOADGATE-PLACEMENT-1).

The old gate read the one-minute load average and refused every lane once it passed 2 x ncpu. Processes outside
dispatchd (an operator's agent shell, a model server, a build) could hold that gate closed for all lanes even when
they used a small share of the node, and load1 keeps counting CPU that has already stopped. This module measures
instead, from the one process snapshot each tick already takes:

  busy  = %CPU of every listed process except the admitting one, in cores
  room  = GATE_PLACE_PER_CPU x ncpu - busy - cores already claimed earlier in this tick
  a lane's next job fits while room >= that lane's cost in cores

A lane's cost is its measured figure from state/resource-pool.json when that file is fresh and well formed for the
lane, otherwise GATE_JOB_CORES. A snapshot without %CPU columns has no busy figure: the room is unknown, nothing is
refused per lane, and the caller keeps its load-average gate. Node-wide saturation (busy at GATE_LOAD_PER_CPU x ncpu)
stays a global refusal, decided by the caller.

Pure functions and one bounded file read; no subprocesses, no writes.
"""
import json
import math
from datetime import datetime

DEFAULT_JOB_CORES = 1.0
POOL_MAX_AGE_S = 900          # same freshness bound as resource-live (RESOURCE_LIVE_STALE_MS)
POOL_CLOCK_SKEW_S = 60        # a builder clock slightly ahead of ours is not stale
POOL_MAX_BYTES = 1 << 20
_EPS = 1e-9


def busy_cores(table, own=None):
    """Cores in use by the snapshot's processes, excluding `own` (the admitting process).

    `table` maps pid -> (ppid, pcpu) as process_snapshot.capture(cpu=True) returns it. None means the snapshot
    carries no CPU columns, and the result is None too: unknown busy is never read as idle.
    """
    if table is None:
        return None
    total = 0.0
    for pid, row in table.items():
        pcpu = row[1] if isinstance(row, tuple) and len(row) == 2 else None
        if pid == own:
            continue
        if not isinstance(pcpu, (int, float)) or isinstance(pcpu, bool) or not math.isfinite(pcpu) or pcpu < 0:
            return None
        total += pcpu
    return total / 100.0


def read_pool(path):
    """The parsed resource-pool.json document, or None when it is missing, oversized, unreadable or not an object."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read(POOL_MAX_BYTES + 1)
        if len(raw) > POOL_MAX_BYTES:
            return None
        doc = json.loads(raw)
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _epoch(text):
    if not isinstance(text, str) or len(text) > 64:
        return None
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp.timestamp() if stamp.tzinfo is not None else None


def lane_costs(lanes, doc, now, ncpu, default=DEFAULT_JOB_CORES):
    """Cores per job for each lane -> (costs, sources). sources[lane] is "resource-pool" or "default".

    A lane takes the document's figure only when the document is fresh (measured_at within POOL_MAX_AGE_S of now)
    and that lane's cores_per_job is a finite positive number no larger than ncpu. Anything else uses `default`.
    """
    measured_at = _epoch(doc.get("measured_at")) if isinstance(doc, dict) else None
    fresh = measured_at is not None and -POOL_CLOCK_SKEW_S <= now - measured_at <= POOL_MAX_AGE_S
    entries = doc.get("lanes") if fresh and isinstance(doc.get("lanes"), dict) else {}
    costs, sources = {}, {}
    for lane in lanes:
        entry = entries.get(lane)
        value = entry.get("cores_per_job") if isinstance(entry, dict) else None
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 < value <= ncpu:
            costs[lane], sources[lane] = float(value), "resource-pool"
        else:
            costs[lane], sources[lane] = default, "default"
    return costs, sources


def plan(busy, ncpu, per_cpu, costs, sources, default=DEFAULT_JOB_CORES):
    """The placement report for this tick. JSON-safe; room_cores is None when busy is unknown."""
    room = None if busy is None else per_cpu * ncpu - busy
    return {"source": "unknown" if busy is None else "ps", "busy_cores": None if busy is None else round(busy, 3),
            "room_cores": None if room is None else round(room, 3), "per_cpu": per_cpu, "default_cores": default,
            "job_cores": dict(costs), "cost_source": dict(sources)}


class Room:
    """Cores left for new jobs this tick, kept inside the report so admission.json shows the final value.

    With no measured room (report["room_cores"] is None) nothing is refused per lane.
    """

    def __init__(self, report):
        self.report = report

    def cost(self, lane):
        return self.report["job_cores"].get(lane, self.report["default_cores"])

    def fits(self, lane):
        room = self.report["room_cores"]
        return room is None or room + _EPS >= self.cost(lane)

    def take(self, lane):
        room = self.report["room_cores"]
        if room is not None:
            self.report["room_cores"] = round(room - self.cost(lane), 3)
