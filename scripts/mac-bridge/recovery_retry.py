#!/usr/bin/env python3
"""Bounded gated recovery passes with a per-service kickstart cooldown.

Foreground loop around recover_services.main with a Runner adapter injected;
the adapter passes probes and telemetry through untouched and intercepts only
the exact `launchctl kickstart gui/<uid>/<label>` argv recover_services
produces. After an actual start attempt, further kickstarts of that service
are refused for a capped exponential cooldown, so a service that starts and
immediately exits is not hammered while a merely stopped one still recovers.
An observed running service clears its streak. Retry state persists atomically
at mode 0600; corrupt state, unsafe files and wall-clock rollback fail closed
for mutations. Concurrent --apply invocations serialize on an advisory lock;
preview passes never mutate. No -k, bootstrap, enable, GUI launch or
installation ever occurs.
"""
import argparse, fcntl, io, json, math, os, pwd, re, signal, stat, sys, tempfile, threading, time
from pathlib import Path

import recover_services
from recovery_watch import positive_interval, positive_passes, service

SCHEMA = "ashlr.recovery-retry.v1"
STATE_SCHEMA = "ashlr.recovery-retry-state.v1"
STATE_NAME = "recovery-retry-state.json"
EXIT_LOCKED = 3
TARGET_RE = re.compile(r"gui/\d+/([a-zA-Z0-9.-]+)\Z")
PID_RE = re.compile(r"(?im)^\s*pid\s*=\s*(\d+)")
STATE_RE = re.compile(r"(?im)^\s*state\s*=\s*([a-z ]+)")


def cooldown_seconds(value):
    try:
        number = float(value)
    except ValueError:
        number = math.nan
    if not math.isfinite(number) or number <= 0 or number > 86400:
        raise argparse.ArgumentTypeError("cooldown must be a finite positive number <= 86400")
    return number


def load_state(path, now):
    """→ (services, status, detail). Unreadable, non-regular, permissive, corrupt
    or future-written state is unsafe; callers must fail closed for mutations."""
    try:
        st = path.lstat()
    except FileNotFoundError:
        return {}, "ok", ""
    except OSError as e:
        return None, "unreadable", type(e).__name__
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077:
        return None, "unsafe", "not a private regular file"
    try:
        doc = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as e:
        return None, "corrupt", type(e).__name__
    max_seen = isinstance(doc, dict) and doc.get("maxSeen")
    if not isinstance(max_seen, (int, float)) or isinstance(max_seen, bool) \
            or not math.isfinite(max_seen):
        return None, "corrupt", "maxSeen"
    if now < max_seen:
        return None, "rollback", "wall clock precedes recorded write"
    services = doc.get("services")
    if doc.get("schema") != STATE_SCHEMA or not isinstance(services, dict):
        return None, "corrupt", "schema"
    out = {}
    for label, entry in services.items():
        attempts = isinstance(entry, dict) and entry.get("attempts")
        last = isinstance(entry, dict) and entry.get("lastAttempt")
        if not (recover_services.valid_label(label)
                and isinstance(attempts, int) and not isinstance(attempts, bool)
                and 0 <= attempts <= 100000
                and isinstance(last, (int, float)) and not isinstance(last, bool)
                and math.isfinite(last) and 0 <= last <= max_seen):
            return None, "corrupt", "entry"
        out[label] = {"attempts": attempts, "lastAttempt": float(last)}
    return out, "ok", ""


