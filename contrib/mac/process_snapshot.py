"""Bound process inspection without reading every application's argument memory.

Only engine and shell processes need arguments to establish job ownership. A
failed inspection is unknown liveness, never proof that workers disappeared.
"""
import os
import re
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


# pid, lstart (the fixed-width ps timestamp), comm.
START_ROW = re.compile(r'\s*(\d+)\s+(.{24})\s+(.*?)\s*')


def _rows_with_start(text):
    rows, starts = {}, {}
    for line in text.splitlines():
        match = START_ROW.fullmatch(line)
        if match:
            pid = int(match.group(1))
            rows[pid] = match.group(3).strip()
            starts[pid] = match.group(2).strip() or None
            continue
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[0].isdigit():
            pid = int(fields[0])
            rows[pid] = fields[1]
            starts[pid] = None
    return rows, starts


def read_start_time(pid, timeout=5):
    """Return ps's process start identity, or None when the PID cannot be identified."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 1:
        return None
    try:
        result = _bounded(['ps', '-p', str(pid), '-o', 'lstart='], timeout)
    except OSError:
        return None
    if result.returncode:
        return None
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return lines[0] if len(lines) == 1 else None


# pid, ppid, %cpu (one-core percent), comm (may contain spaces).
CPU_ROW = re.compile(r'\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\S.*?)\s*')


def _inventory(text, cpu):
    """Return (names, table). table maps pid -> (ppid, pcpu) only when cpu was requested and every row had CPU columns.

    A row without CPU columns (a legacy `pid comm` inventory) still yields its name, so a caller asking for CPU gets
    table None rather than names polluted by the ppid and %cpu columns.
    """
    if not cpu:
        return _rows(text), None
    rows, table, complete = {}, {}, True
    for line in text.splitlines():
        match = CPU_ROW.fullmatch(line)
        if match:
            pid = int(match.group(1))
            rows[pid] = match.group(4)
            table[pid] = (int(match.group(2)), float(match.group(3)))
            continue
        complete = False
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[0].isdigit():
            rows[int(fields[0])] = fields[1]
    return rows, table if complete else None


def _snapshot(args, rows, table, starts=None):
    """The `pid name` stdout every caller reads, plus CPU and process-start metadata."""
    result = subprocess.CompletedProcess(args, 0, ''.join(f'{pid} {name}\n' for pid, name in rows.items()), '')
    result.cpu = None if table is None else {pid: table[pid] for pid in rows}
    result.start_times = {pid: (starts or {}).get(pid) for pid in rows}
    return result


def capture(timeout=5, cpu=False):
    """Return a pid/command snapshot, or nonzero for unknown ownership.

    `comm` avoids the globally blocked argv read. Arguments are then requested
    only for potential job owners. Never use comm-only rows as a successful
    ownership snapshot when a live worker's argument inspection failed.

    cpu=True reads the parent and %CPU columns in the same single inventory call and sets `.cpu` (see _snapshot).
    The inventory and the argument probe are unchanged otherwise.
    """
    names = _bounded(['ps', '-axo', 'pid=,ppid=,pcpu=,comm=' if cpu else 'pid=,lstart=,comm='], timeout)
    if names.returncode:
        return names
    if cpu:
        rows, table = _inventory(names.stdout, cpu)
        starts = {}
    else:
        rows, starts = _rows_with_start(names.stdout)
        table = None
    if not rows:
        return subprocess.CompletedProcess(names.args, 124, '', 'empty process inventory')
    targets = [pid for pid, name in rows.items() if os.path.basename(name) in WORKER_NAMES]
    if not targets:
        return _snapshot(names.args, rows, table, starts)
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
    return _snapshot(args, rows, table, starts)
