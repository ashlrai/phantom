"""Optional jobs.jsonl history for admission. Missing data never lowers a budget.

This checkout has no bridge admission controller. Import required_memory_bytes
from that controller, passing its existing conservative fallback and exact pool.
"""
import json
import math
from pathlib import Path


def required_memory_bytes(jobs_path, pool, fallback_bytes):
    """Return max(fallback, observed pool peaks); ignore legacy/malformed rows.

    Sum RSS and attributed swap peaks conservatively. Unknown swap contributes
    no estimate; the controller's host pressure and fallback gates still apply.
    """
    if not isinstance(fallback_bytes, (int, float)) or not math.isfinite(fallback_bytes) or fallback_bytes < 0:
        raise ValueError("fallback_bytes must be finite and nonnegative")
    required = fallback_bytes
    try:
        with Path(jobs_path).open(encoding="utf-8") as records:
            for line in records:
                try:
                    row = json.loads(line)
                    if not isinstance(row, dict) or row.get("schemaVersion") != 1 or row.get("pool") != pool:
                        continue
                    memory = row.get("memory")
                    if not isinstance(memory, dict) or memory.get("schemaVersion") != 1:
                        continue
                    count = memory.get("sampleCount")
                    if type(count) is not int or count < 1:
                        continue
                    rss = memory.get("peakRssBytes")
                    swap = memory.get("peakSwapBytes")
                    if swap is None:
                        swap = 0
                    if any(type(n) not in (int, float) or not math.isfinite(n) or n < 0 for n in (rss, swap)):
                        continue
                    peak = rss + swap
                    if math.isfinite(peak):
                        required = max(required, peak)
                except (ValueError, TypeError, OverflowError):
                    continue
    except (OSError, UnicodeError):
        pass
    return required
