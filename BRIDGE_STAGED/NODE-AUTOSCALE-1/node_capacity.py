"""Read-only node-capacity reader for dispatchd (staged, RQ-NODE-AUTOSCALE-1).

Stdlib only. No network, no subprocess, no writes. dispatchd imports
`lane_capacity_cap()` and applies it ONLY to lanes whose memguard backoff it
would otherwise apply to the whole host. Any doubt (missing, stale, malformed,
gates tripped) returns None, which means "keep the existing memguard
behaviour unchanged": this helper can only relax a host-wide memory backoff
for a lane down to that lane's own measured CLI footprint, never loosen
pressure, swap-growth, loadgate or merge-queue gates.
"""
from __future__ import annotations

import calendar
import json
import os
import stat
import time

SCHEMA = "phantom.node-capacity.v1"
MAX_BYTES = 1024 * 1024
MAX_AGE_S = 120

# Lane -> harness adapter id (src/core/drive/nodes/harness-adapters.ts). Lanes
# not listed keep existing memguard behaviour.
LANE_HARNESS = {
    "codex-personal": "codex",
    "codex-local": "codex",
    "codex-cmp": "codex",
    "claude": "claude",
    "grok": "grok",
    "cursor": "cursor",
    "devin": "devin",
    "devin-flash": "devin",
    "gemini": "gemini",
}


def default_path() -> str:
    return os.path.join(os.path.expanduser("~"), ".ashlr-runs", "metrics", "node-capacity.json")


def read_doc(path: str | None = None, now: float | None = None) -> dict | None:
    """Return the document only if it is a fresh, owned, regular, well-formed file."""
    path = path or default_path()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_BYTES or st.st_uid != os.getuid():
            return None
        raw = os.read(fd, MAX_BYTES + 1)
    finally:
        os.close(fd)
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA:
        return None
    try:
        measured = calendar.timegm(time.strptime(doc["measured_at"][:19], "%Y-%m-%dT%H:%M:%S"))
    except (KeyError, TypeError, ValueError):
        return None
    age = (now if now is not None else time.time()) - measured
    if age < -60 or age > MAX_AGE_S:
        return None
    runnable = doc.get("agents_runnable_now")
    limiting = (doc.get("basis") or {}).get("limiting")
    if not isinstance(runnable, dict) or not isinstance(limiting, dict):
        return None
    return doc


def lane_capacity_cap(lane: str, running: int, doc: dict | None) -> int | None:
    """Target this lane may hold on this node, or None to keep memguard as is.

    running + agents_runnable_now[harness]. Node-wide gates (pressure,
    swap-growth) and unknown footprints return None so memguard decides.
    """
    harness = LANE_HARNESS.get(lane)
    if doc is None or harness is None or not isinstance(running, int) or running < 0:
        return None
    limiting = doc["basis"]["limiting"].get(harness)
    if limiting in (None, "pressure", "swap-growth", "unmeasured"):
        return None
    n = doc["agents_runnable_now"].get(harness)
    if not isinstance(n, int) or isinstance(n, bool) or n < 0:
        return None
    return running + n
