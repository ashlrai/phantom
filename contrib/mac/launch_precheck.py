"""Shared fail-open launch precheck; errors and usage never retire work."""
import json
import os
import re
import shutil
import signal
import subprocess
from datetime import datetime
from typing import Literal

CapabilityFailure = Literal["empty_capability_gh_unavailable"]


def capability_failure(tail: str) -> CapabilityFailure | None:
    # Require a concrete CLI failure, not a task merely mentioning gh or a sandbox.
    if re.search(r"(?im)^.*(?:(?:error reading|failed to read) configuration:.*[/\\]gh[/\\]|gh:).*"
                 r"(?:operation not permitted|permission denied|command not found).*$", tail):
        return "empty_capability_gh_unavailable"
    return None


def latest_attempts(rows):
    claims, latest = {}, {}
    for row in rows:
        if not isinstance(row, dict): continue
        key = row.get('job')
        if row.get('event') == 'claim':
            claims[key] = row
            latest.pop(key, None)  # a newer unfinished claim invalidates old log evidence
        if row.get('event') == 'finish': latest[key] = dict(claims.get(key, {}), **row)
    return latest


def empty_retry_blocks(identity, rows, now) -> dict[str, CapabilityFailure]:
    """One confirmed capability failure is enough; re-cuts do not reset the bound.

    Unknown failures stay unknown. Evidence expires after 24h, or a productive
    attempt supersedes it. Base movement alone does not repair a lane's tools.
    """
    blocked = {}
    for row in latest_attempts(rows).values():
        if (not identity or row.get('repo') != identity.get('repo') or row.get('empty') is not True
                or row.get('capability_failure') != 'empty_capability_gh_unavailable'): continue
        same = any(identity.get(k) and row.get(k) == identity[k] for k in ('task_hash', 'prompt_hash'))
        try: age = now - datetime.fromisoformat(str(row['ts']).replace('Z', '+00:00')).timestamp()
        except (KeyError, ValueError, TypeError): continue
        if same and 0 <= age < 86400 and isinstance(row.get('lane'), str):
            blocked[row['lane']] = row['capability_failure']
    return blocked


def update_launch_state(active, row):
    """Fold append-order receipts; duplicate launches retain one active attempt.

    A URL resolution can belong to an older attempt, so only worker completion
    or explicit launcher termination releases the current reservation.
    """
    if not isinstance(row, dict): return
    job, event = row.get("job"), row.get("event")
    if not isinstance(job, str) or not job: return
    if event == "launch" or (event == "claim" and row.get("launch_dedupe") is True):
        active.add(job)
    elif event in ("finish", "launch_terminal"):
        active.discard(job)


def merged_jobs(rows):
    """Exact job/repo receipts only; missing legacy repos use fleet-wide IDs."""
    return {(repo.removeprefix("ashlrai/") if repo is not None else None, row['job'])
            for row in rows if isinstance(row, dict) and row.get('launched') is not False
            and row.get('event') == 'outcome' and row.get('state') == 'MERGED'
            and isinstance(row.get('job'), str)
            for repo in [row.get('repo')] if repo is None or isinstance(repo, str)}


class RecutAdmission:
    """Join published loop identities to merge receipts and current owners, not prose.

    The loop only produces phantom jobs. Heads are immutable; a changed head,
    ambiguous identity, missing receipt or dead owner cannot satisfy new work.
    """
    def __init__(self, rows, completed, alive):
        identities = {}
        for row in rows:
            if not isinstance(row, dict): continue
            ident = row.get('id')
            if not isinstance(ident, str) or len(ident) > 64: continue
            match = re.fullmatch(r'RECUT([1-9][0-9]*)L[1-9][0-9]*', ident)
            if not match: continue
            head = row.get('headSha')
            key = (int(match[1]), head) if (type(row.get('pr')) is int and row['pr'] == int(match[1])
                    and isinstance(head, str) and re.fullmatch(r'[0-9a-f]{40}', head)
                    and 'leaseUntil' not in row) else None
            job = 'RQ-PHX-' + ident
            identities[job] = key if job not in identities or identities[job] == key else None
        self.identities = {job: key for job, key in identities.items() if key}
        self.merged = {key: job for job, key in sorted(self.identities.items())
                       if ('phantom', job) in completed or (None, job) in completed}
        self.owners = {key: job for job, key in sorted(self.identities.items()) if job in alive}

    def decide(self, job, repo):
        key = self.identities.get(job) if repo == 'phantom' else None
        if key is None: return None
        merged, owner = self.merged.get(key), self.owners.get(key)
        reason, action, prior = ('recut-already-merged', 'skip', merged) if merged else (
            ('recut-in-flight', 'defer', owner) if owner and owner != job else
            ('recut-no-current-coverage', 'ready', None))
        return dict(reason=reason, action=action, repeatOf=prior, targetPr=key[0], headSha=key[1])

    def launched(self, job, repo):
        if repo == 'phantom' and job in self.identities:
            self.owners[self.identities[job]] = job


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
    # A repair job's identity names its PR; two repairs of different PRs are never the same request.
    target = repair_target(job, repo)
    ident = list(target.groups()[:2]) if target else None
    return hashlib.sha256(json.dumps([repo, attrs, match[2], before, after, ident], separators=(',', ':')).encode()).hexdigest()


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
    repair = repair_target(job, repo)
    if repair: targets.append(repair.group(2))
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


