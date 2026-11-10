"""Shared fail-open launch precheck; errors and usage never retire work."""
import json
import os
import re
import signal
import subprocess

# RQ-EMPTYJOBYIELDQ8: a job id whose last EMPTY_STREAK finishes in jobs.jsonl all
# came back empty repeats work that already yielded nothing — retire it instead
# of launching again. Reads only the bounded metrics tail; a missing or
# unreadable ledger, an unmeasured finish, a productive finish or a MERGED
# outcome each fail open (no suppression).
EMPTY_STREAK = 2
EMPTY_CODE = 14
METRICS_TAIL_BYTES = 8 * 1024 * 1024
# The fleet's canonical empty finish kinds (src/core/fleet/lane-empty-streak.ts).
_TERMINAL_EMPTY = {"EMPTY", "DONE-NOOP", "EMPTY_DONE", "SKIPPED-EMPTY"}
_streak_cache = {}


def empty_streaks(jobs_path):
    """job id -> count of consecutive trailing empty finishes; {} on any read problem."""
    try:
        stat = os.stat(jobs_path)
        if stat.st_size == 0:
            return {}
        key = (stat.st_size, stat.st_mtime_ns)
    except OSError:
        return {}
    cached = _streak_cache.get(jobs_path)
    if cached is not None and cached[0] == key:
        return cached[1]
    try:
        with open(jobs_path, "rb") as stream:
            if stat.st_size > METRICS_TAIL_BYTES:
                stream.seek(stat.st_size - METRICS_TAIL_BYTES)
                stream.readline()   # drop the torn first line
            text = stream.read().decode("utf-8", "replace")
    except OSError:
        return {}
    streaks = {}
    for line in text.splitlines():
        if ("empty" not in line and "finish" not in line and "MERGED" not in line
                and "EMPTY" not in line and "NOOP" not in line):
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        job = row.get("job") or row.get("job_id") or row.get("jobId")
        if not isinstance(job, str) or not job:
            continue
        outcome = str(row.get("state") or row.get("outcome") or row.get("event") or "").upper()
        if row.get("event") == "merged" or outcome == "MERGED":
            streaks[job] = 0
        elif outcome in _TERMINAL_EMPTY or row.get("empty") is True:
            streaks[job] = streaks.get(job, 0) + 1
        elif row.get("event") == "finish" or row.get("empty") is False:
            streaks[job] = 0
    _streak_cache.clear()
    _streak_cache[jobs_path] = (key, streaks)
    return streaks


def run(cmd, timeout, **kwargs):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         stdin=subprocess.DEVNULL, text=True, start_new_session=True, **kwargs)
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try: os.killpg(p.pid, signal.SIGKILL)
        except OSError: pass
        p.communicate()
        raise
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


def precheck(job, repo, prompt, home, runs, runner=run):
    try:
        task = next((t for t in prompt.splitlines() if t.startswith(job + " (")), "")
        if not task: return None
        streak = empty_streaks(runs + "/metrics/jobs.jsonl").get(job, 0)
        if streak >= EMPTY_STREAK:
            return (EMPTY_CODE, "empty_streak_%dx" % streak)
        env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG") if k in os.environ}
        env["GIT_TERMINAL_PROMPT"] = "0"
        r = runner(["/bin/bash", runs + "/bin/precheck.sh", task,
                    home + "/Projects/ashlrai/" + repo], 20, env=env, cwd=home)
        if r.returncode == 10:
            receipt = re.fullmatch(
                rf"SKIP {re.escape(job)} code=10 reason=(id_merged_pr_[1-9][0-9]*|pr_[1-9][0-9]*_(?:MERGED|CLOSED))\n?",
                r.stdout)
            return (10, receipt.group(1)) if receipt else (13, "unproven_completion")
        if r.returncode == 13:
            # Only retain known, exact receipts: subprocess output is untrusted and
            # may contain credentials. Existence heuristics never prove completion.
            receipt = re.fullmatch(
                rf"SKIP {re.escape(job)} code=13 reason=(files_and_tests_exist|symbols_defined)\n?",
                r.stdout)
            return (13, receipt.group(1) if receipt else "invalid_or_unknown_receipt")
        if r.returncode in (11, 12):
            m = re.search(r"reason=(\S+)", r.stdout)
            return (r.returncode, m.group(1) if m else "?")
    except Exception:
        pass
    return None


def park_key(line, prompt):
    """Only queue input changes reset a job's retry history."""
    import hashlib
    return hashlib.sha256((line + "\0" + prompt).encode()).hexdigest()


def parked(state, job, key, now):
    entry = state.get(job)
    if not isinstance(entry, dict) or entry.get("key") != key:
        state.pop(job, None)
        return False
    return now < entry.get("retry_at", 0)


def park(state, job, key, now, code=None, reason=None):
    """Retry at 1, 2, 4, ... 60 minutes; report only the first parking."""
    previous = state.get(job, {})
    first = previous.get("key") != key
    count = 1 if first else min(previous.get("count", 0) + 1, 7)
    state[job] = {"key": key, "count": count,
                  "retry_at": now + min(3600, 60 * 2 ** (count - 1))}
    if code is not None:
        state[job].update(code=code, reason=reason)
    return first
