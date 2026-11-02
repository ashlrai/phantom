#!/usr/bin/env python3
"""Run one recover_services pass under a hard wall-clock budget.

Spawns `recover_services.py --json` through the current interpreter in its
own process group, captures at most MAX_OUTPUT_BYTES of stdout, and
propagates the child's report and exit code when the report is valid.
Timeout, malformed/oversized output, or cancellation stops the whole
wrapper-owned process group within a bounded grace and yields a
metadata-only record, so a hung probe cannot keep recovery work or memory
alive. Nothing outside the spawned group is ever signalled.
"""
import argparse
import json
import math
import os
import select
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import recover_services

SCRIPT = Path(__file__).resolve().with_name("recover_services.py")
SCHEMA = "ashlr.recovery-bounded.v1"
MAX_OUTPUT_BYTES = 128 * 1024
KILL_GRACE_SECONDS = 3.0
MAX_TIMEOUT_SECONDS = 3600.0
EXIT_FAILED = 3
DETAIL = {
    "timeout": "pass exceeded the wall-clock budget; process group terminated",
    "invalid-output": "missing, malformed, or oversized recovery report",
    "cancelled": "cancelled; process group terminated",
}


def timeout_seconds(value):
    try:
        number = float(value)
    except ValueError:
        number = math.nan
    if not math.isfinite(number) or number <= 0 or number > MAX_TIMEOUT_SECONDS:
        raise argparse.ArgumentTypeError(
            "timeout must be a finite positive number <= %d" % MAX_TIMEOUT_SECONDS)
    return number


def service(value):
    role, sep, label = value.partition("=")
    if not sep or role not in recover_services.ROLES or not recover_services.valid_label(label):
        raise argparse.ArgumentTypeError("service must be ROLE=<allowed launchd label>")
    return value


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--pass-timeout-seconds", type=timeout_seconds, default=120.0,
                    help="wall-clock budget for the whole pass (default 120)")
    ap.add_argument("--runs-dir", help="forwarded to recover_services --runs-dir")
    ap.add_argument("--service", action="append", type=service, default=[],
                    metavar="ROLE=LABEL", help="forwarded to recover_services --service")
    ap.add_argument("--apply", action="store_true", help="forwarded; default is preview")
    return ap.parse_args(argv)


def child_argv(args, deps):
    argv = list(deps.get("child_argv") or (sys.executable, str(SCRIPT))) + ["--json"]
    if args.apply:
        argv.append("--apply")
    if args.runs_dir is not None:
        argv += ["--runs-dir", args.runs_dir]
    for item in args.service:
        argv += ["--service", item]
    return argv


def exited(proc):
    """Exit check without reaping (leader_failover protocol): the unreaped leader
    reserves its PID, keeping the group id safe to signal until cleanup ends."""
    try:
        return os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except (AttributeError, ChildProcessError, OSError):
        return proc.poll() is not None


def stop_group(proc, grace):
    """SIGTERM the group, allow grace, SIGKILL unconditionally — a dead leader
    can leave live descendants — then reap the leader."""
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 0)):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass
        end = time.monotonic() + wait
        while time.monotonic() < end:
            time.sleep(min(0.02, end - time.monotonic()))
    proc.wait()
    if proc.stdout is not None:
        proc.stdout.close()


def run_child(argv, stop, timeout, monotonic, grace, cap, popen):
    """Drive the child to a bounded outcome → (outcome, exit_code|None, bytes).
    Signals only the wrapper-owned process group."""
    try:
        proc = popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError as e:
        return "failed", None, ("spawn:" + type(e).__name__).encode()
    fd = proc.stdout.fileno()
    buf = bytearray()
    oversized = eof = False
    deadline = monotonic() + timeout
    while True:
        fail = ("cancelled" if stop.is_set() else
                "timeout" if monotonic() >= deadline else
                "invalid-output" if oversized else None)
        if fail:
            stop_group(proc, grace)
            return fail, None, bytes(buf)
        remaining = deadline - monotonic()
        if not eof:
            ready, _, _ = select.select([fd], [], [], min(0.05, remaining))
            if ready:
                chunk = os.read(fd, min(65536, cap + 1 - len(buf)))
                if chunk:
                    buf += chunk
                    oversized = len(buf) > cap
                    continue
                eof = True
        if exited(proc):
            # Drain pre-exit bytes; a stray descendant's later writes are
            # outside the report.
            while len(buf) <= cap and select.select([fd], [], [], 0)[0]:
                chunk = os.read(fd, min(65536, cap + 1 - len(buf)))
                if not chunk:
                    break
                buf += chunk
            rc = proc.wait()
            proc.stdout.close()
            return ("invalid-output" if len(buf) > cap else "exited"), rc, bytes(buf)
        if eof:
            time.sleep(min(0.02, remaining))


def main(argv=None, deps=None, out=None):
    args = parse_args(argv)
    deps = deps or {}
    out = out or sys.stdout
    stop = deps.get("stop") or threading.Event()
    monotonic = deps.get("monotonic") or time.monotonic
    previous = {}

    def cancel(_signum, _frame):
        stop.set()

    if threading.current_thread() is threading.main_thread():  # signals: main only
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, cancel)
    started = monotonic()
    try:
        if stop.is_set():
            outcome, rc, data = "cancelled", None, b""
        else:
            outcome, rc, data = run_child(child_argv(args, deps), stop,
                                          args.pass_timeout_seconds, monotonic,
                                          deps.get("grace", KILL_GRACE_SECONDS),
                                          deps.get("max_output", MAX_OUTPUT_BYTES),
                                          deps.get("popen", subprocess.Popen))
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    elapsed = monotonic() - started
    if outcome == "exited":
        try:
            text = data.decode("utf-8")
            report = json.loads(text)
        except ValueError:
            report = None
        if isinstance(report, dict) and isinstance(report.get("complete"), bool):
            out.write(text if text.endswith("\n") else text + "\n")
            return rc if isinstance(rc, int) else EXIT_FAILED
        outcome = "invalid-output"
    now = deps.get("now") or time.time
    record = {"schema": SCHEMA, "outcome": outcome, "at": int(now()), "apply": args.apply,
              "timeoutSeconds": args.pass_timeout_seconds, "exitCode": rc,
              "outputBytes": len(data), "durationMs": int(elapsed * 1000),
              "detail": DETAIL.get(outcome) or data.decode("utf-8", "replace")}
    print(json.dumps(record, separators=(",", ":")), file=out, flush=True)
    return EXIT_FAILED


if __name__ == "__main__":
    sys.exit(main())