def repair_target(job, repo):
    """Only producer-shaped identities name repair targets; prose is not evidence."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", repo): return None
    return re.fullmatch(r"RQ-(FIXUP|REBASE|RECUT)-" + re.escape(repo)
                        + r"-([1-9][0-9]*)(?:-([0-9a-f]{7}))?", job.removesuffix('-CR1'))


def repair_freshness(job, repo, prompt, home, runner=run):
    """Bounded current PR read through the host's scoped identity; fail open.

    Only a closed/merged PR or a resolved repair on the queued head retires work.
    Pending, absent, malformed and moved-head evidence never proves resolution.
    Return fixed reason codes only, never subprocess text.
    """
    target = repair_target(job, repo)
    if not target: return None
    try:
        result = runner(["locus", "exec", "--", "gh", "pr", "view", target.group(2),
                         "--repo", "ashlrai/" + repo, "--json",
                         "number,state,headRefOid,mergeable,statusCheckRollup"], 3, cwd=home)
        if result.returncode or len(result.stdout) > 65536: return None
        pr = json.loads(result.stdout)
        if not isinstance(pr, dict) or type(pr.get("number")) is not int or pr["number"] != int(target.group(2)):
            return None
        state = pr.get("state")
        if state in ("MERGED", "CLOSED"): return "target_pr_" + state.lower()
        sha = pr.get("headRefOid")
        if (state != "OPEN" or not target.group(3) or not isinstance(sha, str)
                or not re.fullmatch(r"[0-9a-f]{40}", sha) or not sha.startswith(target.group(3))):
            return None
        if target.group(1) in ("REBASE", "RECUT"):
            return "target_pr_conflicts_resolved" if pr.get("mergeable") == "MERGEABLE" else None
        task = next((t for t in prompt.splitlines() if t.startswith(job + " (")), "")
        expected = re.search(r'\bcheck="([^"\r\n]+)"', task)
        if not expected: return None
        checks = pr.get("statusCheckRollup")
        if not isinstance(checks, list) or not checks: return None
        matched = False
        for check in checks:
            if not isinstance(check, dict): return None
            matched |= check.get("name", check.get("context")) == expected.group(1)
            if check.get("__typename") == "CheckRun":
                if check.get("status") != "COMPLETED" or check.get("conclusion") not in ("SUCCESS", "NEUTRAL", "SKIPPED"):
                    return None
            elif check.get("__typename") != "StatusContext" or check.get("state") != "SUCCESS":
                return None
        return "target_pr_checks_resolved" if matched else None
    except Exception:
        return None


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


DUPCHECK_CODE = 14
_REF = re.compile(r"[A-Za-z0-9_./#@ -]{1,200}")
_WARN = re.compile(r"Check this first: [\x20-\x7e]{1,400}")


def dupcheck(job, repo, prompt_path, home, runs, runner=run):
    """`phm queue dupcheck <prompt> --gate --json`: ("skip", reason, ref), ("warn", line, "") or None to launch.

    phantom only: the check reads phantom's command list and tree. Fail open on a missing phm, a timeout, an
    error or anything but the exact answer shape. The reason is fixed; only a validated ref and one validated
    line cross this boundary, never raw output.
    """
    try:
        phm = shutil.which("phm")
        if repo != "phantom" or not phm: return None
        env = {k: os.environ[k] for k in ("HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG") if k in os.environ}
        env["ASHLR_RUNS_DIR"] = runs
        r = runner([phm, "queue", "dupcheck", prompt_path, "--gate", "--json"], 10, env=env, cwd=home + "/Projects/ashlrai/" + repo)
        if r.returncode or len(r.stdout) > 65536: return None
        g = json.loads(r.stdout)
        if not isinstance(g, dict) or g.get("schema") != "queue.dupcheck-gate.v1" or g.get("reason") != "already_done": return None
        if g.get("action") == "skip" and g.get("confidence") == "high":
            ev = g.get("evidence")
            ref = ev[0].get("ref") if isinstance(ev, list) and ev and isinstance(ev[0], dict) else ""
            return ("skip", "dupcheck_already_done", ref if isinstance(ref, str) and _REF.fullmatch(ref) else "")
        line = g.get("line")
        if g.get("action") == "warn" and isinstance(line, str) and _WARN.fullmatch(line): return ("warn", line, "")
    except Exception:
        pass
    return None


def add_check_line(prompt_path, line):
    """Append the warning to the job prompt once; a failed write never blocks the launch."""
    try:
        with open(prompt_path, "r+") as f:
            text = f.read()
            if line not in text: f.write(("" if text.endswith("\n") else "\n") + "\n" + line + "\n")
    except OSError:
        pass


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
    if not identity: return None
    latest = latest_attempts(rows)
    task = identity.get('task_hash'); task_repeats = 0
    for key, row in latest.items():
        if (row.get('repo') != identity['repo'] or row.get('empty') is not True
                or row.get('exit_code') != 0 or row.get('pool_error') or row.get('capability_failure')): continue
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
    # C499 predates the typed field. Read only the latest attempt's bounded log
    # when its mtime agrees with the finish; never borrow a later attempt's log.
    for job, row in latest_attempts(rows).items():
        if row.get('empty') is not True or 'capability_failure' in row: continue
        if not isinstance(job, str) or not re.fullmatch(r'[A-Za-z0-9._-]+', job): continue
        try:
            at = datetime.fromisoformat(str(row['ts']).replace('Z', '+00:00')).timestamp()
            if not 0 <= datetime.now().timestamp() - at < 86400: continue
            path = runs + '/' + job + '.log'
            if abs(os.path.getmtime(path) - at) > 120: continue
            with open(path, 'rb') as stream:
                stream.seek(0, 2); stream.seek(max(0, stream.tell() - 20000))
                reason = capability_failure(stream.read().decode('utf-8', 'replace'))
            if reason:
                for original in reversed(rows):
                    if isinstance(original, dict) and original.get('job') == job and original.get('event') == 'finish':
                        original['capability_failure'] = reason; break
        except (OSError, KeyError, ValueError, TypeError): pass
    return rows


# RQ-QUEUERECOVERYQ8: a launch that fails used to drop its ready line with no reason and no
# bound (LAUNCH_FAILED), or requeue it forever (LAUNCH_INTERRUPTED). A failed launch now gets
# a fixed machine-readable reason, at most LAUNCH_MAX_ATTEMPTS tries with doubling backoff,
# and then a permanent give-up receipt. Only queue input changes (park_key) reset the count.
# Reasons are fixed labels: launcher output is untrusted and is never copied into state.
LAUNCH_MAX_ATTEMPTS = 3
LAUNCH_BACKOFF_S = 120
RETRYABLE = "retryable"      # a later attempt can succeed: host pressure, timeout, local backend down
PERMANENT = "permanent"      # retrying cannot help until someone changes credentials or the job
_LAUNCH_REASONS = (          # first match wins; (reason, retryable, pattern)
    ("local_backend_unavailable", True,
     re.compile(r"(?i)127\.0\.0\.1:8123|localhost:8123|connection refused|econnrefused|local (model|backend)")),
    ("authentication", False,
     re.compile(r"(?i)\b(401|403)\b|unauthori[sz]ed|forbidden|not logged in|invalid (api )?key|authentication (failed|required)")),
    ("resource_exhausted", True,
     re.compile(r"(?i)resource temporarily unavailable|cannot fork|cannot allocate memory|BlockingIOError|"
                r"\[Errno (11|12|35)\]|too many processes|no space left")),
    ("provider_unavailable", True,
     re.compile(r"(?i)\b(429|502|503|504)\b|rate[ _-]?limit|quota|overloaded|timed out|temporar(y|ily) unavailable|"
                r"connection (reset|aborted)")),
)


def classify_launch_failure(out, exit_code=None):
    """Launcher output and exit status -> (reason, retryable). Fixed labels only."""
    if exit_code == 124:
        return ("launch_timeout", True)
    text = out if isinstance(out, str) else ""
    if not text.strip():
        return ("launch_interrupted", True)   # no output and no worktree: the launcher died before it started
    for reason, retryable, rx in _LAUNCH_REASONS:
        if rx.search(text):
            return (reason, retryable)
    return ("launch_script_error", True)      # unknown: still bounded by LAUNCH_MAX_ATTEMPTS


def classify_empty_failure(empty, exit_code, pool_error=None):
    """Why a finished-empty job produced nothing: a fixed reason, or None when it is not a failure.

    A clean exit with no diff is a legitimate no-op (classify_empty -> no_diff), never a failure.
    """
    kind = classify_empty(empty, exit_code, pool_error)
    if kind is None or kind == EMPTY_NO_DIFF:
        return None
    if exit_code == 124:
        return "launch_timeout"
    if pool_error:
        return "provider_" + re.sub(r"[^a-z0-9]+", "_", str(pool_error).lower()).strip("_")[:32]
    return "agent_exit_nonzero" if kind == EMPTY_ERROR else "exit_status_missing"


def claude_recoveries(rows, now):
    """Two measured exit-1 empties on distinct attempts; never infer from prose.

    Unknown/auth/quota failures, clean no-ops, live attempts and published work
    cannot authorize recovery. A separate attempt id preserves original evidence.
    """
    failures, pending, repos, resolved, seen, starts = {}, set(), {}, set(), set(), {}
    for row in rows:
        job = row.get('job')
        if not isinstance(job, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,90}', job): continue
        event = row.get('event')
        if event in ('claim', 'launch'):
            pending.add(job)
            repos[job] = row.get('repo')
            starts[job] = row.get('ts')
        if event == 'publish' or (event == 'outcome' and row.get('state') == 'MERGED'): resolved.add(job)
        if event != 'finish' or job not in pending: continue
        receipt = (job, str(row.get('ts')))
        if receipt in seen: continue
        seen.add(receipt)
        try:
            at = datetime.fromisoformat(str(row['ts']).replace('Z', '+00:00'))
            start = datetime.fromisoformat(str(starts[job]).replace('Z', '+00:00'))
            if not at.tzinfo or not start.tzinfo or at < start: continue
            pending.discard(job)
            fresh = at.tzinfo is not None and 0 <= now - at.timestamp() < 86400
        except (KeyError, ValueError, TypeError): fresh = False
        if (fresh and row.get('lane') == 'claude' and row.get('empty') is True
                and type(row.get('exit_code')) is int and row['exit_code'] == 1 and not row.get('pool_error')):
            evidence = dict(ts=row['ts'], lane='claude', exit_code=1, empty=True, repo=repos.get(job))
            failures[job] = (failures.get(job, []) + [evidence])[-2:]
        else: failures.pop(job, None)
    return {j: ev for j, ev in failures.items() if len(ev) == 2 and j not in pending | resolved
            and not j.endswith('-CR1') and ev[0]['repo'] == ev[1]['repo']}


def launch_hold(state, job, key, now):
    """'gave_up' (budget spent, drop the line), 'wait' (backing off, keep it) or None (may launch)."""
    entry = state.get(job)
    if not isinstance(entry, dict) or entry.get("key") != key:
        state.pop(job, None)
        return None
    if entry.get("gave_up"):
        return "gave_up"
    return "wait" if now < entry.get("retry_at", 0) else None


def launch_failure(state, job, key, now, reason, retryable):
    """Record one failed launch; returns the receipt the dispatcher emits as a metric."""
    previous = state.get(job) if isinstance(state.get(job), dict) and state[job].get("key") == key else {}
    attempt = min(previous.get("attempts", 0) + 1, LAUNCH_MAX_ATTEMPTS)
    gave_up = not retryable or attempt >= LAUNCH_MAX_ATTEMPTS
    entry = {"key": key, "attempts": attempt, "reason": reason, "gave_up": gave_up,
             "retry_at": None if gave_up else now + (0 if reason == "launch_interrupted" and attempt == 1
                                                      else LAUNCH_BACKOFF_S * 2 ** (attempt - 1))}
    state[job] = entry
    return {"job": job, "reason": reason, "class": RETRYABLE if retryable else PERMANENT, "attempt": attempt,
            "max_attempts": LAUNCH_MAX_ATTEMPTS, "action": "give_up" if gave_up else "retry",
            "retry_at": entry["retry_at"]}


def launch_ok(state, job):
    """A launch that started clears its failure history."""
    return state.pop(job, None) is not None
