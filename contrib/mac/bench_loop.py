#!/usr/bin/python3
# bench_loop.py — deterministic outer-loop efficiency benchmark (RQ-SWE5-LOOP-BENCH).
# Times the machinery that owns the agent loop, on synthetic fixtures only: no network,
# no real ~/.ashlr-runs, no provider calls. Stages:
#   tick     one dispatchd.py tick (subprocess, fresh fixture per run)
#   launch   disk.py launch() preflight + supervised split (/usr/bin/true workload)
#   publish  disk.py finish() on a fixture worktree with valid evidence
#   reap     disk.py reap_pending() deferred-target cleanup
#   pick     restock.py --dry-run (subprocess)
# Use --dispatchd/--disk/--restock to point at another copy for before/after diffs,
# and --profile to run one tick under cProfile and print the top cumulative rows.
import argparse, cProfile, importlib.util, io, json, os, pstats, statistics, subprocess, sys, tempfile, time
from pathlib import Path

MAC = Path(__file__).resolve().parent                      # contrib/mac
ROOT = MAC.parent.parent                                   # repository root
DISK = ROOT / "scripts" / "bridge" / "disk.py"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True,
                          capture_output=True, text=True, timeout=30).stdout.strip()


def write(path, text, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)
    return path


def stub(home, name, text):
    return write(home / "stubbin" / name, text, 0o755)


# ---- dispatchd fixture -----------------------------------------------------

ASHLR_STUB = ('#!/bin/bash\nf="$HOME/ashlr-last-tick"; [ -f "$f" ] || exit 1\n'
              'v="$(cat "$f")"; [ "$v" = now ] && v="$(date -u +%Y-%m-%dT%H:%M:%SZ)"\n'
              'echo "{\\"lastTickAt\\": \\"$v\\"}"\n')
PS_STUB = ('#!/bin/bash\n'
           'echo "501 /bin/bash /bin/bash launch.sh RQ-ALIVE1 phantom codex-cmp work"\n'
           'echo "502 /usr/bin/python3 /usr/bin/python3 worker.py --wt ~/Projects/ashlrai/wt/RQ-ALIVE2"\n'
           'for i in 503 504 505 506 507 508 509 510; do echo "$i /usr/bin/idle"; done\n')
AUTOPILOT = ('#!/usr/bin/python3\nimport json, sys\n'
             'json.dump({"lane_disk_gate": "green", "memory": {"known": True, "raise_ok": True}}, sys.stdout)\n')
CLAUDE_API = ('#!/usr/bin/python3\nimport json, sys\n'
              'json.dump({"target": 0, "held": True, "reason": "fixture"} if "pace" in sys.argv else {}, sys.stdout)\n')
PRECHECK = '#!/bin/bash\nexit 0\n'
NOOP_SH = '#!/bin/bash\nexit 0\n'
LAUNCH_SH = '#!/bin/bash\necho "launched $1 $3 pid $$ base fixture"\n'


