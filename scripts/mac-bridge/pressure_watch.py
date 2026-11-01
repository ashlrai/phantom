#!/usr/bin/env python3
"""Foreground Darwin memory admission monitor; no process or service controls."""
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from memory_admission import MAX_SWAP, atomic_json, open_lock, parse_snapshot, private_directory

WINDOW = 600
STALE = 180
RECOVERY_SECONDS = 120
OWNER = 'phantom.pressure-watch.v1'


def probe():
    def read(*args):
        return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=3).stdout
    pressure = read('/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level').strip()
    vm = read('/usr/bin/vm_stat')
    snapshot = parse_snapshot(read('/usr/sbin/sysctl', '-n', 'hw.memsize'), vm,
                              read('/usr/sbin/sysctl', '-n', 'vm.swapusage'))
    page = re.search(r'page size of (\d+) bytes', vm)
    compressed = re.search(r'^Pages occupied by compressor:\s+(\d+)\.', vm, re.M)
    if not re.fullmatch(r'\d+', pressure) or not page or not compressed:
        raise ValueError('unrecognized pressure or compressor telemetry')
    level = int(pressure)
    if level not in (1, 2, 4):
        raise ValueError('unknown memory pressure level')
    return dict(pressureLevel=level, totalBytes=snapshot.total, availableBytes=snapshot.free,
                swapUsedBytes=snapshot.swap, compressorBytes=int(page[1]) * int(compressed[1]))


def valid_sample(sample):
    if not isinstance(sample, dict):
        return False
    keys = ('pressureLevel', 'totalBytes', 'availableBytes', 'swapUsedBytes', 'compressorBytes')
    if any(type(sample.get(k)) is not int or sample[k] < 0 for k in keys):
        return False
    return (sample['pressureLevel'] in (1, 2, 4) and sample['totalBytes'] > 0
            and sample['availableBytes'] <= sample['totalBytes'])


