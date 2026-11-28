"""Clear gate for the outside-load incident (prefix e) in self_aware.py.

Why: incident e was resolved at 15:28:36 ET on Nov 16 with "condition cleared"
while load1 was over 100. Opening stays unchanged (load1 above 2 x ncpu). An
open incident may clear only after load1 has been below the threshold for
CLEAR_SAMPLES consecutive samples, with the counted samples at least
CLEAR_SPACING_S apart. A sample at or above the threshold, an unusable sample,
a gap longer than MAX_GAP_S, or a clock that moved backwards restarts the streak.

self_aware.py runs as a one-shot launchd job (StartInterval 300, no KeepAlive),
so the streak must survive between processes. Use load_gate() and save_gate()
with a state file. Stdlib only. Failing closed is the rule: any doubt resets
the streak, which keeps the incident open longer rather than clearing it early.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

CLEAR_SAMPLES = 2
CLEAR_SPACING_S = 60.0
# The detector runs every 300 s. A gap past 900 s means samples were missed
# (sleep, a stopped job), so the streak is not "consecutive" and must restart.
MAX_GAP_S = 900.0


def _usable(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


@dataclass
class LoadClearGate:
    threshold: float
    samples: int = CLEAR_SAMPLES
    spacing_s: float = CLEAR_SPACING_S
    max_gap_s: float = MAX_GAP_S
    count: int = 0
    last_counted: Optional[float] = None
    last_seen: Optional[float] = None

    def __post_init__(self) -> None:
        if not _usable(self.threshold) or self.threshold <= 0:
            raise ValueError("threshold must be a finite positive number")
        if not isinstance(self.samples, int) or self.samples < 1:
            raise ValueError("samples must be an integer of at least 1")
        if not _usable(self.spacing_s) or self.spacing_s < 0:
            raise ValueError("spacing_s must be a finite number of at least 0")
        if not _usable(self.max_gap_s) or self.max_gap_s <= 0:
            raise ValueError("max_gap_s must be a finite positive number")

    def _reset(self) -> None:
        self.count = 0
        self.last_counted = None
        self.last_seen = None

    def observe(self, now: float, load1: Optional[float]) -> bool:
        """Feed one sample. Return True when the streak is long enough to clear.

        A load equal to the threshold is not below it, so it resets the streak.
        A below sample that arrives less than spacing_s after the last counted
        sample is ignored: it neither counts nor resets.
        """
        if not _usable(now) or not _usable(load1) or load1 >= self.threshold:
            self._reset()
            return False
        if self.last_seen is not None and (now < self.last_seen or now - self.last_seen > self.max_gap_s):
            self._reset()
        self.last_seen = now
        if self.last_counted is None:
            self.count = 1
            self.last_counted = now
        elif now - self.last_counted >= self.spacing_s:
            self.count += 1
            self.last_counted = now
        return self.count >= self.samples


_STATE_KEYS = ("threshold", "count", "last_counted", "last_seen")


def load_gate(path: Path | str, threshold: float, **kwargs: object) -> LoadClearGate:
    """Return the gate saved at path, or a fresh one.

    A missing, corrupt or mismatched state file yields a fresh gate. That is the
    safe direction: the incident stays open until a full streak is observed.
    """
    fresh = LoadClearGate(threshold, **kwargs)  # type: ignore[arg-type]
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fresh
    if not isinstance(data, dict) or any(k not in data for k in _STATE_KEYS):
        return fresh
    if data["threshold"] != threshold:
        return fresh
    count = data["count"]
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        return fresh
    for key in ("last_counted", "last_seen"):
        if data[key] is not None and not _usable(data[key]):
            return fresh
    if (count == 0) != (data["last_counted"] is None):
        return fresh
    fresh.count = count
    fresh.last_counted = data["last_counted"]
    fresh.last_seen = data["last_seen"]
    return fresh


def save_gate(path: Path | str, gate: LoadClearGate) -> None:
    """Write the gate state atomically (temp file in the same dir, then rename)."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "threshold": gate.threshold,
        "count": gate.count,
        "last_counted": gate.last_counted,
        "last_seen": gate.last_seen,
    }
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
