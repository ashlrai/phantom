"""Bound process inspection without reading every application's argument memory.

Only engine and shell processes need arguments to establish job ownership. A
failed inspection is unknown liveness, never proof that workers disappeared.
"""
import os
import signal
import subprocess


WORKER_NAMES = {'bash', 'sh', 'zsh', 'node', 'bun', 'Python', 'python', 'python3',
                'codex', 'devin', 'claude', 'git'}


def _bounded(args, timeout):
    child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, start_new_session=True)
    try:
        stdout, stderr = child.communicate(timeout=timeout)
        return subprocess.CompletedProcess(args, child.returncode, stdout, stderr)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass
        # A Darwin task can remain in uninterruptible kernel sleep after kill.
        # Reap ordinary children promptly, but bound cleanup as well.
        try:
            child.communicate(timeout=0.1)
        except subprocess.TimeoutExpired:
            for pipe in (child.stdout, child.stderr):
                if pipe:
                    pipe.close()
            # Reap the killed child as well, so it does not linger as <defunct> under a long-lived caller.
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        return subprocess.CompletedProcess(args, 124, '', 'process inspection timed out')


def _rows(text):
    rows = {}
    for line in text.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[0].isdigit():
            rows[int(fields[0])] = fields[1]
    return rows


def capture(timeout=5):
    """Return a pid/command snapshot, or nonzero for unknown ownership.

    `comm` avoids the globally blocked argv read. Arguments are then requested
    only for potential job owners. Never use comm-only rows as a successful
    ownership snapshot when a live worker's argument inspection failed.
    """
    names = _bounded(['ps', '-axo', 'pid=,comm='], timeout)
    if names.returncode:
        return names
    rows = _rows(names.stdout)
    if not rows:
        return subprocess.CompletedProcess(names.args, 124, '', 'empty process inventory')
    targets = [pid for pid, name in rows.items() if os.path.basename(name) in WORKER_NAMES]
    if not targets:
        return names
    args = ['ps', '-ww', '-p', ','.join(str(pid) for pid in targets), '-o', 'pid=,command=']
    commands = _bounded(args, timeout)
    if commands.returncode not in (0, 1):
        return commands
    inspected = _rows(commands.stdout)
    for pid in targets:
        if pid in inspected:
            rows[pid] = inspected[pid]
            continue
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            rows.pop(pid, None)  # A real exit between the two snapshots.
            continue
        except OSError:
            pass
        return subprocess.CompletedProcess(args, 124, '', 'live worker ownership unknown')
    return subprocess.CompletedProcess(args, 0, ''.join(f'{pid} {name}\n' for pid, name in rows.items()), '')
