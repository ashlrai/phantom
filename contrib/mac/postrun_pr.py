#!/usr/bin/python3
"""Post-run PR publisher (RQ-DISPATCHD-POSTRUN-PR-1).

A lane sandbox (codex-personal on the Mac) cannot read the gh config (EPERM), so a lane that commits locally can end
`RESULT EMPTY` with no PR. dispatchd's reap step runs OUTSIDE the lane sandbox, so it can publish for the lane: when a
finished job's worktree has commits not on origin/master and no PR exists for its head branch, dispatchd spawns this
module once per job. Nothing is added to the sandbox and no credential is copied anywhere.

Usage (spawned by dispatchd, never by a lane): postrun_pr.py <job-id>

What it does, in order, all idempotent:
  1. for fork-target-invalid, verify the fixed fork identity and parent, preserving the kept diff;
  2. confirm no PR exists for masonwyatt23:codex-bridge/<job> (any state) -> if one does, record it and stop;
  3. run the unchanged bin/publish.sh <job> (fork-only push, gh pr create, auto-merge via the repo's normal path);
  4. record the outcome in <queue>/run/<job>.postrun.json and append one line per action to ~/.ashlr-runs/dispatchd.log.
It never pushes, merges or creates a PR itself, so every existing publish.sh guard (git-safe pin, secret scrub, scope
stage, fork target check, sensitive-path no-auto-merge) still applies. A failed lookup fails closed (no publish).
"""
import fcntl, json, os, re, subprocess, sys, time

FORK_OWNER = "masonwyatt23"
UPSTREAM_OWNER = "ashlrai"
REPOS = ("phantom", "phantom-secrets", "ashlr-plugin", "locus", "lexicon", "ashlr-md", "ashlr-stack")   # publish.sh allowlist
JID = re.compile(r"^[A-Za-z0-9._-]+$")
PUBLISH_TIMEOUT_S = 900
LOOKUP_TIMEOUT_S = 60
MAX_ATTEMPTS = 3   # lookup/target verification failures only; a publish outcome (any RESULT line) is final for the job
FORK_ABORT = "RESULT ABORT fork-target-invalid"
OFF_SWITCH = "POSTRUN_PR_OFF"   # touch ~/.ashlr-runs/POSTRUN_PR_OFF to disable
PUBLISH_POLICY_ENV = (
    "PUBLISH_FULL_TESTS",
    "PUBLISH_JUDGE_CMD",
    "PUBLISH_JUDGE_THRESHOLD",
    "PUBLISH_JUDGE_TIMEOUT",
)


def eligible(res):
    """Recover empty publishes or the exact fork gate failure; every other abort stays held."""
    return bool(res) and (res.startswith("RESULT EMPTY") or res == FORK_ABORT)


def child_env(home, parent=os.environ):
    """Fixed environment: gh needs HOME for its own config, which is read here, outside any lane sandbox."""
    env = {"HOME": home, "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C", "NO_COLOR": "1"}
    env.update({name: parent[name] for name in PUBLISH_POLICY_ENV if name in parent})
    return env


def _stamp(): return time.strftime("%F %T")


def note(runs, msg):
    with open(runs + "/dispatchd.log", "a") as f: f.write("%s POSTRUN_PR %s\n" % (_stamp(), msg))


def record(run_dir, job, action, **extra):
    """The run sidecar: one JSON object, replaced atomically."""
    path = "%s/%s.postrun.json" % (run_dir, job); tmp = path + ".tmp"
    with open(tmp, "w") as f: json.dump({"job": job, "action": action, "ts": int(time.time()), **extra}, f, indent=1)
    os.replace(tmp, path)


def existing_pr(repo, job, run, env):
    """-> URL of any PR (open, closed or merged) for the job's head branch, '' for none, None when unknown."""
    try:
        r = run(["gh", "api", "--method", "GET", "repos/%s/%s/pulls" % (UPSTREAM_OWNER, repo),
                 "--raw-field", "head=%s:codex-bridge/%s" % (FORK_OWNER, job), "--raw-field", "state=all",
                 "--jq", ".[0].html_url // empty"],
                capture_output=True, text=True, timeout=LOOKUP_TIMEOUT_S, env=env, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError): return None
    if r.returncode != 0: return None
    url = r.stdout.strip()
    return url if re.fullmatch(r"https://github\.com/%s/%s/pull/[1-9][0-9]*" % (UPSTREAM_OWNER, re.escape(repo)), url) or not url else None


