#!/usr/bin/env python3
"""Devin overage hard-stop (Security -sec). Local file I/O only. Logs reason ids, never bodies.

check
    Fail closed if queue/DEVIN_STOP exists or is unreadable, OR fleet ~/.ashlr/KILL
    or ~/.ashlr-runs/KILL is present. Exit 0 if clear, 3 if stopped.
classify <rc> <log>
    Print a reason id or "ok". Never writes. Exit 0.
scan <job> <rc> <log>
    Classify; on a hit, hold slots.json devin and devin-flash (target 0,
    ceiling unchanged) under dispatchd.lock and write queue/DEVIN_STOP
    (O_CREAT|O_EXCL|O_NOFOLLOW, 0600) with a reason id only. Exit 0 on ok,
    4 on a stop applied or already stopped.
"""
from __future__ import annotations

import fcntl, json, os, re, stat, sys, time

# Tests set ASHLR_RUNS to a temp root. Production uses ~/.ashlr-runs via pwd.
def _runs():
    e = os.environ.get("ASHLR_RUNS")
    if e:
        return e
    import pwd
    return os.path.join(pwd.getpwuid(os.getuid()).pw_dir, ".ashlr-runs")


def _realhome_from_runs(runs):
    """Parent of .ashlr-runs when path ends with it; else None."""
    runs = os.path.abspath(runs)
    base = os.path.basename(runs.rstrip("/"))
    if base == ".ashlr-runs":
        return os.path.dirname(runs)
    return None


# Real overage / billing / purchase / plan-exhaustion / auto-recharge.
# Prefer ERROR/Error/API Error line prefixes or structured JSON keys so model
# or task prose mentioning "overage" / "buy more" does not trip the stop.
_ERR = r"(?im)^(?:ERROR|Error|API Error)\s*:\s*"
_PATTERNS = [
    ("devin_buy_more", re.compile(
        _ERR + r".*\b(?:buy more(?:\s+ACUs?)?|buy-more|purchase more ACUs?|purchase additional ACUs?)\b.*$")),
    ("devin_acu_purchase", re.compile(
        _ERR + r".*\b(?:ACU purchases?|purchase ACUs?|add ACUs?|top[ -]?up ACUs?|quota purchase|extra ACUs?)\b.*$")),
    ("devin_auto_recharge", re.compile(
        _ERR + r".*\b(?:auto[ -]?recharge|automatic recharge|auto[ -]?top[ -]?up)\b.*$")),
    ("devin_overage", re.compile(
        _ERR + r".*\b(?:overage|beyond (?:your|the) plan|usage beyond (?:your|the) (?:plan|allowance)|"
        r"enable overage|pay[ -]?as[ -]?you[ -]?go|usage[ -]?based billing)\b.*$")),
    ("devin_billing", re.compile(
        _ERR + r".*\b(?:billing_error|billing (?:error|required)|payment[ _-]?required|"
        r"HTTP[ /]?402|status(?:code)?[ :=]+402)\b.*$")),
    ("devin_acu_exhausted", re.compile(
        _ERR + r"(?:ACU (?:limit|quota|allowance) (?:reached|exceeded)|"
        r"ACUs? (?:are |have been )?(?:exhausted|depleted)|out of ACUs|"
        r"(?:included )?ACUs? (?:exhausted|exceeded)|exceeded (?:your |the )?included ACUs?)\b.*$")),
    ("devin_weekly_quota", re.compile(
        _ERR + r"(?:Agent error: )?Your weekly usage quota has been exhausted\b.*$")),
    ("devin_plan_exhausted", re.compile(
        _ERR + r"(?:plan usage (?:has been )?(?:exhausted|exceeded|run out)|out of plan usage|"
        r"included (?:allowance|usage) (?:exhausted|exceeded))\b.*$")),
]
# Structured JSON / key=value billing signals (not free prose).
_STRUCT = [
    ("devin_overage", re.compile(
        r'(?i)(?:"(?:error|code|reason|type|status)"\s*:\s*"(?:overage|acu_overage|plan_overage|usage_overage)"|'
        r"\b(?:overage|acu_overage|enable_overage)\s*[:=]\s*(?:true|1|yes)\b)")),
    ("devin_auto_recharge", re.compile(
        r'(?i)(?:"(?:auto_recharge|autoRecharge|automatic_recharge)"\s*:\s*(?:true|1|"true")|'
        r"\bauto_recharge\s*[:=]\s*(?:true|1|yes)\b)")),
    ("devin_buy_more", re.compile(
        r'(?i)(?:"(?:buy_more|buy_more_acus|buyMoreAcus)"\s*:\s*(?:true|1|"true")|'
        r"\bbuy_more_acus?\s*[:=]\s*(?:true|1|yes)\b)")),
    ("devin_billing", re.compile(
        r'(?i)(?:"(?:error|type|code)"\s*:\s*"(?:billing_error|payment_required|billing)"|'
        r'"status"\s*:\s*402\b)')),
    ("devin_acu_purchase", re.compile(
        r'(?i)(?:"(?:acu_purchase|purchase_acus|extra_acus)"\s*:\s*(?:true|1|"true"|\d+)|'
        r"\bextra_acus?\s*[:=]\s*(?:true|1|[1-9]\d*)\b)")),
]
_NEVER = re.compile(
    r"(?im)^(Claude AI usage limit reached|tokens? used\b|total_cost_usd\b|"
    r".*\b429\b.{0,80}\brate[ _-]?limit|"
    r"ERROR: unexpected status 429\b)"
)
REASON = re.compile(r"^[a-z][a-z0-9_]{1,40}$")
JID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


