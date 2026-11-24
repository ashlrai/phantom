"""Online estimators. Every learned value starts at a prior and moves with live telemetry.

Learned values are stored as {"value": v, "prior": p, "n": updates}. Nothing here is a
threshold; thresholds are Param objects the controller adapts from outcomes."""
from __future__ import annotations

import math


class EW:
    """Exponentially weighted mean and mean-absolute-deviation. The smoothing weight is itself
    derived from the sample count (1/n until n reaches the horizon) so a cold estimator moves fast."""
    def __init__(self, d=None, horizon=None):
        d = d or {}
        self.mean = d.get("mean")
        self.mad = d.get("mad")
        self.n = int(d.get("n", 0))
        self.horizon = float(d.get("horizon") or horizon or 120.0)
        self.absmean = d.get("absmean")    # EW of |x| over ALL samples (healthy or not): scale floor for zero-mean rates

    def observe(self, x):
        """Track scale from every sample without moving the healthy baseline."""
        if x is None: return
        self.absmean = abs(x) if self.absmean is None else self.absmean + (abs(x) - self.absmean) / self.horizon

    def update(self, x):
        if x is None or (isinstance(x, float) and math.isnan(x)): return
        self.observe(x)
        self.n += 1
        a = max(1.0 / self.n, 1.0 / self.horizon)
        if self.mean is None:
            self.mean, self.mad = float(x), 0.0; return
        dev = abs(x - self.mean)
        self.mean += a * (x - self.mean)
        self.mad += a * (dev - self.mad)

    def z(self, x, floor_frac):
        """Robust z of x against this baseline; scale has a floor proportional to the mean so a
        perfectly flat baseline cannot turn noise into infinite z."""
        if x is None or self.mean is None: return None
        scale = max(self.mad or 0.0, abs(self.mean) * floor_frac, (self.absmean or 0.0) * floor_frac, 1e-12)
        return (x - self.mean) / scale

    def to_dict(self):
        return {"mean": self.mean, "mad": self.mad, "n": self.n, "horizon": self.horizon, "absmean": self.absmean}


class Quantile:
    """Streaming quantile by stochastic approximation; the step scales with the observed spread."""
    def __init__(self, q, d=None, prior=None):
        d = d or {}
        self.q = q
        self.value = d.get("value", prior)
        self.spread = EW(d.get("spread"))
        self.n = int(d.get("n", 0))

    def update(self, x):
        if x is None: return
        self.n += 1
        if self.value is None:
            self.value = float(x); self.spread.update(0.0); return
        self.spread.update(abs(x - self.value))
        step = max(self.spread.mean or 0.0, abs(self.value) * 0.01, 1e-9) / math.sqrt(self.n)
        self.value += step * (self.q if x > self.value else -(1 - self.q)) * 2

    def to_dict(self):
        return {"value": self.value, "spread": self.spread.to_dict(), "n": self.n}


class Param:
    """A learned scalar with a prior and safety rails. nudge() moves it multiplicatively."""
    def __init__(self, name, d=None, prior=None, lo=None, hi=None):
        d = d or {}
        self.name = name
        self.prior = d.get("prior", prior)
        self.value = d.get("value", prior)
        self.lo = d.get("lo", lo)
        self.hi = d.get("hi", hi)
        self.n = int(d.get("n", 0))
        self.last_why = d.get("last_why")

    def nudge(self, factor, why):
        v = self.value * factor
        if self.lo is not None: v = max(self.lo, v)
        if self.hi is not None: v = min(self.hi, v)
        self.value = v; self.n += 1; self.last_why = why
        return v

    def set(self, v, why):
        if self.lo is not None: v = max(self.lo, v)
        if self.hi is not None: v = min(self.hi, v)
        self.value = v; self.n += 1; self.last_why = why

    def to_dict(self):
        return {"prior": self.prior, "value": self.value, "lo": self.lo, "hi": self.hi, "n": self.n, "last_why": self.last_why}
