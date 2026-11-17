"""Shared fail-open launch precheck; errors and usage never retire work."""
import json
import os
import re
import signal
import subprocess
from datetime import datetime


def merged_jobs(rows):
    """Exact job/repo receipts only; missing legacy repos use fleet-wide IDs."""
    return {(repo.removeprefix("ashlrai/") if repo is not None else None, row['job'])
            for row in rows if isinstance(row, dict) and row.get('launched') is not False
            and row.get('event') == 'outcome' and row.get('state') == 'MERGED'
            and isinstance(row.get('job'), str)
            for repo in [row.get('repo')] if repo is None or isinstance(repo, str)}


def request_hash(job, repo, prompt):
    """Conservative identity: preserve case, PR targets, dependencies and scope.

    Only scheduling fields differ safely. Continuations and other context count.
    """
    import hashlib
    tasks = [line for line in prompt.splitlines() if line.startswith(job + " (")]
    if len(tasks) != 1: return None
    match = re.fullmatch(re.escape(job) + r" \(([^)]*)\):\s*(.{16,})", tasks[0])
    if not match: return None
    attrs = sorted(a.strip() for a in match[1].split(',') if a.strip()
                   and not re.fullmatch(r"P[0-9]+|(?:pool|tier|repo)=[^,]+", a.strip()))
    before, _, after = prompt.partition(tasks[0])
    before = re.sub(r"\AJob " + re.escape(job) + r" \(pool [^,\n]+, tier [^,\n]+, repo [^)\n]+\)\. Task from the Ashlr router queue, verbatim:\n\n", "", before)
    return hashlib.sha256(json.dumps([repo, attrs, match[2], before, after], separators=(',', ':')).encode()).hexdigest()


def admission_history(rows, now):
    """24h resolved launches by (prefix, tier, lane); unmatched evidence stays unknown."""
    attempts, latest, urls, states = {}, {}, {}, {}
    timed = []
    for row in rows:
        if not isinstance(row, dict): continue
        try:
            stamp = datetime.fromisoformat(row.get("ts", row.get("timestamp", row.get("at", ""))).replace("Z", "+00:00"))
            at = stamp.timestamp()
            if not stamp.tzinfo or at > now: continue
        except (ValueError, TypeError, AttributeError, OverflowError): continue
        timed.append((at, row))
    for at, row in sorted(timed, key=lambda x: x[0]):
        job, repo = row.get("job"), row.get("repo", "")
        if not isinstance(job, str) or not isinstance(repo, str): continue
        key = (repo.removeprefix("ashlrai/"), job)
        if not repo:
            matches = [k for k in latest if k[1] == job]
            if len(matches) == 1: key = matches[0]  # finish/publish rows omit repo
        event, state = row.get("event"), row.get("state", row.get("outcome"))
        url = row.get("url", row.get("prUrl"))
        if not isinstance(url, str): url = None
        if event == "outcome" and url and state in ("MERGED", "CLOSED", "OPEN"):
            states[url.rstrip("/")] = state if state == "MERGED" or now - at <= 300 else "unknown"
        if (event == "launch" and now - at < 86400
                and all(isinstance(row.get(k), str) for k in ("tier", "lane"))):
            aid = (*key, at)
            attempts.setdefault(aid, dict(job=job, tier=row.get("tier"), lane=row.get("lane"), result=None))
            latest[key] = aid
        aid = latest.get(key)
        if event == "publish" and url and aid: urls[url.rstrip("/")] = aid
        if event == "outcome":
            # URL observations must match a publication, never a later retry of the same job.
            aid = urls.get(url.rstrip("/")) if url else aid
            if not url and sum(a[:2] == key for a in attempts) != 1: aid = None
        if aid and (state in ("MERGED", "CLOSED") or (event == "finish" and row.get("empty") is True)):
            attempts[aid]["result"] = state == "MERGED" or attempts[aid]["result"] is True
    groups = {}
    for attempt in attempts.values():
        key = admission_cohort(attempt["job"], attempt["tier"], attempt["lane"])
        groups.setdefault(key, []).append(attempt["result"])
    return groups, states


def admission_cohort(job, tier, lane):
    return (re.split(r"[-_0-9]", job.removeprefix("RQ-"), maxsplit=1)[0], tier, lane)


def admission_rank(job, tier, lane, groups):
    results = groups.get(admission_cohort(job, tier, lane), [])
    known = [r for r in results if r is not None]
    rate = sum(known) / len(known) if known else None
    # Unseen cohorts get optimistic priority; pending and low-yield work keep a floor.
    return dict(job=job, mergeRate=rate, sampledLaunches=len(known), unknownLaunches=len(results) - len(known),
                score=max(0.1, rate) if rate is not None else (0.1 if results else 1.0),
                reason="observed_merge_rate_24h" if known else "unknown_outcomes" if results else "unknown_sample", outcome="ready")


def terminal_target(job, repo, prompt, states):
    # Only explicit task-envelope targets or the refix producer's exact ID count;
    # incidental PR references in prose must never retire new work.
    task = next((t for t in prompt.splitlines() if t.startswith(job + " (")), "")
    envelope = task.split("):", 1)[0] if "):" in task else ""
    targets = re.findall(r"(?:^|[(,\s])pr=([1-9][0-9]*)(?=[,\s)]|$)", envelope, re.I)
    drain = re.fullmatch(r"RQ-DRAIN-" + re.escape(repo) + r"-([1-9][0-9]*)-[0-9a-fA-F]{7}", job)
    if drain: targets.append(drain.group(1))
    if len(set(targets)) != 1: return None
    state = states.get("https://github.com/ashlrai/%s/pull/%s" % (repo, targets[0]))
    return "target_pr_" + state.lower() if state in ("MERGED", "CLOSED") else None

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

