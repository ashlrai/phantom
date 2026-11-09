#!/usr/bin/env python3
"""Sample disk consumption without modifying any sampled path."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

FLOOR_GB = 100.0
HISTORY_LIMIT = 48


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.disk-growth-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, indent=2, allow_nan=False)
            f.write('\n')
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(path, default):
    try:
        with path.open() as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def targets(home):
    wt = home / 'Projects/ashlrai/wt'
    paths = [wt, home / '.ashlr-runs/logs', home / '.ashlr-runs/releases',
             home / '.local/share/ashlr/releases', home / '.ashlr/updates/staged', home / '.ashlr/updates/consumer-staging',
             home / '.ashlr/updates/manual-staging', home / '.bun/install/cache',
             home / '.cargo/registry', home / '.cargo/git']
    try:
        for child in sorted(wt.iterdir()):
            if child.is_dir():
                paths.extend([child / 'node_modules', child / 'target'])
    except OSError:
        pass
    return paths


def sample_sizes(paths, budget, clock=time.monotonic, run=subprocess.run):
    deadline = clock() + budget
    sizes = {}
    timed_out = False
    for path in paths:
        remaining = deadline - clock()
        if remaining <= 0:
            timed_out = True
            break
        if not path.exists():
            continue
        try:
            result = run(['du', '-sk', str(path)], capture_output=True, text=True,
                         timeout=remaining, check=True, stdin=subprocess.DEVNULL)
            sizes[str(path)] = int(result.stdout.split()[0]) * 1024 / 1e9
        except subprocess.TimeoutExpired:
            timed_out = True
            break
        except (OSError, subprocess.CalledProcessError, ValueError, IndexError):
            continue
    return sizes, timed_out


def calculate(history, current):
    previous = next((row for row in history if row.get('at', 0) < current['at']), None)
    rate = projection = None
    growers = []
    if previous:
        hours = (current['at'] - previous['at']) / 3600
        rate = (previous['free_gb'] - current['free_gb']) / hours
        if current['free_gb'] <= FLOOR_GB:
            projection = 0.0
        elif rate > 0:
            projection = (current['free_gb'] - FLOOR_GB) / rate
        for path, size in current['sizes_gb'].items():
            if path in previous.get('sizes_gb', {}):
                growth = (size - previous['sizes_gb'][path]) / hours
                if growth > 0:
                    growers.append({'path': path, 'growth_gb_per_h': round(growth, 3)})
        growers.sort(key=lambda row: (-row['growth_gb_per_h'], row['path']))
    elif current['free_gb'] <= FLOOR_GB:
        projection = 0.0
    return {'free_gb': current['free_gb'], 'growth_gb_per_h': round(rate, 3) if rate is not None else None,
            'hours_to_reuse_only': round(projection, 2) if projection is not None else None,
            'top_growers': growers[:10], 'sampled_at': current['at'],
            'timed_out': current['timed_out']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home(), help='home directory to sample')
    parser.add_argument('--budget-seconds', type=float, default=10, help='total du time budget (default: 10)')
    parser.add_argument('--json', action='store_true', help='emit the report as JSON')
    args = parser.parse_args()
    if not 0 < args.budget_seconds <= 300:
        parser.error('budget must be greater than 0 and at most 300 seconds')
    root = args.home / '.ashlr-runs'
    queue = root / 'queue'
    history_path = queue / 'disk-growth-history.json'
    history = read_json(history_path, [])
    if not isinstance(history, list):
        raise ValueError('invalid disk growth history')
    sizes, timed_out = sample_sizes(targets(args.home), args.budget_seconds)
    current = {'at': time.time(), 'free_gb': shutil.disk_usage(args.home).free / 1e9,
               'sizes_gb': sizes, 'timed_out': timed_out}
    report = calculate(history, current)
    atomic_json(history_path, (history + [current])[-HISTORY_LIMIT:])
    atomic_json(queue / 'disk-growth.json', report)
    print(json.dumps(report, indent=2 if not args.json else None))


if __name__ == '__main__':
    main()
