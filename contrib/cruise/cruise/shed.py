"""Victim choice for load shedding: exactly one session per call.

Lowest value first; among equal value, the newest (least sunk work). Value comes from the
caller (learned lane yield: merges per launch), never from a fixed table."""
from __future__ import annotations


def pick_victim(sessions, protect=()):
    """sessions: [{"job", "lane", "started_ts", "value"}]. Returns one session dict or None."""
    cands = [s for s in (sessions or []) if s.get("job") and s.get("job") not in protect]
    if not cands: return None
    def key(s):
        v = s.get("value")
        return (float(v) if v is not None else 0.0, -(float(s.get("started_ts") or 0.0)))
    return sorted(cands, key=key)[0]
