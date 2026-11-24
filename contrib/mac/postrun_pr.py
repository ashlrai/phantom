#!/usr/bin/python3
"""Post-run PR publisher (RQ-DISPATCHD-POSTRUN-PR-1).

A lane sandbox (codex-personal on the Mac) cannot read the gh config (EPERM), so a lane that commits locally can end
`RESULT EMPTY` with no PR. dispatchd's reap step runs OUTSIDE the lane sandbox, so it can publish for the lane: when a
finished job's worktree has commits not on origin/master and no PR exists for its head branch, dispatchd spawns this
module once per job. Nothing is added to the sandbox and no credential is copied anywhere.

Usage (spawned by dispatchd, never by a lane): postrun_pr.py <job-id>

What it does, in order, all idempotent:
  1. confirm no PR exists for masonwyatt23:codex-bridge/<job> (any state) -> if one does, record it and stop;
  2. run the unchanged bin/publish.sh <job> (fork-only push, gh pr create, auto-merge via the repo's normal path);
  3. record the outcome in <queue>/run/<job>.postrun.json and append one line per action to ~/.ashlr-runs/dispatchd.log.
It never pushes, merges or creates a PR itself, so every existing publish.sh guard (git-safe pin, secret scrub, scope
stage, fork target check, sensitive-path no-auto-merge) still applies. A failed lookup fails closed (no publish).
"""
import json, os, re, subprocess, sys, time

FORK_OWNER = "masonwyatt23"
UPSTREAM_OWNER = "ashlrai"
REPOS = ("phantom", "phantom-secrets", "ashlr-plugin", "locus", "lexicon", "ashlr-md", "ashlr-stack")   # publish.sh allowlist
JID = re.compile(r"^[A-Za-z0-9._-]+$")
PUBLISH_TIMEOUT_S = 900
LOOKUP_TIMEOUT_S = 60
MAX_ATTEMPTS = 3   # lookup failures only; a publish outcome (any RESULT line) is final for the job
OFF_SWITCH = "POSTRUN_PR_OFF"   # touch ~/.ashlr-runs/POSTRUN_PR_OFF to disable
PUBLISH_POLICY_ENV = (
    "PUBLISH_FULL_TESTS",
    "PUBLISH_JUDGE_CMD",
    "PUBLISH_JUDGE_THRESHOLD",
    "PUBLISH_JUDGE_TIMEOUT",
)


def eligible(res):
    """Only a publish that found nothing to publish qualifies; no result yet belongs to reap-one.sh, a PR is done."""
    return bool(res) and res.startswith("RESULT EMPTY")


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


def main(argv, home=None, run=subprocess.run):
    home = home or os.path.expanduser("~"); runs = home + "/.ashlr-runs"; run_dir = runs + "/queue/run"
    if len(argv) != 1 or not JID.match(argv[0]) or ".." in argv[0]: print("usage: postrun_pr.py <job-id>", file=sys.stderr); return 2
    job = argv[0]
    if os.path.exists(runs + "/" + OFF_SWITCH): note(runs, "skip %s off-switch" % job); return 0
    try:
        with open("%s/%s.line" % (run_dir, job)) as f: repo = f.read().split("\t")[1].strip()
    except (OSError, IndexError): note(runs, "skip %s no-job-record" % job); return 1
    if repo not in REPOS: note(runs, "skip %s repo-not-allowlisted" % job); return 1
    env = child_env(home)
    url = existing_pr(repo, job, run, env)
    if url is None:
        note(runs, "skip %s pr-lookup-failed (nothing published)" % job); return 3
    if url:
        record(run_dir, job, "exists", pr=url); note(runs, "exists %s %s (not republished)" % (job, url)); return 0
    note(runs, "publish %s no PR for %s:codex-bridge/%s; running publish.sh" % (job, FORK_OWNER, job))
    try:
        run(["/bin/bash", runs + "/bin/publish.sh", job], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=PUBLISH_TIMEOUT_S, env=env, stdin=subprocess.DEVNULL)   # publish.sh writes its own <job>.publish
    except (OSError, subprocess.SubprocessError) as e:
        record(run_dir, job, "publish-error", error=type(e).__name__); note(runs, "error %s publish.sh %s" % (job, type(e).__name__)); return 1
    res = last_result(runs, job)
    m = re.match(r"RESULT PR (https://github\.com/%s/%s/pull/[1-9][0-9]*)" % (UPSTREAM_OWNER, re.escape(repo)), res)
    if m:
        record(run_dir, job, "published", pr=m.group(1), result="RESULT PR"); note(runs, "published %s %s" % (job, m.group(1))); return 0
    record(run_dir, job, "no-pr", result=" ".join(res.split()[:3]) or "none")
    note(runs, "no-pr %s %s" % (job, " ".join(res.split()[:3]) or "no RESULT line")); return 1


if __name__ == "__main__": raise SystemExit(main(sys.argv[1:]))
