"""CRUISE-1: per-node closed-loop concurrency (AIMD) with learned limits.

OS-neutral controller (controller.py, learn.py, watchdog.py, shed.py) on top of the
OS-sensor interface (sensors.py). macOS is the first provider; Linux is implemented;
Windows is a stub that reports "unknown" so the controller holds instead of guessing.
Pure stdlib, Python 3.9+, no network, no privileges, never reads secrets.
"""
__all__ = ["sensors", "learn", "controller", "shed", "watchdog", "profiles", "markers"]
SCHEMA_VERSION = "ashlr.cruise.v1"