def _read_log(path, n=65536):
    if not path or os.path.islink(path) or not os.path.isfile(path):
        return ""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            z = f.tell()
            f.seek(max(0, z - n))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def classify(rc, log_text):
    # rc is recorded for callers; classification is from CLI / structured text.
    _ = rc
    if not log_text:
        return None
    lines = [ln for ln in log_text.splitlines() if not _NEVER.search(ln)]
    text = "\n".join(lines)
    for pid, rx in _PATTERNS:
        if rx.search(text):
            return pid
    for pid, rx in _STRUCT:
        if rx.search(text):
            return pid
    return None


def _stopped(path):
    parent = os.path.dirname(path) or "."
    try:
        os.lstat(parent)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    if not os.access(parent, os.R_OK | os.X_OK):
        return True
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return True


def check(runs):
    # Fleet KILL (passwd-home .ashlr/KILL) and runs-tree KILL also mean stop.
    home = _realhome_from_runs(runs)
    if home:
        if _stopped(os.path.join(home, ".ashlr", "KILL")):
            print("HELD: KILL")
            return 3
    if _stopped(os.path.join(runs, "KILL")):
        print("HELD: KILL")
        return 3
    stop = os.path.join(runs, "queue", "DEVIN_STOP")
    if _stopped(stop):
        print("HELD: DEVIN_STOP")
        return 3
    print("ok")
    return 0


def _write_stop(path, reason):
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        fs = os.fstat(fd)
        if not (stat.S_ISREG(fs.st_mode) and fs.st_nlink == 1
                and stat.S_IMODE(fs.st_mode) == 0o600):
            raise OSError("DEVIN_STOP fstat refused")
        os.write(fd, (reason + "\n").encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)


_HOLD_LANES = ("devin", "devin-flash")


def _hold_one(data, lane, reason, now):
    d = data.get(lane)
    if not isinstance(d, dict):
        d = {}
        data[lane] = d
    if "target_before_hold" not in d and isinstance(d.get("target"), int) and d.get("target") > 0:
        d["target_before_hold"] = d["target"]
    d["held"] = True
    d["target"] = 0
    d["held_by"] = "devin-overage-stop"
    d["held_reason"] = reason  # reason id only
    d["last_change"] = now
    # Never raise ceiling or hard_cap; leave them as they are.


def _hold_slots(slots_path, reason, now):
    with open(slots_path, "r+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("slots.json is not an object")
        for lane in _HOLD_LANES:
            _hold_one(data, lane, reason, now)
        f.seek(0)
        json.dump(data, f, indent=2)
        f.write("\n")
        f.truncate()
        f.flush()
        os.fsync(f.fileno())


def _log_reason(runs, job, reason):
    ev = os.path.join(runs, "dispatch-events.log")
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = "%s DEVIN_STOP reason=%s job=%s\n" % (
        ts, reason, job if JID.match(job or "") else "invalid")
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW
    try:
        fd = os.open(ev, flags, 0o600)
        try:
            os.write(fd, line.encode("ascii"))
        finally:
            os.close(fd)
    except OSError:
        pass


def apply(runs, job, reason):
    if not REASON.match(reason):
        print("invalid_reason")
        return 2
    queue = os.path.join(runs, "queue")
    os.makedirs(queue, exist_ok=True)
    lockp = os.path.join(runs, "dispatchd.lock")
    stop = os.path.join(queue, "DEVIN_STOP")
    slots = os.path.join(queue, "slots.json")
    lk = os.open(lockp, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lk, fcntl.LOCK_EX)
        if _stopped(stop):
            # Already stopped; still enforce held+target 0 on devin and devin-flash if slots exist.
            if os.path.isfile(slots) and not os.path.islink(slots):
                _hold_slots(slots, reason, time.time())
            print(reason)
            return 4
        if os.path.isfile(slots) and not os.path.islink(slots):
            _hold_slots(slots, reason, time.time())
        _write_stop(stop, reason)
        _log_reason(runs, job, reason)
        print(reason)
        return 4
    finally:
        os.close(lk)


def scan(runs, job, rc, log_path):
    reason = classify(rc, _read_log(log_path))
    if not reason:
        print("ok")
        return 0
    return apply(runs, job, reason)


def main(argv):
    if len(argv) < 2 or argv[1] not in ("check", "classify", "scan"):
        print("usage: devin-overage-stop.py check | classify RC LOG | scan JOB RC LOG")
        return 2
    cmd = argv[1]
    runs = _runs()
    if cmd == "check":
        return check(runs)
    if cmd == "classify":
        if len(argv) < 4:
            print("usage: devin-overage-stop.py classify RC LOG")
            return 2
        try:
            rc = int(argv[2])
        except ValueError:
            rc = 1
        reason = classify(rc, _read_log(argv[3]))
        print(reason or "ok")
        return 0
    if len(argv) < 5:
        print("usage: devin-overage-stop.py scan JOB RC LOG")
        return 2
    job, rc_s, logp = argv[2], argv[3], argv[4]
    if not JID.match(job):
        job = "invalid"
    try:
        rc = int(rc_s)
    except ValueError:
        rc = 1
    return scan(runs, job, rc, logp)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
