#!/usr/bin/python3
"""Bound the entire host launcher, including preparation, for codex-local only.

The child retains the existing launcher and its sandbox checks. No provider call,
credential access, worktree mutation or publishing happens in this supervisor.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

WALL_CAP_S = 2400


def supervise(command, marker, cap=WALL_CAP_S):
    """Kill the launcher process group at its deadline, while its leader is running."""
    started = time.monotonic()
    child = subprocess.Popen(command, start_new_session=True)
    try:
        code = child.wait(timeout=cap)
    except subprocess.TimeoutExpired:
        # SIGKILL avoids an unbounded termination grace period. Children share the
        # launcher's session unless the host launcher deliberately detaches them.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        Path(marker).write_text(json.dumps({"reason": "timeout", "wall_s": round(time.monotonic() - started, 3),
                                           "wall_cap_s": cap}) + "\n")
        return 124
    return code


def main():
    job, repo, lane, tier = sys.argv[1:]
    if lane != 'codex-local' or not job or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-' for c in job):
        raise SystemExit('invalid local job')
    root = Path.home() / '.ashlr-runs'
    marker = root / 'queue' / 'run' / (job + '.timeout')
    code = supervise(['/bin/bash', str(root / 'bin' / 'launch.sh'), job, repo, lane, tier], marker)
    if code == 124:
        (root / 'queue' / 'run' / (job + '.rc')).write_text('124\n')
        outcome = json.loads(marker.read_text())
        outcome.update(event='finish', job=job, repo=repo, lane=lane, exit_code=124,
                       ts=time.strftime('%Y-%m-%dT%H:%M:%S%z'))
        with (root / 'metrics' / 'jobs.jsonl').open('a') as stream:
            stream.write(json.dumps(outcome) + '\n')
    return code


if __name__ == '__main__':
    sys.exit(main())
