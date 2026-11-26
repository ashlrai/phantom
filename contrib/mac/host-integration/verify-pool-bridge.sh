#!/bin/bash
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
umask 077
if ! scratch=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/phm-verify-pool-bridge.XXXXXXXX"); then
  printf '%s\n' '{"ok":false,"checks":{"scratch":false},"profileSha256s":{}}'
  exit 1
fi
trap '/bin/rm -rf -- "$scratch"' EXIT
trap 'exit 1' HUP INT TERM

TMPDIR="$scratch" HOME="$scratch" /usr/bin/python3 -I -B - "$here" "$scratch" <<'PY'
import json
import os
from pathlib import Path
import subprocess
import sys
import time

here, scratch = (Path(path).resolve() for path in sys.argv[1:])
sys.path.insert(0, str(here.parent))
import pool_bridge_reservation as bridge


def sandbox_check(source, sandbox, verdict):
    tag = source.stem
    claim = scratch / tag
    temp = claim / "tmp"
    temp.mkdir(parents=True)
    workspace = scratch / (tag + "-workspace")
    workspace.mkdir()
    outside = scratch / "outside"
    outside.unlink(missing_ok=True)
    profile = bridge.derive_profile(source.read_text(), True).encode()
    verdict["profileSha256s"][tag] = bridge.sha(profile)
    path = claim / "profile.sb"
    path.write_bytes(profile)
    command = bridge.sandbox_command(sandbox, workspace, claim, temp, path)
    env = {"HOME": str(scratch), "TMPDIR": str(scratch), "PATH": "/usr/bin:/bin"}
    script = ('printf %s inside > "$1/inside" || exit 2; '
              'if (printf %s outside > "$TMPDIR/outside"); then exit 3; fi')
    result = subprocess.run([*command, "/bin/sh", "-c", script, "fixture", str(workspace)],
                            env=env, cwd=workspace, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    verdict["checks"][tag + "Inside"] = ((workspace / "inside").is_file()
                                        and (workspace / "inside").read_text() == "inside")
    verdict["checks"][tag + "OutsideBlocked"] = (
        result.returncode == 0 and verdict["checks"][tag + "Inside"] and not outside.exists())


def gone(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def cancel_check():
    ready = scratch / "pids"
    child = """
import os, pathlib, signal, subprocess, sys
children = [subprocess.Popen(["/bin/sleep", "60"]) for _ in range(2)]
def stop(*args):
    for process in children:
        process.wait(timeout=1)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
ready = pathlib.Path(sys.argv[1])
pending = ready.with_suffix(".tmp")
pending.write_text(" ".join(str(pid) for pid in [os.getpid(), *(p.pid for p in children)]))
pending.replace(ready)
signal.pause()
"""
    rc, reason, confirmed = bridge.supervise([sys.executable, "-I", "-B", "-c", child, str(ready)],
                                              scratch, {}, "", subprocess.DEVNULL,
                                              time.monotonic() + 10, ready.exists)
    pids = [int(value) for value in ready.read_text().split()]
    return rc == 0 and reason == "cancelled" and confirmed and len(set(pids)) == 3 and all(map(gone, pids))


mode = "macos" if sys.platform == "darwin" else "synthetic"
sandbox = ("/usr/bin/sandbox-exec" if mode == "macos"
           else os.environ.get("POOL_BRIDGE_FIXTURE_SANDBOX", "/usr/bin/sandbox-exec"))
verdict = {"schema": "mac-pool-bridge-verify.v1", "mode": mode, "ok": False, "profileSha256s": {},
           "checks": {"zaiInside": False, "zaiOutsideBlocked": False, "agentInside": False,
                      "agentOutsideBlocked": False, "groupCancelled": False}}
for name in ("zai.sb", "agent.sb"):
    try:
        sandbox_check(here / name, sandbox, verdict)
    except (bridge.Held, OSError, ValueError, subprocess.SubprocessError):
        pass
try:
    verdict["checks"]["groupCancelled"] = cancel_check()
except (OSError, ValueError, subprocess.SubprocessError):
    pass
verdict["ok"] = all(verdict["checks"].values())
print(json.dumps(verdict, separators=(",", ":")))
sys.exit(0 if verdict["ok"] else 1)
PY