# RQ-EMPTY-SIGNAL-1: a finish row's boolean `empty` only says "no diff vs the launch
# base". It cannot tell an agent that ran cleanly and legitimately changed nothing
# (research, already done) from one that died, hit a pool error, or never wrote its
# exit status. Penalizing a lane for the first kind burns quota-routing signal on
# healthy work, so classify. Returns None when the row is not a measured empty.
EMPTY_NO_DIFF = "no_diff"    # exit 0, no pool error: ran fine, produced nothing publishable
EMPTY_ERROR = "error"        # nonzero exit or a classified pool error: infrastructure
EMPTY_UNKNOWN = "unknown"    # no exit status recorded: possible capture gap, not blamed on prompt


def classify_empty(empty, exit_code, pool_error=None):
    if empty is not True:
        return None
    if pool_error or (type(exit_code) is int and exit_code != 0):
        return EMPTY_ERROR
    return EMPTY_NO_DIFF if exit_code == 0 and type(exit_code) is int else EMPTY_UNKNOWN


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
        if not isinstance(row, dict) or row.get("launched") is False:
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


def attempt_identity(repo, prompt, home, runner=run):
    """Use the local upstream ref, without a fetch or a network call."""
    import hashlib
    try:
        result = runner(['git', '-C', home + '/Projects/ashlrai/' + repo,
                         'rev-parse', '--verify', 'refs/remotes/origin/HEAD^{commit}'], 2)
        sha = result.stdout.strip()
        if result.returncode or not re.fullmatch(r'[0-9a-f]{40,64}', sha): return {}
        return {'repo': repo, 'base_sha': sha,
                'prompt_hash': hashlib.sha256(prompt.encode()).hexdigest()}
    except Exception:
        return {}


# RQ-CODEXP-EMPTY-1: prompt_hash covers the whole prompt file, whose first line
# names the job id and the lane ("Job X (pool L, tier T, ...)"). A re-cut under a
# new id, a re-route to another lane, or any upstream commit therefore misses
# prompt_empty_same_base_24h. task_hash names the task text alone, so a task that
# already finished empty TASK_EMPTY_REPEAT times in 24 hours (any id, lane or base)
# stops relaunching. Two attempts, not one: a single empty on an older base can
# still be retried once on a newer one.
TASK_EMPTY_REPEAT = 2
TASK_MIN_CHARS = 16


def task_hash(job, prompt):
    """sha256 of the normalized `<job> (attrs): <task>` text, or None (fail open).

    The job id inside the text, the attrs (pool, tier, priority) and whitespace
    or case differences are excluded, so routing changes keep the same identity.
    """
    import hashlib
    try:
        line = next((t for t in prompt.splitlines() if t.startswith(job + " (")), "")
        cut = line.find("): ")
        if cut < 0: return None
        text = line[cut + 3:].replace(job, "<job>")
        text = " ".join(text.lower().split())
        if len(text) < TASK_MIN_CHARS: return None
        return hashlib.sha256(text.encode()).hexdigest()
    except Exception:
        return None


def with_prompt(identity, job, prompt):
    """Bind a repo/base identity to one prompt: prompt_hash plus task_hash when known."""
    import hashlib
    if not identity: return {}
    out = dict(identity, prompt_hash=hashlib.sha256(prompt.encode()).hexdigest())
    task = task_hash(job, prompt)
    if task: out["task_hash"] = task
    return out


def empty_reason(job, identity, rows, now):
    """Only successful empty finishes suppress work. Auth failures must retry.

    Claims bind each finish to its own attempt, so an older empty cannot mask
    a newer nonempty run. MERGED outcomes remain independently measurable.
    """
    from datetime import datetime
    if not identity: return None
    claims = {}; latest = {}
    for row in rows:
        if not isinstance(row, dict): continue
        key = row.get('job')
        if row.get('event') == 'claim': claims[key] = row
        if row.get('event') != 'finish': continue
        evidence = dict(claims.get(key, {}), **row)
        if evidence.get('repo') != identity['repo']: continue
        latest[key] = evidence
    task = identity.get('task_hash'); task_repeats = 0
    for key, row in latest.items():
        if row.get('empty') is not True or row.get('exit_code') != 0: continue
        try: age = now - datetime.fromisoformat(str(row['ts']).replace('Z', '+00:00')).timestamp()
        except (KeyError, ValueError, TypeError): age = None
        recent = age is not None and 0 <= age < 86400
        if task and recent and row.get('task_hash') == task: task_repeats += 1
        if row.get('base_sha') != identity['base_sha']: continue
        if key == job and job.startswith('RQ-UPKEEP-'): return 'upkeep_empty_same_base'
        if recent and row.get('prompt_hash') == identity['prompt_hash']:
            return 'prompt_empty_same_base_24h'
    if task_repeats >= TASK_EMPTY_REPEAT: return 'task_empty_repeat_24h'
    return None


def read_attempts(runs):
    import json
    rows = []
    try:
        with open(runs + '/metrics/jobs.jsonl') as stream:
            for line in stream:
                try: rows.append(json.loads(line))
                except ValueError: pass
    except OSError: pass
    return rows
