#!/usr/bin/env python3
"""Bounded, gated reopening of allowlisted macOS GUI apps after recovery.

Companion to recover_services.py. Once fleet services report complete after a
reboot or a watch pass, each app in the fixed RECOVER_APPS allowlist gets a
status probe and, under --apply, one bounded open — always through
app_control.handle(automatic=True), which refuses automatic termination. An
open is gated on healthy memory telemetry, no PAUSE sentinel, and a HOLD that
recover_services classifies 'absent' or 'stale'; a failed or unknown reading
skips the app with a reason. At most one open per app in 30 minutes, receipted
atomically at mode 0600 under <runs-dir>/recovery-receipts/, so a crash loop
never reopens an app forever. This module spawns no process and runs no shell
or script command of its own; it has no termination path — nothing here ever
stops an app.
"""
import argparse, json, math, os, pwd, stat, sys, tempfile, time
from pathlib import Path

import app_control
import recover_services

RECOVER_APPS = ("phantom",)   # fixed allowlist; no flag, file or argument extends it
SCHEMA = "ashlr.app-recovery.v1"
RECEIPT_SCHEMA = "ashlr.app-launch.v1"
LAUNCH_WINDOW_SECONDS = 1800


def launch_gate(tele, paused, pause_detail, hold, hold_detail):
    """→ None when an open is allowed, else the skip reason."""
    if tele["healthy"] is not True:
        return "memory telemetry unsafe or unknown"
    if paused is not False:
        return "paused: " + pause_detail
    if hold not in ("absent", "stale"):
        return "HOLD %s: %s" % (hold, hold_detail)
    return None


def receipt_path(runs_dir, app):
    return runs_dir / "recovery-receipts" / ("app-launch-%s.json" % app)


def read_receipt(path):
    """→ (launchedAt|None, state). Unreadable, non-regular or corrupt receipts
    fail closed: a lost bound must never unbound a crash loop."""
    try:
        st = path.lstat()
    except FileNotFoundError:
        return None, "absent"
    except OSError as e:
        return None, "unreadable:" + type(e).__name__
    if not stat.S_ISREG(st.st_mode):
        return None, "not-regular"
    try:
        doc = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None, "corrupt"
    at = isinstance(doc, dict) and doc.get("launchedAt")
    if not isinstance(doc, dict) or doc.get("schema") != RECEIPT_SCHEMA \
            or not isinstance(at, (int, float)) or isinstance(at, bool) \
            or not math.isfinite(at):
        return None, "corrupt"
    return float(at), "ok"


def write_receipt(path, app, now):
    """Atomic mode-0600 replace (mkstemp is O_EXCL and never follows links)."""
    path.parent.mkdir(exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".",
                             suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump({"schema": RECEIPT_SCHEMA, "app": app,
                       "launchedAt": int(now)}, handle, indent=1, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def check_app(name, apply, gate, runs_dir, system, now):
    """One app: probe status, then open only when --apply clears the gate and
    the 30-minute bound. The bound is persisted before the open is dispatched;
    an attempt that left the app down still consumes the window."""
    entry = {"app": name}
    status = app_control.handle("status", name, True, str(runs_dir), system)
    if not status.get("ok"):
        return {**entry, "status": "unknown",
                "detail": "status probe: " + str(status.get("code"))}
    if status.get("running"):
        return {**entry, "status": "running", "detail": "already running"}
    if not apply:
        return {**entry, "status": "stopped",
                "detail": "not running; run --apply to open"}
    if gate:
        return {**entry, "status": "skipped", "detail": gate}
    path = receipt_path(runs_dir, name)
    last, state = read_receipt(path)
    if state not in ("absent", "ok"):
        return {**entry, "status": "skipped", "detail": "launch receipt " + state}
    if last is not None and now - last < LAUNCH_WINDOW_SECONDS:
        return {**entry, "status": "skipped",
                "detail": "bounded: opened %ds ago; window closes in %ds"
                          % (int(now - last), int(math.ceil(last + LAUNCH_WINDOW_SECONDS - now)))}
    try:
        write_receipt(path, name, now)
    except OSError as e:
        return {**entry, "status": "failed",
                "detail": "receipt write " + type(e).__name__}
    result = app_control.handle("launch", name, True, str(runs_dir), system)
    if result.get("ok"):
        return {**entry, "status": "launched",
                "detail": "%s; bounded for %ds" % (result.get("code"), LAUNCH_WINDOW_SECONDS)}
    return {**entry, "status": "failed", "detail": str(result.get("code"))}


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true",
                    help="open allowlisted apps that are not running; default reports status only")
    ap.add_argument("--runs-dir",
                    help="runs state directory (default ~/.ashlr-runs of the uid account)")
    return ap.parse_args(argv)


def main(argv=None, deps=None, out=None):
    args = parse_args(argv)
    deps = deps or {}
    out = out or sys.stdout
    runner = deps.get("runner") or recover_services.Runner()
    system = deps.get("system")
    uid = deps.get("uid", os.getuid())
    dep_now = deps.get("now", time.time)
    now = dep_now() if callable(dep_now) else dep_now
    home = Path(deps.get("home") or pwd.getpwuid(uid).pw_dir)
    runs_dir = Path(args.runs_dir) if args.runs_dir else home / ".ashlr-runs"
    tele = recover_services.telemetry(runner)
    paused, pause_detail = recover_services.pause_state(runs_dir)
    hold, hold_detail = recover_services.classify_hold(runs_dir, now)
    gate = launch_gate(tele, paused, pause_detail, hold, hold_detail)
    apps = [check_app(name, args.apply, gate, runs_dir, system, now)
            for name in RECOVER_APPS]
    print(json.dumps({"schema": SCHEMA, "at": int(now), "apply": args.apply,
                      "telemetry": tele, "apps": apps}, indent=2), file=out)
    return 2 if any(app["status"] == "failed" for app in apps) else 0


if __name__ == "__main__":
    sys.exit(main())
