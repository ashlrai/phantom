"""Per-node learned priors. A profile is only a starting point: the controller's persisted
state overrides every value once it has learned it. Selection is by RAM class and form
factor (fanless Air throttles on heat before memory), never by hostname, so a node Eng Ops
has not mapped yet still gets a sensible prior."""
from __future__ import annotations

GIB = 1 << 30

# baselines: indicator -> (mean, mad) seed for the healthy baseline, before any live sample.
PROFILES = {
    "mac-8gb": {   # 8 GB MacBook Pro: memory-bound; ramp slowly, shed early, small step
        "knee": 2.0, "step": 1.0, "beta": 0.7, "margin": 0.15, "dwell": 15.0, "z_warn": 2.5, "z_danger": 4.5,
        "session_rss_prior_bytes": int(1.2 * GIB),
        "baselines": {"pressure_score": (45.0, 8.0), "load_per_core": (0.4, 0.2)},
    },
    "mac-16gb-fanless": {   # 16 GB MacBook Air: no fan, thermal is the first knee under sustained CPU
        "knee": 5.0, "step": 1.0, "beta": 0.75, "margin": 0.12, "dwell": 12.0, "z_warn": 2.75, "z_danger": 5.0,
        "session_rss_prior_bytes": int(1.2 * GIB),
        "baselines": {"pressure_score": (40.0, 8.0), "load_per_core": (0.5, 0.25)},
    },
    "mac-16gb": {
        "knee": 6.0, "step": 1.0, "beta": 0.75, "margin": 0.12, "dwell": 12.0, "z_warn": 2.75, "z_danger": 5.0,
        "session_rss_prior_bytes": int(1.2 * GIB),
        "baselines": {"pressure_score": (40.0, 8.0), "load_per_core": (0.5, 0.25)},
    },
    "mac-large": {   # main Mac class (128 GB, 18 cores): 7-day load-curve p90 22, max 61 running sessions
        "knee": 22.0, "step": 2.0, "beta": 0.8, "margin": 0.1, "dwell": 10.0, "z_warn": 3.0, "z_danger": 6.0,
        "session_rss_prior_bytes": int(1.5 * GIB),
        "baselines": {"pressure_score": (30.0, 8.0), "load_per_core": (1.5, 0.75)},
    },
    "generic": {"knee": 4.0, "step": 1.0, "beta": 0.75, "margin": 0.12, "dwell": 12.0, "z_warn": 3.0, "z_danger": 5.5,
                "session_rss_prior_bytes": int(1.5 * GIB), "baselines": {}},
}


def classify(mem_total_bytes, model=None, os_name="macos"):
    gb = (mem_total_bytes or 0) / GIB
    fanless = bool(model) and model.lower().startswith("macbookair")
    if os_name != "macos": return "generic"
    if gb and gb <= 9: return "mac-8gb"
    if gb and gb <= 17: return "mac-16gb-fanless" if fanless else "mac-16gb"
    if gb and gb >= 64: return "mac-large"
    return "generic"


def priors_for(mem_total_bytes, model=None, os_name="macos"):
    name = classify(mem_total_bytes, model, os_name)
    p = dict(PROFILES[name])
    if name == "generic" and mem_total_bytes:
        # RAM-derived prior knee: sessions that fit in half of RAM at the prior per-session RSS
        p["knee"] = max(1.0, round(mem_total_bytes * 0.5 / p["session_rss_prior_bytes"]))
    p["profile"] = name
    return p
