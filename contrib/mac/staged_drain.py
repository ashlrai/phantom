#!/usr/bin/python3
# staged_drain.py (RQ-SELFRUN-STAGED-DRAIN): one deterministic tick. No LLM turn, no network
# beyond the read-only `gh api .../actions/runs?status=queued` poll, and no token creation.
# Repo copy of the Mac-side staged-push drainer; install next to the #1066 queue scripts and
# fire it from a launchd StartInterval tick (com.ashlr.staged-drain.plist.in) or a dispatchd tick.
#
# Each tick: if /workspace/phantom-work/staged-pushes.tsv holds a staged row, sum the queued
# Actions run count across locus, lexicon, ashlr-md, ashlr-stack and ashlr-plugin. While the
# total is 50 or more the tick holds and changes nothing. Below 50 it drains the file in row
# order under an advisory lock: PARKED rows are skipped, any row touching .github/ or a
# release* path component is routed to a local staged-drain/<job> branch plus a diff under
# handoff/ instead of ever pushing, and every other row is handed to the pinned publish.sh
# only. Each processed row is marked done or failed in place; terminal rows are never
# reprocessed. The drain itself never runs git push, fetch, pull or any remote command.
import os, re, sys, time, fcntl, subprocess, tempfile

WORK = os.environ.get("STAGED_DRAIN_WORK", "/workspace/phantom-work")
TSV = os.path.join(WORK, "staged-pushes.tsv")
HANDOFF = os.path.join(WORK, "handoff")
LOCK = TSV + ".lock"
PUBLISH = os.environ.get("STAGED_DRAIN_PUBLISH",
                         os.path.expanduser("~/.ashlr-runs/bin/publish.sh"))
GIT = os.environ.get("STAGED_DRAIN_GIT", "/usr/bin/git")
SCRUB = os.environ.get("STAGED_DRAIN_SCRUB",
                       os.path.expanduser("~/.ashlr-runs/bin/scrub.pl"))
REPOS = [r.strip() for r in (os.environ.get("STAGED_DRAIN_REPOS")
         or "locus,lexicon,ashlr-md,ashlr-stack,ashlr-plugin").split(",") if r.strip()]
try: THRESHOLD = int(os.environ.get("STAGED_DRAIN_THRESHOLD", "50"))
except ValueError: THRESHOLD = 50
ALLOWED = {"phantom", "phantom-secrets", "locus", "lexicon",
           "ashlr-md", "ashlr-stack", "ashlr-plugin"}
BRANCH_PREFIX = "staged-drain/"
JID = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$")
SHA = re.compile(r"^[0-9a-f]{7,40}$")
REPO_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
GH_TIMEOUT = 20
PUBLISH_TIMEOUT = 1800
GIT_TIMEOUT = 120
def log(msg): print("%s STAGED_DRAIN %s" % (time.strftime("%F %T"), msg), flush=True)

def base_env():
    return {"HOME": os.environ.get("HOME", ""),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C"}

def queued_total():
    """Summed queued Actions runs across the sibling repos; None on any failure (fail closed)."""
    total = 0
    for rp in REPOS:
        if not REPO_NAME.fullmatch(rp): return None
        try:
            r = subprocess.run(["gh", "api",
                                "repos/ashlrai/%s/actions/runs?status=queued&per_page=1" % rp,
                                "--jq", ".total_count"],
                               capture_output=True, text=True, timeout=GH_TIMEOUT,
                               env=base_env())
        except Exception: return None
        if r.returncode != 0: return None
        try: total += int(r.stdout.strip())
        except ValueError: return None
    return total

# Every git call runs with a scrubbed environment and no hooks, filters, textconv, fsmonitor,
# pager or includes; only local plumbing and read commands are ever invoked, never a remote op.
GIT_C = ["--no-optional-locks", "--no-pager",
         "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
         "-c", "core.attributesFile=/dev/null", "-c", "diff.external=",
         "-c", "core.pager=cat", "-c", "core.untrackedCache=false",
         "-c", "status.recurseSubmodules=false", "-c", "diff.ignoreSubmodules=all",
         "-c", "submodule.recurse=false"]

def genv(index=None):
    e = dict(base_env())
    e.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
              "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
              "GIT_ATTR_NOSYSTEM": "1"})
    for k in os.environ:
        if k.startswith("GIT_"): e.pop(k, None)
    if index: e["GIT_INDEX_FILE"] = index
    return e

def git(wt, *args, index=None):
    return subprocess.run([GIT] + GIT_C + ["-C", wt] + list(args),
                          capture_output=True, text=True, timeout=GIT_TIMEOUT,
                          env=genv(index))

def real_dir(wt):
    return (os.path.isabs(wt) and os.path.isdir(wt) and not os.path.islink(wt)
            and os.path.realpath(wt) == wt.rstrip("/"))