class Watch:
    def __init__(self, pause_file, state_dir, sampler=probe, clock=time.time):
        self.pause = Path(pause_file)
        self.root = Path(state_dir)
        self.sampler, self.clock = sampler, clock
        private_directory(self.root)
        if self.pause.name == 'HOLD':
            raise ValueError('HOLD cannot be used as the monitor pause file')

    def create_pause(self, payload):
        # Link a fully written file into place exclusively: never replace an existing sentinel.
        temp = self.pause.with_name('.pressure-watch-' + uuid.uuid4().hex)
        try:
            with temp.open('x', encoding='utf-8') as handle:
                os.chmod(temp, 0o600)
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(temp, self.pause)
                info = temp.stat()
                return [info.st_dev, info.st_ino]
            except FileExistsError:
                return None
        finally:
            temp.unlink(missing_ok=True)

    def remove_owned(self, payload, identity):
        try:
            before = self.pause.lstat()
            if [before.st_dev, before.st_ino] != identity:
                return
            if not self.pause.is_file() or self.pause.is_symlink():
                return
            if self.pause.read_text(encoding='utf-8') != payload:
                return
            after = self.pause.lstat()
            if (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_size) == (
                    after.st_dev, after.st_ino, after.st_mtime_ns, after.st_size):
                self.pause.unlink()
        except FileNotFoundError:
            pass

    def tick(self):
        fd = open_lock(self.root / 'pressure-watch.lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            return self._tick()
        finally:
            os.close(fd)

    def _tick(self):
        now = self.clock()
        state_path = self.root / 'pressure-watch-state.json'
        malformed = False
        try:
            state = json.loads(state_path.read_text(encoding='utf-8'))
            if (not isinstance(state, dict) or state.get('version') != 1
                    or not re.fullmatch(r'[0-9a-f]{32}', state.get('token', ''))
                    or type(state.get('healthyCount')) is not int or state['healthyCount'] < 0
                    or not isinstance(state.get('history'), list)
                    or not (state.get('identity') is None or
                            (isinstance(state['identity'], list) and len(state['identity']) == 2 and
                             all(type(x) is int and x >= 0 for x in state['identity'])))
                    or len(state['history']) > 601
                    or any(not isinstance(p, list) or len(p) != 2 or
                           any(type(x) not in (int, float) or not math.isfinite(x) or x < 0
                               for x in p) for p in state['history'])
                    or any(type(state.get(k)) not in (int, float) or not math.isfinite(state[k])
                           or state[k] < 0 for k in ('lastTime', 'healthySince'))
                    or state['healthySince'] > state['lastTime']
                    or any(p[0] > state['lastTime'] for p in state['history'])
                    or any(a[0] > b[0] for a, b in zip(state['history'], state['history'][1:]))):
                raise ValueError('invalid monitor state')
        except FileNotFoundError:
            state = dict(version=1, token=uuid.uuid4().hex, healthyCount=0,
                         healthySince=0, lastTime=0, history=[], identity=None)
        except (ValueError, TypeError, UnicodeError, OSError):
            # Do not repair or trust corrupt state automatically.
            malformed = True
            state = dict(version=1, token=uuid.uuid4().hex, healthyCount=0,
                         healthySince=0, lastTime=0, history=[], identity=None)
        payload = json.dumps(dict(owner=OWNER, token=state['token']), sort_keys=True) + '\n'
        # Establish a fail-closed sentinel before sampling or writing observations.
        identity = self.create_pause(payload)
        if identity is not None:
            state['identity'] = identity
        reasons = []
        if malformed:
            reasons.append('malformed-state')
        if state['lastTime'] and (now < state['lastTime'] or now - state['lastTime'] > STALE):
            reasons.append('stale-telemetry')
            state['history'] = []
        try:
            sample = self.sampler()
            if not valid_sample(sample):
                raise ValueError('invalid sample')
        except (OSError, ValueError, subprocess.SubprocessError):
            sample = None
            reasons.append('telemetry-unavailable')
        finished = self.clock()
        if not math.isfinite(finished) or finished < now or finished - now > STALE:
            reasons.append('stale-telemetry')
            sample = None
        history = [p for p in state['history'] if 0 <= now - p[0] <= WINDOW]
        growth = 0
        if sample:
            if history:
                growth = max(0, sample['swapUsedBytes'] - min(p[1] for p in history))
            history.append([now, sample['swapUsedBytes']])
            if sample['pressureLevel'] >= 2:
                reasons.append('pressure')
            if growth > 2_000_000_000 or sample['swapUsedBytes'] >= MAX_SWAP:
                reasons.append('swap')
            if sample['availableBytes'] / sample['totalBytes'] < 0.25:
                reasons.append('memory')
        healthy = (not reasons and sample is not None and growth <= 1_000_000_000
                   and sample['availableBytes'] / sample['totalBytes'] >= 0.35)
        if healthy:
            if not state['healthyCount']:
                state['healthySince'] = now
            state['healthyCount'] += 1
        else:
            state['healthyCount'], state['healthySince'] = 0, 0
        # Multiple --once calls can occur within a second; retain each second's
        # minimum so growth detection remains conservative and bounded.
        compact = {}
        for timestamp, swap in history:
            second = int(timestamp)
            previous = compact.get(second, [timestamp, swap])
            compact[second] = [timestamp, min(previous[1], swap)]
        history = list(compact.values())
        observation = dict(timestamp=finished, **(sample or dict(
            pressureLevel=None, totalBytes=None, availableBytes=None,
            swapUsedBytes=None, compressorBytes=None)))
        observation['freeMemoryPercent'] = (100 * sample['availableBytes'] / sample['totalBytes']
                                            if sample else None)
        observation.update(reasons=reasons, swapGrowthBytes=growth if sample else None)
        atomic_json(self.root / 'memguard.json', observation)
        if not malformed:
            state.update(lastTime=now, history=history)
            atomic_json(state_path, state)
            if healthy and state['healthyCount'] >= 3 and now - state['healthySince'] >= RECOVERY_SECONDS:
                self.remove_owned(payload, state['identity'])
        return reasons


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pause-file', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--interval', type=float, default=60)
    args = parser.parse_args()
    if not math.isfinite(args.interval) or not 1 <= args.interval <= 120:
        parser.error('--interval must be between 1 and 120 seconds')
    if sys.platform != 'darwin':
        parser.exit(2, 'pressure-watch: unsupported OS; Darwin required\n')
    try:
        watch = Watch(args.pause_file, args.state_dir)
        while True:
            reasons = watch.tick()
            print('pressure-watch: ' + (', '.join(reasons) if reasons else 'sampled'), flush=True)
            if args.once:
                return 0
            time.sleep(args.interval)
    except (OSError, ValueError) as error:
        print(f'pressure-watch: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
