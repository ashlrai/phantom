#!/usr/bin/env python3
"""Run a bounded, foreground series of gated service recovery passes.

Each stdout line is metadata only; recovery output and exception messages are
never copied into the log. The existing recovery command owns all safety gates.
"""
import argparse
import io
import json
import math
import signal
import sys
import threading
import time

import recover_services


def positive_interval(value):
    try:
        number = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("interval must be a finite positive number")
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("interval must be a finite positive number")
    return number


def positive_passes(value):
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("max passes must be a positive integer")
    if number <= 0 or number > 10000:
        raise argparse.ArgumentTypeError("max passes must be between 1 and 10000")
    return number


def service(value):
    role, sep, label = value.partition("=")
    if not sep or role not in recover_services.ROLES or not recover_services.valid_label(label):
        raise argparse.ArgumentTypeError("service must be ROLE=<allowed launchd label>")
    return value


def main(argv=None, deps=None, out=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--interval-seconds", type=positive_interval, default=60.0)
    parser.add_argument("--max-passes", type=positive_passes, default=60)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--runs-dir")
    parser.add_argument("--service", action="append", type=service, default=[])
    parser.add_argument("--require-complete", action="store_true",
                        help="exit 0 only when the final attempted pass produced valid complete=true and exit code 0; "
                             "exhaustion with incomplete, exception, invalid report, nonzero child status, or "
                             "cancellation before any completed pass returns nonzero")
    args = parser.parse_args(argv)
    deps = deps or {}
    out = out or sys.stdout
    stop = deps.get("stop") or threading.Event()
    wait = deps.get("wait") or stop.wait
    now = deps.get("now") or time.time
    call = deps.get("call") or recover_services.main
    recovery_deps = deps.get("recovery_deps")
    recovery_args = ["--json"]
    if args.apply:
        recovery_args.append("--apply")
    if args.runs_dir is not None:
        recovery_args.extend(["--runs-dir", args.runs_dir])
    for item in args.service:
        recovery_args.extend(["--service", item])

    previous = {}
    def cancel(_signum, _frame):
        stop.set()
    # Python only permits signal handlers on the main thread.
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, cancel)
    try:
        final_record = None
        for index in range(1, args.max_passes + 1):
            if stop.is_set():
                break
            record = {"schema": "ashlr.recovery-watch.v1", "pass": index,
                      "at": int(now()), "apply": args.apply}
            try:
                captured = io.StringIO()
                code = call(recovery_args[:], deps=recovery_deps, out=captured)
                result = json.loads(captured.getvalue())
                if not isinstance(result, dict) or not isinstance(result.get("complete"), bool):
                    raise ValueError("invalid recovery result")
                record.update(exitCode=code if isinstance(code, int) else None,
                              complete=result["complete"], outcome="completed")
            except Exception:
                record.update(outcome="failed", complete=False)
            final_record = record
            print(json.dumps(record, separators=(",", ":")), file=out, flush=True)
            if index == args.max_passes or stop.is_set() or wait(args.interval_seconds):
                break
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    if args.require_complete:
        if final_record is None or not final_record.get("complete"):
            return 1
        if final_record.get("exitCode", 0) != 0:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
