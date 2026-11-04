"""Shared fail-open launch precheck; errors and usage never retire work."""
import os
import re
import signal
import subprocess


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
        env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG") if k in os.environ}
        env["GIT_TERMINAL_PROMPT"] = "0"
        r = runner(["/bin/bash", runs + "/bin/precheck.sh", task,
                    home + "/Projects/ashlrai/" + repo], 20, env=env, cwd=home)
        if r.returncode == 10:
            receipt = re.fullmatch(
                rf"SKIP {re.escape(job)} code=10 reason=(id_merged_pr_[1-9][0-9]*|pr_[1-9][0-9]*_(?:MERGED|CLOSED))\n?",
                r.stdout)
            return (10, receipt.group(1)) if receipt else (13, "unproven_completion")
        if r.returncode in (11, 12, 13):
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


def park(state, job, key, now):
    """Retry at 1, 2, 4, ... 60 minutes; report only the first parking."""
    previous = state.get(job, {})
    first = previous.get("key") != key
    count = 1 if first else min(previous.get("count", 0) + 1, 7)
    state[job] = {"key": key, "count": count,
                  "retry_at": now + min(3600, 60 * 2 ** (count - 1))}
    return first