def build_runs(home, a):
    """Synthetic ~/.ashlr-runs at a plausible host scale; modeled on test_dispatchd.build."""
    r = home / ".ashlr-runs"
    q = r / "queue"
    for d in (q / "prompts", q / "run", r / "metrics", r / "bin",
              home / "Projects" / "ashlrai" / "wt", home / "stubbin"):
        d.mkdir(parents=True, exist_ok=True)
    src = home / "Projects" / "ashlrai" / "phantom"
    src.mkdir(parents=True)
    git(src, "init", "-b", "main")
    git(src, "config", "user.email", "bench@example.invalid")
    git(src, "config", "user.name", "Bench fixture")
    git(src, "config", "core.hooksPath", "/dev/null")
    (src / "package.json").write_text('{"name":"bench-fixture","private":true}\n')
    git(src, "add", ".")
    git(src, "commit", "-qm", "fixture")
    head = git(src, "rev-parse", "HEAD")
    for repo in ("phantom-secrets", "locus", "lexicon", "ashlr-md", "ashlr-plugin", "ashlr-stack"):
        (home / "Projects" / "ashlrai" / repo).mkdir(parents=True, exist_ok=True)
    stub(home, "ps", PS_STUB)
    stub(home, "ashlr", ASHLR_STUB)
    stub(home, "memory_pressure", '#!/bin/bash\necho "System-wide memory free percentage: 45%"\n')
    stub(home, "sysctl", '#!/bin/bash\necho "total = 2048.00M  used = 12.00M  free = 2036.00M"\n')
    stub(home, "lsof", '#!/bin/bash\necho "p502"\necho "n%s/Projects/ashlrai/wt/RQ-ALIVE2"\n' % home)
    write(home / "ashlr-last-tick", "now")
    for b in ("autopilot.py", "claude-api.py"):
        write(r / "bin" / b, AUTOPILOT if b == "autopilot.py" else CLAUDE_API, 0o755)
    for b in ("precheck.sh", "reap-one.sh", "restock.sh", "metrics-outcomes.sh"):
        write(r / "bin" / b, PRECHECK if b == "precheck.sh" else NOOP_SH, 0o755)
    write(r / "bin" / "launch.sh", LAUNCH_SH, 0o755)
    (r / "LOADGATE_TEST").write_text("")
    (r / "DISKGUARD_TEST").write_text("")
    (r / "HOLD").write_text("")
    (q / "keep.txt").write_text("")
    (q / "RETIRED").write_text("")
    (q / "claimed.tsv").write_text("")
    (q / "BATCH_OFF").write_text("")
    (q / "status.json").write_text('{"lanes": {}}')
    # metrics ledger: mixed event shapes over many jobs
    now = time.time()
    rows = []
    for i in range(a.jobs_rows):
        j = "RQ-HIST%d" % (i % 400)
        kind = i % 10
        row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(now - i * 37 % 60000)), "job": j}
        if kind == 0: row.update(event="launch", lane=("devin", "codex-cmp", "codex-personal")[i % 3], tier="work")
        elif kind == 1: row.update(event="finish", lane="devin", empty=(i % 40 == 0), tokens_total=1200 + i % 900,
                                 wall_s=600 + i % 700, exit_code=0, diff_files=3)
        elif kind == 2: row.update(event="publish", url="https://github.com/ashlrai/phantom/pull/%d" % (1000 + i))
        elif kind == 3: row.update(event="outcome", state="MERGED", url="https://github.com/ashlrai/phantom/pull/%d" % (1000 + i),
                                 ttm_s=400 + i % 200)
        elif kind == 4: row.update(event="claim", lane="codex-cmp", tier="mid")
        elif kind == 5: row.update(event="enqueue", lane="devin", tier="work")
        else: row.update(event="pool", lane="codex-cmp", kind="rate_limit")
        rows.append(json.dumps(row, sort_keys=True))
    (r / "metrics" / "jobs.jsonl").write_text("\n".join(rows) + "\n")
    # ready queue: launchable rows plus parked and malformed noise
    ready = []
    for i in range(a.ready):
        j = "RQ-BENCH%d" % i
        pf = q / "prompts" / (j + ".md")
        write(pf, "Job %s (pool devin, tier work, repo phantom). Task: bench prompt %d.\n\n%s (P2): text\n" % (j, i, j))
        lane = ("devin", "codex-cmp", "codex-personal", "claude-api", "codex-local")[i % 5]
        ready.append("\t".join([j, "phantom", lane, ("frontier", "work", "mid", "fast")[i % 4], str(pf)]))
    for i in range(a.ready // 4):
        pf = q / "prompts" / ("pd%d.md" % i)
        write(pf, "DEPENDENCY GATE: RQ-HIST1\n\nRQ-PD%d (P2): gated task\n" % i)
        ready.append("\t".join(["PARKED-DEP.devin", "RQ-PD%d" % i, "devin", "work", "phantom", str(pf)]))
        ready.append("BAD\tnot-a-repo\tnolane\tbogus")
    (q / "ready.tsv").write_text("\n".join(ready) + "\n")
    # router queue: mixed statuses so ranking and retired checks do real work
    qlines = []
    for i in range(a.queue_lines):
        k = i % 7
        if k == 0: qlines.append("- READY RQ-BENCH%d (P2 repo=phantom tier=work impact=3 effort=m confidence=high): task text %d" % (i, i))
        elif k == 1: qlines.append("- CLAIMED RQ-HIST%d dispatchd 10:0%d devin (P3): older" % (i, i % 10))
        elif k == 2: qlines.append("- HOLD-SECURITY RQ-SEC%d (P1): touches publish.sh [Security pin required]" % i)
        elif k == 3: qlines.append("- DONE-NOOP RQ-OLD%d" % i)
        elif k == 4: qlines.append("- RETIRED RQ-RET%d (P3 repo=phantom): superseded" % i)
        else: qlines.append("- READY RQ-REST%d (P%d repo=locus tier=mid pool=codex-cmp): other %d" % (i, 1 + i % 3, i))
    (q / "router-queue.md").write_text("\n".join(qlines) + "\n")
    # worktree/.base population: running, reaped-eligible, kept and finished jobs
    for i in range(a.base):
        j = "RQ-WT%d" % i
        wt = home / "Projects" / "ashlrai" / "wt" / j
        lane = ("codex-cmp", "devin", "codex-personal", "codex-local", "claude-api")[i % 5]
        if i % 3 == 0:
            git(src, "worktree", "add", "-q", "--detach", str(wt), "HEAD")
        else:
            wt.mkdir(parents=True)   # dead dir: still exercises isdir and stat paths
        write(r / (j + ".base"), "%s codex-bridge/%s %s %s\n" % (head, j, wt, lane))
        write(q / "run" / (j + ".line"), "%s\tphantom\t%s\twork\t%s\n" % (j, lane, q / "prompts" / (j + ".md")))
        lp = r / (j + ".log")
        write(lp, "agent output %d\n" % i)
        old = now - 400
        if i % 5 == 0:
            write(r / (j + ".publish"), "RESULT PR https://github.com/ashlrai/phantom/pull/%d\n" % (5000 + i))
            os.utime(lp, (old, old)); os.utime(r / (j + ".base"), (old, old))
        elif i % 5 == 1:
            write(r / (j + ".publish"), "RESULT EMPTY\n")
            os.utime(lp, (old, old)); os.utime(r / (j + ".base"), (old, old))
        elif i % 5 == 2:
            write(q / "run" / (j + ".rc"), "0\n")
    write(q / "keep.txt", "RQ-WT2\n")
    return r, q


def tick_env(home):
    env = {"HOME": str(home), "PATH": str(home / "stubbin") + ":" + os.environ.get("PATH", "/usr/bin:/bin"),
           "LANG": "C", "LOADGATE_LOADAVG": "1.0", "LOADGATE_NCPU": "18",
           "LOADGATE_PRESSURE": "1", "LOADGATE_SWAP_GB": "0", "DISKGUARD_FREE_GB": "500",
           "PYTHONPATH": str(home / "stubbin") + ":" + str(MAC)}
    return env


def bench_tick(a):
    times = []
    for _ in range(a.runs):
        with tempfile.TemporaryDirectory(prefix="bench-tick-") as td:
            home = Path(td)
            build_runs(home, a)
            t0 = time.perf_counter()
            proc = subprocess.run([sys.executable, "-B", str(a.dispatchd)], env=tick_env(home),
                                  capture_output=True, text=True, timeout=180)
            times.append((time.perf_counter() - t0) * 1000)
            if proc.returncode not in (0, 1):
                raise RuntimeError("dispatchd tick rc=%d stderr=%s" % (proc.returncode, proc.stderr[:400]))
    return times


def profile_tick(a):
    with tempfile.TemporaryDirectory(prefix="bench-tick-prof-") as td:
        home = Path(td)
        build_runs(home, a)
        out = home / "tick.prof"
        proc = subprocess.run([sys.executable, "-B", "-m", "cProfile", "-o", str(out), str(a.dispatchd)],
                              env=tick_env(home), capture_output=True, text=True, timeout=240)
        if proc.returncode not in (0, 1):
            raise RuntimeError("dispatchd profile rc=%d stderr=%s" % (proc.returncode, proc.stderr[:400]))
        stream = io.StringIO()
        pstats.Stats(str(out), stream=stream).sort_stats("cumulative").print_stats(a.profile_top)
        return stream.getvalue()


# ---- disk.py fixture -------------------------------------------------------

def build_disk_fixture(root, file_count):
    src = root / "source"
    src.mkdir()
    git(src, "init", "-b", "main")
    git(src, "config", "user.email", "bench@example.invalid")
    git(src, "config", "user.name", "Bench fixture")
    git(src, "config", "core.hooksPath", "/dev/null")
    git(src, "remote", "add", "origin", "https://github.com/ashlrai/phantom.git")
    (src / ".gitignore").write_text("node_modules/\n")
    (src / "package.json").write_text('{"name":"bench-fixture","private":true}\n')
    (src / "package-lock.json").write_text('{"name":"bench-fixture","lockfileVersion":3,"packages":{}}\n')
    modules = src / "node_modules"
    modules.mkdir()
    (modules / "pkg.js").write_text("module.exports = 1;\n")
    git(src, "add", ".")
    git(src, "commit", "-qm", "fixture")
    wt = root / "wt-job"
    git(src, "worktree", "add", "-q", "--detach", str(wt), "HEAD")
    state = root / "state"
    # Pre-fill the shared cargo target so du work is measurable (a warm cache).
    common = git(src, "rev-parse", "--path-format=absolute", "--git-common-dir")
    import hashlib
    cache = state / "repos" / hashlib.sha256(os.fsencode(common)).hexdigest()[:32] / "target"
    cache.mkdir(parents=True)
    for i in range(file_count):
        write(cache / ("obj-%05d.bin" % i), "x" * 1536)
    return src, wt, state


def bench_launch(a):
    disk = load_module("bridge_disk_bench", a.disk)
    pre, total = [], []
    for _ in range(a.runs):
        with tempfile.TemporaryDirectory(prefix="bench-launch-") as td:
            src, wt, state = build_disk_fixture(Path(td).resolve(), a.cache_files)
            t0 = time.perf_counter()
            entered = []
            orig = disk.supervised
            def wrapped(*args, **kw):
                entered.append(time.perf_counter())
                return orig(*args, **kw)
            disk.supervised = wrapped
            try:
                code = disk.launch(src, wt, state, "RQ-BENCH-L", ["/usr/bin/true"])
            finally:
                disk.supervised = orig
            total.append((time.perf_counter() - t0) * 1000)
            pre.append((entered[0] - t0) * 1000 if entered else -1)
            if code != 0:
                raise RuntimeError("disk.launch rc=%d" % code)
    return {"preflight_ms": pre, "total_ms": total}


def bench_publish(a):
    disk = load_module("bridge_disk_bench", a.disk)
    times = []
    for _ in range(a.runs):
        with tempfile.TemporaryDirectory(prefix="bench-publish-") as td:
            src, wt, state = build_disk_fixture(Path(td).resolve(), a.cache_files)
            code = disk.launch(src, wt, state, "RQ-BENCH-P", ["/usr/bin/true"])
            if code != 0:
                raise RuntimeError("disk.launch rc=%d" % code)
            evidence = {"url": "https://github.com/ashlrai/phantom/pull/417",
                        "head_oid": git(wt, "rev-parse", "HEAD"), "observed_at": time.time()}
            t0 = time.perf_counter()
            disk.finish(wt, state, "RQ-BENCH-P", evidence)
            times.append((time.perf_counter() - t0) * 1000)
    return times


def bench_reap(a):
    disk = load_module("bridge_disk_bench", a.disk)
    times = []
    for _ in range(a.runs):
        with tempfile.TemporaryDirectory(prefix="bench-reap-") as td:
            root = Path(td).resolve()
            state = root / "state"
            for k in range(4):
                repo = state / "repos" / ("%032x" % k)
                target = repo / "target"
                target.mkdir(parents=True)
                for i in range(a.cache_files // 2):
                    write(target / ("obj-%05d.bin" % i), "x" * 1024)
                write(repo / "cleanup-pending.json", '{"job": "RQ-BENCH-R", "worktree": "/x"}')
            wt = root / "wt-ref"
            wt.mkdir()
            t0 = time.perf_counter()
            disk.reap_pending(state, wt, "RQ-BENCH-R")
            times.append((time.perf_counter() - t0) * 1000)
    return times


# ---- restock pick ----------------------------------------------------------

def build_restock_fixture(home, a):
    r, q = build_runs(home, a)
    # restock reads status/slots for demand; give lanes headroom
    (q / "slots.json").write_text(json.dumps({l: {"target": 12, "floor": 0, "ceiling": 32, "hard_cap": 32}
                                              for l in ("codex-cmp", "codex-personal", "devin", "claude-api", "codex-local")}))
    (q / "ready.tsv").write_text("")   # empty ready file: the pick runs over router-queue READY lines
    return r, q


def bench_pick(a):
    times = []
    for _ in range(a.runs):
        with tempfile.TemporaryDirectory(prefix="bench-pick-") as td:
            home = Path(td)
            build_restock_fixture(home, a)
            env = tick_env(home)
            t0 = time.perf_counter()
            proc = subprocess.run([sys.executable, "-B", str(a.restock), "--dry-run"], env=env,
                                  capture_output=True, text=True, timeout=180)
            times.append((time.perf_counter() - t0) * 1000)
            if proc.returncode != 0:
                raise RuntimeError("restock rc=%d stderr=%s" % (proc.returncode, proc.stderr[:400]))
    return times


def summarize(values):
    return {"median_ms": round(statistics.median(values), 2), "min_ms": round(min(values), 2),
            "max_ms": round(max(values), 2), "runs": len(values)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dispatchd", type=Path, default=MAC / "dispatchd.py")
    p.add_argument("--disk", type=Path, default=DISK)
    p.add_argument("--restock", type=Path, default=MAC / "restock.py")
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--jobs-rows", type=int, default=40000)
    p.add_argument("--ready", type=int, default=60)
    p.add_argument("--base", type=int, default=45)
    p.add_argument("--queue-lines", type=int, default=300)
    p.add_argument("--cache-files", type=int, default=3000)
    p.add_argument("--profile", action="store_true")
    p.add_argument("--profile-top", type=int, default=25)
    p.add_argument("--out", type=Path)
    args = p.parse_args()
    result = {"fixture": {"jobs_rows": args.jobs_rows, "ready": args.ready, "base_files": args.base,
                          "queue_lines": args.queue_lines, "cache_files": args.cache_files}}
    result["tick"] = summarize(bench_tick(args))
    launch = bench_launch(args)
    result["launch_preflight"] = summarize(launch["preflight_ms"])
    result["launch_total"] = summarize(launch["total_ms"])
    result["publish"] = summarize(bench_publish(args))
    result["reap"] = summarize(bench_reap(args))
    result["pick"] = summarize(bench_pick(args))
    text = json.dumps(result, indent=1)
    print(text)
    if args.out:
        args.out.write_text(text + "\n")
    if args.profile:
        print("\n=== tick profile (top %d by cumulative) ===" % args.profile_top)
        print(profile_tick(args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
