#!/usr/bin/env python3
"""Private, bounded, read-only host/session observation.

Session rows require a caller-supplied independent current-claim verifier and two
identity-bearing process censuses. A missing verifier or identity is unknown.
No command lines, environment, signals or provider calls are collected here.
"""
import argparse
import datetime
import math
import os
import platform
import re
import selectors
import subprocess
import time

MAX_ROWS = 8192
MAX_BYTES = 1024 * 1024
MAX_SECONDS = 2.0
MAX_CLAIMS = 256


def _bounded(argv, timeout=MAX_SECONDS, limit=MAX_BYTES):
    """Bound output and elapsed time; only the inspection child is terminated."""
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env={'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'C', 'LC_ALL': 'C'})
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    data = bytearray()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('inspection deadline')
            events = selector.select(remaining)
            if not events:
                raise TimeoutError('inspection deadline')
            block = os.read(child.stdout.fileno(), min(65536, limit + 1 - len(data)))
            if not block:
                break
            data.extend(block)
            if len(data) > limit:
                raise ValueError('inspection byte budget')
        if child.wait(timeout=max(0.001, deadline - time.monotonic())):
            raise ValueError('inspection failed')
        return data.decode('ascii')
    finally:
        selector.close()
        if child.poll() is None:
            child.kill()
            child.wait()
        child.stdout.close()


def pressure_level(system=None, run=_bounded):
    """Return current macOS kernel pressure; other platforms retain admission."""
    system = platform.system() if system is None else system
    if system != 'Darwin':
        return {'state': 'not-applicable', 'level': None}
    try:
        raw = run(['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level'])
        if not re.fullmatch(r'\s*[0-9]+\s*', raw):
            raise ValueError('invalid pressure')
        value = int(raw)
        state = {1: 'normal', 2: 'warning', 4: 'critical'}.get(value, 'unknown')
        return {'state': state, 'level': value if value in (1, 2, 4) else None}
    except (OSError, ValueError, TimeoutError, UnicodeError, subprocess.SubprocessError):
        return {'state': 'unknown', 'level': None}


def admission_allowed(pressure):
    return pressure.get('state') in ('normal', 'not-applicable')


def numeric_census(run=_bounded):
    """Read a bounded numeric process table without command or environment data.

    This table has no reliable process-start identity and cannot establish job
    ownership by itself. It is transient and never serialized.
    """
    raw = run(['/bin/ps', '-axo', 'pid=,ppid=,rss=,pcpu='])
    if len(raw.encode('ascii')) > MAX_BYTES:
        raise ValueError('census byte budget')
    lines = raw.splitlines()
    if not lines or len(lines) > MAX_ROWS:
        raise ValueError('census row budget')
    rows, seen = [], set()
    for line in lines:
        fields = line.split()
        if len(fields) != 4 or any(not re.fullmatch(r'[0-9]+', x) for x in fields[:3]):
            raise ValueError('incomplete numeric census')
        pid, ppid, rss = map(int, fields[:3])
        if not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', fields[3]):
            raise ValueError('invalid CPU')
        cpu = float(fields[3])
        if pid <= 0 or pid in seen or not math.isfinite(cpu):
            raise ValueError('invalid process identity')
        seen.add(pid)
        rows.append({'pid': pid, 'ppid': ppid, 'rssBytes': rss * 1024, 'cpuPercent': cpu})
    return rows


def identity_census(run=_bounded):
    """Read a bounded start-bearing census, with second-resolution ps identity.

    The 64-hex epoch reference is compatible with local-store-lock's ps-lstart
    representation. This is an observation, not proof of a claim: the real
    source-owned start/boot readers and a current owner must still validate it.
    ps lstart has only one-second precision and is not a cryptographic identity.
    """
    raw = run(['/bin/ps', '-axo', 'pid=,ppid=,rss=,pcpu=,uid=,lstart='])
    if len(raw.encode('ascii')) > MAX_BYTES:
        raise ValueError('census byte budget')
    lines = raw.splitlines()
    if not lines or len(lines) > MAX_ROWS:
        raise ValueError('census row budget')
    rows, seen = [], set()
    for line in lines:
        fields = line.split()
        if len(fields) != 10 or any(not re.fullmatch(r'[0-9]+', x) for x in fields[:3] + fields[4:5]):
            raise ValueError('incomplete start census')
        pid, ppid, rss = map(int, fields[:3])
        if not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', fields[3]):
            raise ValueError('invalid CPU')
        cpu = float(fields[3])
        try:
            parsed = time.strptime(' '.join(fields[5:]), '%a %b %d %H:%M:%S %Y')
            epoch = int(time.mktime(parsed))
        except (ValueError, OverflowError, OSError):
            raise ValueError('invalid process start') from None
        if pid <= 0 or pid in seen or not math.isfinite(cpu) or epoch < 0:
            raise ValueError('invalid process identity')
        seen.add(pid)
        rows.append({'pid': pid, 'ppid': ppid, 'rssBytes': rss * 1024,
                     'cpuPercent': cpu, 'uid': int(fields[4]), 'start': format(epoch, '064x'),
                     'startSource': 'ps-lstart'})
    return rows


def _table(rows):
    if not isinstance(rows, list) or len(rows) > MAX_ROWS or not rows:
        raise ValueError('incomplete census')
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('invalid row')
        pid, ppid, rss, cpu, start = (row.get(k) for k in ('pid', 'ppid', 'rssBytes', 'cpuPercent', 'start'))
        if (type(pid) is not int or pid <= 0 or type(ppid) is not int or ppid < 0
                or type(rss) is not int or rss < 0 or type(cpu) not in (int, float)
                or not math.isfinite(cpu) or cpu < 0 or not isinstance(start, str) or not start
                or pid in result):
            raise ValueError('invalid or duplicate census row')
        result[pid] = row
    return result


def _tree(root, table):
    found, stack = set(), [root]
    children = {}
    for pid, row in table.items():
        children.setdefault(row['ppid'], []).append(pid)
    while stack:
        pid = stack.pop()
        if pid in found:
            raise ValueError('cyclic tree')
        found.add(pid)
        stack.extend(children.get(pid, ()))
    return found


def observe_sessions(claims, first, second, boot_id, cpu_count, verify_claim):
    """Join independently verified claims to two identity-bearing PPID censuses.

    Both censuses must agree on every tree member's PID, PPID and process-start
    identity. A duplicate/nested root or a race makes affected sessions unknown.
    verifier(claim) must re-read the current ownership record, not trust its input.
    """
    if not isinstance(claims, list) or len(claims) > MAX_CLAIMS:
        raise ValueError('claim budget')
    result = [{'jobId': c.get('jobId') if isinstance(c, dict) else None,
               'state': 'unknown', 'processCount': None, 'rssBytes': None,
               'cpuPercentOneCore': None, 'cpuPercentHost': None, 'swapBytes': None}
              for c in claims]
    try:
        a, b = _table(first), _table(second)
    except ValueError:
        return result
    trees = {}
    for i, claim in enumerate(claims):
        if not isinstance(claim, dict):
            continue
        pid = claim.get('rootPid')
        job = claim.get('jobId')
        if (not isinstance(job, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,128}', job)
                or type(pid) is not int or pid <= 0 or not isinstance(boot_id, str) or not boot_id
                or claim.get('bootId') != boot_id or pid not in a or pid not in b
                or not isinstance(claim.get('start'), str) or not claim['start']
                or a[pid]['start'] != claim['start'] or b[pid]['start'] != claim['start']
                or a[pid].get('uid') != os.getuid() or b[pid].get('uid') != os.getuid()):
            continue
        try:
            if not callable(verify_claim) or verify_claim(claim) is not True:
                continue
            one, two = _tree(pid, a), _tree(pid, b)
            if one != two or any((a[p]['ppid'], a[p]['start']) != (b[p]['ppid'], b[p]['start']) for p in one):
                continue
            trees[i] = two
        except (ValueError, OSError):
            continue
    for i, tree in trees.items():
        if any(tree & other for j, other in trees.items() if j != i):
            continue
        # Revalidate after both censuses to catch a changing claim owner.
        try:
            if verify_claim(claims[i]) is not True:
                continue
        except (ValueError, OSError):
            continue
        rss = sum(b[p]['rssBytes'] for p in tree)
        cpu = sum(b[p]['cpuPercent'] for p in tree)
        if not math.isfinite(cpu):
            continue
        result[i].update(state='known', processCount=len(tree), rssBytes=rss,
                         cpuPercentOneCore=cpu,
                         cpuPercentHost=cpu / cpu_count if type(cpu_count) is int and cpu_count > 0 else None)
    return result


def host_observation(system=None, run=_bounded):
    # Numeric census is deliberately not serialized; verified sessions need
    # independently established claims and process-start identities.
    try:
        numeric_census(run)
        census = 'known'
    except (OSError, ValueError, TimeoutError, UnicodeError, subprocess.SubprocessError):
        census = 'unknown'
    return {'schemaVersion': 1,
            'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
            'pressure': pressure_level(system, run), 'censusState': census,
            'sessionsState': 'unknown', 'sessions': []}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--admission', action='store_true')
    args = parser.parse_args()
    observation = host_observation()
    if args.admission:
        return 0 if (observation['pressure']['state'] == 'not-applicable' or
                     (admission_allowed(observation['pressure']) and observation['censusState'] == 'known')) else 3
    import json
    print(json.dumps(observation, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