def touched_paths(wt, base):
    """Repo-relative paths the staged row changes, read-only, or None if unknowable."""
    if not real_dir(wt): return None
    try:
        r = git(wt, "status", "--porcelain", "-uall", "--no-renames")
    except Exception: return None
    if r.returncode != 0: return None
    paths = {ln[3:].strip('"') for ln in r.stdout.splitlines() if len(ln) > 3}
    try:
        d = git(wt, "diff", "--name-only", "--no-renames", base)
        if d.returncode == 0:
            paths.update(p for p in d.stdout.splitlines() if p)
    except Exception: pass
    return sorted(paths)

def sensitive(paths):
    """True when a row touches any .github component or a path component starting with
    release (dot-optional). Over-matching only ever moves a row to handoff, never to push."""
    for p in paths:
        for comp in p.split("/"):
            if (comp == ".github" or comp.startswith("release")
                    or comp.startswith(".release")): return True
    return False

def handoff(row):
    """Commit the staged state onto refs/heads/staged-drain/<job> via a scratch index and write
    handoff/<job>.diff. The worktree's own HEAD, branch and index are never moved. Returns a
    short reason string on failure, None on success."""
    wt, job, base = row["worktree"], row["job"], row["base"]
    if not real_dir(wt): return "wt-unavailable"
    try:
        rv = git(wt, "rev-parse", "--verify", "--quiet", base + "^{commit}")
    except Exception: return "base-unresolved"
    if rv.returncode != 0: return "base-unresolved"
    bsha = rv.stdout.strip()
    fd, index = tempfile.mkstemp(prefix="staged-drain-index-")
    os.close(fd); os.unlink(index)   # git creates the scratch index itself
    try:
        for step, args in (("read-tree-failed", ("read-tree", bsha)),
                           ("add-failed", ("add", "-A"))):
            try:
                if git(wt, *args, index=index).returncode != 0: return step
            except Exception: return step
        try:
            wt_r = git(wt, "write-tree", index=index)
        except Exception: return "write-tree-failed"
        tree = wt_r.stdout.strip()
        if not re.fullmatch(r"[0-9a-f]{40}", tree): return "write-tree-failed"
        try:
            d = git(wt, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", bsha, tree)
        except Exception: return "diff-failed"
        if d.returncode != 0: return "diff-failed"
        if not d.stdout.strip(): return "empty"
        if os.path.isfile(SCRUB) and not os.path.islink(SCRUB):
            try:
                s = subprocess.run(["perl", SCRUB, "--check", "--allow-fixtures"],
                                   input=d.stdout, capture_output=True, text=True,
                                   timeout=60, env=base_env())
                if s.returncode != 0: return "scrub-hit"
            except Exception: return "scrub-error"
        try:
            ct = git(wt, "-c", "user.name=staged-drain",
                     "-c", "user.email=staged-drain@localhost",
                     "commit-tree", tree, "-p", bsha, "-m",
                     "staged-drain(%s): staged handoff" % job)
        except Exception: return "commit-failed"
        commit = ct.stdout.strip()
        if ct.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", commit): return "commit-failed"
        try:
            if git(wt, "update-ref", "refs/heads/" + BRANCH_PREFIX + job, commit).returncode != 0:
                return "branch-failed"
        except Exception: return "branch-failed"
        os.makedirs(HANDOFF, mode=0o700, exist_ok=True)
        try:
            fd, tmp = tempfile.mkstemp(prefix=job + ".", suffix=".diff", dir=HANDOFF)
            with os.fdopen(fd, "w") as f: f.write(d.stdout)
            os.replace(tmp, os.path.join(HANDOFF, job + ".diff"))
        except Exception: return "diff-write-failed"
        return None
    finally:
        try: os.unlink(index)
        except OSError: pass

def publish(row):
    """Invoke the pinned publisher with the job id only; its output is never printed."""
    if (os.path.islink(PUBLISH) or not os.path.isfile(PUBLISH)
            or not os.access(PUBLISH, os.X_OK)): return "publisher-unavailable"
    try:
        r = subprocess.run([PUBLISH, row["job"]], capture_output=True, text=True,
                           timeout=PUBLISH_TIMEOUT, env=base_env())
    except subprocess.TimeoutExpired: return "publish-timeout"
    except Exception: return "publish-error"
    return None if r.returncode == 0 else "publish-exit-%d" % r.returncode

def parse(line):
    s = line.rstrip("\n")
    if not s.strip() or s.lstrip().startswith("#"): return {"comment": True}
    parts = s.split("\t")
    if len(parts) < 5: return None
    return {"parts": parts, "job": parts[0], "repo": parts[1], "worktree": parts[2],
            "base": parts[3], "status": parts[4],
            "files": [p.strip('"') for p in (parts[5].split(",") if len(parts) > 5 else []) if p]}

def route_plan(row):
    """Decide the route for a staged row without mutating anything."""
    if not JID.fullmatch(row["job"]) or ".." in row["job"] or row["job"].endswith(".lock"):
        return ("invalid", "bad-job")
    if row["repo"] not in ALLOWED: return ("invalid", "repo-not-allowlisted")
    if not SHA.fullmatch(row["base"]): return ("invalid", "bad-base")
    paths = set(row["files"])
    inspected = touched_paths(row["worktree"], row["base"])
    if inspected is None and not paths: return ("invalid", "paths-unavailable")
    if inspected: paths.update(inspected)
    return ("handoff" if sensitive(paths) else "publish", None)

def set_status(row, status, note):
    row["parts"][4] = status
    note = re.sub(r"\s+", ";", note)
    while len(row["parts"]) < 7: row["parts"].append("")
    row["parts"][6] = note

def drain(rows, dry):
    """Process each row in order. Returns (changed, counts)."""
    counts = {"done": 0, "failed": 0, "skipped": 0, "planned": 0}
    changed = False
    for i, row in enumerate(rows):
        if row is None:
            log("row=%d outcome=skipped reason=malformed" % (i + 1)); counts["skipped"] += 1
            continue
        if row.get("comment"): continue
        job, st = row["job"], row["status"]
        if st.upper() == "PARKED":
            log("row=%d job=%s outcome=skipped route=parked" % (i + 1, job))
            counts["skipped"] += 1; continue
        if st.lower() != "staged":
            log("row=%d job=%s outcome=skipped route=terminal" % (i + 1, job))
            counts["skipped"] += 1; continue
        route, bad = route_plan(row)
        if dry:
            log("row=%d job=%s outcome=plan route=%s%s"
                % (i + 1, job, route, " reason=" + bad if bad else ""))
            counts["planned"] += 1; continue
        if route == "invalid":
            set_status(row, "failed", "route=none;reason=%s" % bad)
            changed = True; counts["failed"] += 1
            log("row=%d job=%s outcome=failed route=none reason=%s" % (i + 1, job, bad))
            continue
        err = handoff(row) if route == "handoff" else publish(row)
        if err is None:
            set_status(row, "done", "route=" + route)
            counts["done"] += 1
            log("row=%d job=%s outcome=done route=%s" % (i + 1, job, route))
        else:
            set_status(row, "failed", "route=%s;reason=%s" % (route, err))
            counts["failed"] += 1
            log("row=%d job=%s outcome=failed route=%s reason=%s" % (i + 1, job, route, err))
        changed = True
    return changed, counts

def main(argv):
    if any(a in ("--help", "-h") for a in argv):
        print("usage: staged_drain.py [--dry-run]\n"
              "One staged-drain tick. Environment: STAGED_DRAIN_WORK, STAGED_DRAIN_PUBLISH,\n"
              "STAGED_DRAIN_GIT, STAGED_DRAIN_SCRUB, STAGED_DRAIN_REPOS, STAGED_DRAIN_THRESHOLD.")
        return 0
    unknown = [a for a in argv if a != "--dry-run"]
    if unknown:
        print("usage: staged_drain.py [--dry-run]", file=sys.stderr)
        return 2
    dry = "--dry-run" in argv
    if not os.path.isfile(TSV) or os.path.islink(TSV):
        log("staged=0 drain=idle"); return 0
    try:
        with open(TSV) as f: lines = f.readlines()
    except OSError:
        log("read=failed drain=hold"); return 0
    rows = [parse(l) for l in lines]
    actionable = [r for r in rows
                  if r and not r.get("comment") and r["status"].lower() == "staged"]
    if not actionable:
        log("staged=0 drain=idle"); return 0
    n = queued_total()
    if n is None:
        log("poll=failed drain=hold"); return 0
    if n >= THRESHOLD:
        log("queued=%d threshold=%d drain=hold staged=%d" % (n, THRESHOLD, len(actionable)))
        return 0
    log("queued=%d threshold=%d drain=proceed staged=%d%s"
        % (n, THRESHOLD, len(actionable), " dry-run" if dry else ""))
    if dry:
        _, counts = drain(rows, dry=True)
        log("planned=%d skipped=%d" % (counts["planned"], counts["skipped"]))
        return 0
    try:
        lf = open(LOCK, "w")
    except OSError:
        log("lock=unavailable drain=hold"); return 0
    with lf:
        try:
            fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log("lock=busy drain=hold"); return 0
        try:
            with open(TSV) as f: lines = f.readlines()
        except OSError:
            log("read=failed drain=hold"); return 0
        rows = [parse(l) for l in lines]
        changed, counts = drain(rows, dry=False)
        if changed:
            try:
                fd, tmp = tempfile.mkstemp(prefix="staged-pushes.", dir=WORK)
                with os.fdopen(fd, "w") as f:
                    f.writelines(l if (r is None or r.get("comment"))
                                 else "\t".join(r["parts"]) + "\n"
                                 for r, l in zip(rows, lines))
                os.replace(tmp, TSV)
            except OSError:
                log("write=failed"); return 0
        log("done=%d failed=%d skipped=%d" % (counts["done"], counts["failed"], counts["skipped"]))
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