def save_state(path, services, now):
    """Atomic mode-0600 replace (mkstemp is O_EXCL and never follows symlinks)."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump({"schema": STATE_SCHEMA, "maxSeen": now, "services": services},
                      handle, indent=1, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        dfd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def acquire_lock(state_path):
    """Blocking advisory lock serializing concurrent --apply invocations → fd."""
    lock_path = str(state_path) + ".lock"
    try:
        if not stat.S_ISREG(os.lstat(lock_path).st_mode):
            raise OSError("lock path is not a regular file")
    except FileNotFoundError:
        pass
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


class CooldownRunner:
    """Runner seam over recover_services' runner. Every argv passes through
    unchanged except the exact kickstart triple, gated by persisted cooldown."""

    def __init__(self, inner, state_path, now, apply, base, cap):
        self.inner, self.state_path, self.now = inner, state_path, now
        self.base, self.cap = base, cap
        self.services = {}
        self.status, self.detail = "preview", "no --apply; state untouched"
        self.decisions = []
        if apply:
            loaded, self.status, self.detail = load_state(state_path, now())
            self.services = loaded or {}

    def begin_pass(self):
        self.decisions = []

    @staticmethod
    def _label(argv, verb):
        if len(argv) == 3 and argv[0] == "launchctl" and argv[1] == verb:
            match = TARGET_RE.fullmatch(argv[2])
            if match and recover_services.valid_label(match.group(1)):
                return match.group(1)
        return None

    def _mutate(self, label, entry):
        """Persist a mutation first; a failed write restores and returns False."""
        previous = self.services.get(label)
        if entry is None:
            self.services.pop(label, None)
        else:
            self.services[label] = entry
        try:
            save_state(self.state_path, self.services, self.now())
            return True
        except OSError:
            if previous is None:
                self.services.pop(label, None)
            else:
                self.services[label] = previous
            return False

    def _observe(self, argv, result):
        """A probe reporting a tracked service running clears its streak."""
        label = self._label(argv, "print")
        if label is None or label not in self.services or self.status != "ok":
            return
        rc, out, _err, fault = result
        pid, state = PID_RE.search(out), STATE_RE.search(out)
        if fault or rc != 0 or not ((pid and int(pid.group(1)) > 0)
                                    or (state and state.group(1).strip() == "running")):
            return
        if self._mutate(label, None):
            self.decisions.append({"label": label, "action": "cleared"})

    def _kickstart(self, argv, timeout, label):
        if self.status != "ok":
            self.decisions.append({"label": label, "action": "refused", "reason": self.status})
            return -1, "", "", "retry-state-" + self.status
        entry = self.services.get(label)
        if entry and entry["attempts"] > 0:
            delay = min(self.base * (1 << min(entry["attempts"] - 1, 20)), self.cap)
            remaining = entry["lastAttempt"] + delay - self.now()
            if remaining > 0:
                wait_s = int(math.ceil(remaining))
                self.decisions.append({"label": label, "action": "cooldown",
                                       "attempts": entry["attempts"], "retryInSeconds": wait_s})
                return -1, "", "", "cooldown %ds" % wait_s
        entry = {"attempts": (entry["attempts"] if entry else 0) + 1,
                 "lastAttempt": self.now()}
        if not self._mutate(label, entry):   # never dispatch an unrecorded attempt
            self.decisions.append({"label": label, "action": "refused", "reason": "state-write"})
            return -1, "", "", "retry-state-write"
        self.decisions.append({"label": label, "action": "attempted", "attempts": entry["attempts"]})
        return self.inner.run(argv, timeout)

    def run(self, argv, timeout):
        label = self._label(list(argv), "kickstart")
        if label is not None:
            return self._kickstart(argv, timeout, label)
        result = self.inner.run(argv, timeout)
        self._observe(argv, result)
        return result


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--max-passes", type=positive_passes, default=60)
    ap.add_argument("--interval-seconds", type=positive_interval, default=60.0)
    ap.add_argument("--apply", action="store_true",
                    help="allow kickstarts through the cooldown gate; default is preview")
    ap.add_argument("--runs-dir", help="forwarded to recover_services --runs-dir")
    ap.add_argument("--service", action="append", type=service, default=[],
                    metavar="ROLE=LABEL", help="forwarded to recover_services --service")
    ap.add_argument("--state-file",
                    help="private retry-state path (default <runs-dir>/%s)" % STATE_NAME)
    ap.add_argument("--cooldown-base-seconds", type=cooldown_seconds, default=60.0)
    ap.add_argument("--cooldown-max-seconds", type=cooldown_seconds, default=1800.0)
    return ap.parse_args(argv)


def main(argv=None, deps=None, out=None):
    args = parse_args(argv)
    deps = deps or {}
    out = out or sys.stdout
    stop = deps.get("stop") or threading.Event()
    wait = deps.get("wait") or stop.wait
    now = deps.get("now") or time.time
    call = deps.get("call") or recover_services.main
    recovery_deps = dict(deps.get("recovery_deps") or {})
    uid = recovery_deps.get("uid", os.getuid())
    home = Path(recovery_deps.get("home") or pwd.getpwuid(uid).pw_dir)
    runs_dir = Path(args.runs_dir) if args.runs_dir else home / ".ashlr-runs"
    state_path = Path(args.state_file) if args.state_file else runs_dir / STATE_NAME
    inner = recovery_deps.get("runner") or recover_services.Runner()
    recovery_args = ["--json"] + (["--apply"] if args.apply else [])
    if args.runs_dir is not None:
        recovery_args += ["--runs-dir", args.runs_dir]
    for item in args.service:
        recovery_args += ["--service", item]
    previous = {}

    def cancel(_signum, _frame):
        stop.set()

    if threading.current_thread() is threading.main_thread():  # signals: main only
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, cancel)
    lock_fd = None
    try:
        if args.apply:
            try:
                lock_fd = acquire_lock(state_path)     # held before any state read
            except OSError as e:
                print(json.dumps({"schema": SCHEMA, "at": int(now()), "apply": True,
                                  "outcome": "lock-failed", "detail": type(e).__name__},
                                 separators=(",", ":")), file=out, flush=True)
                return EXIT_LOCKED
        adapter = CooldownRunner(inner, state_path, now, args.apply,
                                 args.cooldown_base_seconds, args.cooldown_max_seconds)
        recovery_deps.update(runner=adapter, now=now)
        for index in range(1, args.max_passes + 1):
            if stop.is_set():
                break
            adapter.begin_pass()
            record = {"schema": SCHEMA, "pass": index, "at": int(now()),
                      "apply": args.apply, "retryState": adapter.status}
            if adapter.detail:
                record["retryDetail"] = adapter.detail
            try:
                captured = io.StringIO()
                code = call(recovery_args[:], deps=recovery_deps, out=captured)
                report = json.loads(captured.getvalue())
                if not isinstance(report, dict) or not isinstance(report.get("services"), list):
                    raise ValueError("invalid recovery result")
                decisions = {d["label"]: d for d in adapter.decisions}
                services = {}
                for item in report["services"]:
                    entry = {"status": item["status"]}
                    label = item.get("label")
                    if label:
                        entry["label"] = label
                    decision = decisions.get(label)
                    if decision and decision["action"] == "cooldown":
                        entry.update(status="cooldown", attempts=decision["attempts"],
                                     retryInSeconds=decision["retryInSeconds"])
                    elif decision and decision["action"] == "attempted":
                        entry["attempts"] = decision["attempts"]
                    elif decision and decision["action"] == "refused":
                        entry["refused"] = decision["reason"]
                    elif decision and decision["action"] == "cleared":
                        entry["cleared"] = True
                    services[item["role"]] = entry
                record.update(exitCode=code if isinstance(code, int) else None,
                              complete=bool(report.get("complete")),
                              outcome="completed", services=services)
            except Exception:
                record.update(outcome="failed", complete=False)
            print(json.dumps(record, separators=(",", ":")), file=out, flush=True)
            if index == args.max_passes or stop.is_set() or wait(args.interval_seconds):
                break
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if lock_fd is not None:
            os.close(lock_fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
