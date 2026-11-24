"""Verified first-minute ps CPU samples; not CPU seconds. Brief children may be missed."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import host_session_runtime as runtime


def measure(runs, job, lane, *, now=time.time, sleep=time.sleep, monotonic=time.monotonic):
    if not runtime.JOB.fullmatch(job) or not runtime.JOB.fullmatch(lane):
        raise ValueError('invalid launch identity')
    attached, tick = now(), monotonic()
    current = lambda: attached + monotonic() - tick
    result = dict(schema='fleet.launch-cost.v1', lane=lane, launchId=job,
                  startedAt=None,
                  windowSeconds=60, sampledSeconds=0, samples=0, peakProcesses=None,
                  meanCpuPercentOneCore=None, peakCpuPercentOneCore=None, status='unknown')
    counts, cpus, attempts, started = [], [], 0, attached
    try:
        claim = next(c for c in runtime.read_claims(runs) if c.get('jobId') == job)
        if not runtime.verify_current_claim(runs, claim) or claim.get('startSource') != 'ps-lstart':
            return result
        started = int(claim['start'], 16)
        if not 0 <= attached - started < 60:
            return result
        result.update(startedAt=datetime.datetime.fromtimestamp(started, datetime.timezone.utc).isoformat(),
                      launchId=job + '-' + hashlib.sha256(json.dumps(claim, sort_keys=True).encode()).hexdigest()[:12])
        while current() < started + 60:
            claims = runtime.read_claims(runs)
            if claim not in claims:
                break  # Relaunches never lend evidence to this attempt.
            observation = runtime.collect_observation(claims, lambda c: runtime.verify_current_claim(runs, c),
                                                      pressure=lambda: {'state': 'unknown', 'level': None})
            row = next((r for r in observation['sessions'] if r['jobId'] == job), {})
            attempts += 1
            stamp = current()
            if row.get('state') == 'known' and stamp <= started + 60:
                counts.append(row['processCount']); cpus.append(row['cpuPercentOneCore'])
            if stamp >= started + 60:
                break
            sleep(min(5, started + 60 - stamp))
    except (OSError, ValueError, KeyError, StopIteration, TimeoutError):
        pass  # Missing custody is unknown, never zero.
    if counts:
        result.update(samples=len(counts), sampledSeconds=round(min(60, current() - attached), 3),
                      peakProcesses=max(counts), meanCpuPercentOneCore=sum(cpus) / len(cpus),
                      peakCpuPercentOneCore=max(cpus),
                      status='measured' if attached - started <= 1 and len(counts) == attempts
                      and attempts >= 12 and current() >= started + 60 else 'partial')
    return result


def append(runs, result):
    with runtime.runs_directory(os.path.join(runs, 'metrics')) as directory:
        fd = os.open('launch-cost.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                     0o600, dir_fd=directory)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            info = os.fstat(fd)
            data = (json.dumps(result, allow_nan=False, separators=(',', ':')) + '\n').encode()
            if not runtime._owned(info) or info.st_mode & 0o077 or info.st_size + len(data) > 1024 * 1024:
                raise ValueError('unsafe or full launch ledger')
            if len(data) > 4096 or os.write(fd, data) != len(data):
                raise ValueError('launch record write failed')
        finally:
            os.close(fd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs-dir', default=os.path.expanduser('~/.ashlr-runs'))
    parser.add_argument('--session-id', required=True)
    parser.add_argument('--lane', required=True)
    args = parser.parse_args()
    try:
        append(args.runs_dir, measure(args.runs_dir, args.session_id, args.lane))
    except (OSError, ValueError):
        sys.exit('launch cost unavailable')
