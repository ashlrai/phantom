#!/usr/bin/python3
# install-gate (RQ-LOADGATE-1): at most one `npm ci` / `pnpm install` / `bun install` at a time, fleet-wide.
#   install-gate.py [--lock FILE] [--timeout SECONDS] [--job ID] -- <command> [args...]
#   install-gate.py --shims DIR      write npm/pnpm/bun shims into DIR; prefix PATH with DIR in launch.sh
# The lock is flock(LOCK_EX) on queue/install.lock (default $ASHLR_RUNS_DIR or ~/.ashlr-runs, then /queue). Others wait for it,
# polling so --timeout can expire (exit 75). The holder (pid, job, command, since) is written into the lock file while held;
# the flock dies with the process, so a crashed holder never wedges the fleet. Commands that are not installs run unlocked.
# No network, no LLM; the child inherits only this process's environment.
import fcntl, json, os, signal, subprocess, sys, time

INSTALL = {"npm": {"ci", "install", "i"}, "pnpm": {"install", "i"}, "bun": {"install", "i"}}
WAIT_S = 1800; POLL_S = 0.25; EX_TEMPFAIL = 75


def is_install(argv):
    """True when argv is one of the guarded package-manager installs. Leading flags before the verb are skipped (write value flags as --prefix=x)."""
    if not argv: return False
    tool = os.path.basename(argv[0])
    verbs = INSTALL.get(tool)
    if not verbs: return False
    for a in argv[1:]:
        if a.startswith("-"): continue
        return a in verbs
    return False


def default_lock():
    root = os.environ.get("ASHLR_RUNS_DIR") or os.path.join(os.path.expanduser("~"), ".ashlr-runs")
    return os.path.join(root, "queue", "install.lock")


def acquire(path, timeout, holder):
    """Block until the flock is ours; None on timeout. The returned fd must stay open for the lock's lifetime."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); break
        except BlockingIOError:
            if time.monotonic() >= deadline: os.close(fd); return None
            time.sleep(POLL_S)
    os.ftruncate(fd, 0); os.pwrite(fd, (json.dumps(holder, sort_keys=True) + "\n").encode(), 0)
    return fd


def run_locked(argv, path, timeout, job):
    holder = {"pid": os.getpid(), "job": job, "command": " ".join(argv[:3]), "since": int(time.time())}
    fd = acquire(path, timeout, holder)
    if fd is None:
        sys.stderr.write("install-gate: timed out after %ds waiting for %s\n" % (timeout, path)); return EX_TEMPFAIL
    try:
        child = subprocess.Popen(argv)
        for sig in (signal.SIGINT, signal.SIGTERM): signal.signal(sig, lambda n, _f: child.send_signal(n))
        return child.wait()
    finally:
        try: os.ftruncate(fd, 0)   # holder cleared before the lock drops; readers also verify pid liveness
        except OSError: pass
        os.close(fd)


SHIM = """#!/bin/bash
# install-gate shim (RQ-LOADGATE-1): resolves the real {tool} outside this directory, then defers to install-gate.py.
d="$(cd "$(dirname "$0")" && pwd)"; real=""
IFS=: read -ra parts <<< "$PATH"
for p in "${{parts[@]}}"; do [ "$p" = "$d" ] && continue; [ -x "$p/{tool}" ] && real="$p/{tool}" && break; done
[ -n "$real" ] || {{ echo "{tool}: not found on PATH" >&2; exit 127; }}
exec /usr/bin/python3 "{gate}" -- "$real" "$@"
"""


def write_shims(directory):
    os.makedirs(directory, exist_ok=True)
    for tool in INSTALL:
        dest = os.path.join(directory, tool)
        with open(dest + ".tmp", "w") as f: f.write(SHIM.format(tool=tool, gate=os.path.abspath(__file__)))
        os.chmod(dest + ".tmp", 0o755); os.replace(dest + ".tmp", dest)
    return 0


def main(argv):
    path, timeout, job, i = default_lock(), WAIT_S, os.environ.get("ASHLR_JOB_ID", ""), 0
    while i < len(argv) and argv[i].startswith("--"):
        a = argv[i]
        if a == "--": break
        if a == "--shims" and i + 1 < len(argv): return write_shims(argv[i + 1])
        if a in ("--lock", "--timeout", "--job") and i + 1 < len(argv):
            v = argv[i + 1]
            if a == "--lock": path = v
            elif a == "--job": job = v
            else:
                try: timeout = max(0, int(v))
                except ValueError: sys.stderr.write("install-gate: --timeout needs whole seconds\n"); return 2
            i += 2; continue
        sys.stderr.write("usage: install-gate.py [--lock F] [--timeout S] [--job ID] -- cmd...  |  --shims DIR\n"); return 2
    if i < len(argv) and argv[i] == "--": i += 1
    cmd = argv[i:]
    if not cmd: sys.stderr.write("install-gate: no command\n"); return 2
    if not is_install(cmd):
        try: os.execvp(cmd[0], cmd)
        except OSError as e: sys.stderr.write("install-gate: %s: %s\n" % (cmd[0], e.strerror)); return 127
    try: return run_locked(cmd, path, timeout, job)
    except FileNotFoundError: sys.stderr.write("install-gate: %s: not found\n" % cmd[0]); return 127


if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