def last_result(runs, job):
    try:
        with open("%s/%s.publish" % (runs, job)) as f: rows = [l.strip() for l in f if l.startswith("RESULT")]
    except OSError: return ""
    return rows[-1] if rows else ""


def verified_fork(repo, run, env):
    """Match publish.sh's fixed target exactly; API failure, redirect or wrong parent stays held."""
    try:
        r = run(["gh", "api", "repos/%s/%s" % (FORK_OWNER, repo)],
                capture_output=True, text=True, timeout=LOOKUP_TIMEOUT_S, env=env, stdin=subprocess.DEVNULL)
        data = json.loads(r.stdout) if r.returncode == 0 else None
        return (isinstance(data, dict) and data.get("full_name") == "%s/%s" % (FORK_OWNER, repo)
                and data.get("fork") is True and isinstance(data.get("parent"), dict)
                and data["parent"].get("full_name") == "%s/%s" % (UPSTREAM_OWNER, repo))
    except (OSError, ValueError, subprocess.SubprocessError): return False


def main(argv, home=None, run=subprocess.run):
    """Serialize duplicates and honor terminal receipts even when called outside dispatchd."""
    home = home or os.path.expanduser("~")
    if len(argv) != 1 or not JID.fullmatch(argv[0]) or ".." in argv[0]: return 2
    run_dir = home + "/.ashlr-runs/queue/run"
    try:
        fd = os.open("%s/%s.postrun.lock" % (run_dir, argv[0]), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: return 3
            if os.path.lexists("%s/%s.postrun.json" % (run_dir, argv[0])): return 0
            return publish_once(argv, home, run)
    except OSError: return 1


def publish_once(argv, home, run):
    runs = home + "/.ashlr-runs"; run_dir = runs + "/queue/run"
    job = argv[0]
    if os.path.exists(runs + "/" + OFF_SWITCH): note(runs, "skip %s off-switch" % job); return 0
    try:
        with open("%s/%s.line" % (run_dir, job)) as f: repo = f.read().split("\t")[1].strip()
    except (OSError, IndexError): note(runs, "skip %s no-job-record" % job); return 1
    if repo not in REPOS: note(runs, "skip %s repo-not-allowlisted" % job); return 1
    env = child_env(home)
    res = last_result(runs, job)
    recovery = res == FORK_ABORT
    classification = {"failure_class": "abort_fork-target-invalid"} if recovery else {}
    if res and not eligible(res): return 1
    if recovery and not verified_fork(repo, run, env):
        note(runs, "held %s abort_fork-target-invalid target-unverified; worktree kept" % job)
        return 3
    url = existing_pr(repo, job, run, env)
    if url is None:
        note(runs, "skip %s pr-lookup-failed (nothing published)" % job); return 3
    if url:
        record(run_dir, job, "exists", pr=url, **classification); note(runs, "exists %s %s (not republished)" % (job, url)); return 0
    if recovery:
        record(run_dir, job, "retrying", failure_class="abort_fork-target-invalid")
    note(runs, "publish %s no PR for %s:codex-bridge/%s; running publish.sh" % (job, FORK_OWNER, job))
    try:
        run(["/bin/bash", runs + "/bin/publish.sh", job], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=PUBLISH_TIMEOUT_S, env=env, stdin=subprocess.DEVNULL)   # publish.sh writes its own <job>.publish
    except (OSError, subprocess.SubprocessError) as e:
        record(run_dir, job, "publish-error", error=type(e).__name__, **classification); note(runs, "error %s publish.sh %s" % (job, type(e).__name__)); return 1
    res = last_result(runs, job)
    m = re.match(r"RESULT PR (https://github\.com/%s/%s/pull/[1-9][0-9]*)" % (UPSTREAM_OWNER, re.escape(repo)), res)
    if m:
        record(run_dir, job, "published", pr=m.group(1), result="RESULT PR", **classification); note(runs, "published %s %s" % (job, m.group(1))); return 0
    record(run_dir, job, "no-pr", result=" ".join(res.split()[:3]) or "none", **classification)
    note(runs, "no-pr %s %s" % (job, " ".join(res.split()[:3]) or "no RESULT line")); return 1


if __name__ == "__main__": raise SystemExit(main(sys.argv[1:]))
