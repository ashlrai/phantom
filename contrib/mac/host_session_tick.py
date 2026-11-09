#!/usr/bin/env python3
"""Dispatcher-owned resource observation; called under its existing tick lock.

No command line path override exists. Tests call tick() with a synthetic runs tree.
Registration observes a child already launched and never controls its lifecycle.
"""
import os
import sys
import time

# Isolated Python does not add the script directory to sys.path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import host_session_runtime as runtime
import host_session_disk_cache as disk


def tick(runs, *, roots_provider=None, now=None, **dependencies):
    observation = runtime.collect_and_publish(runs, **dependencies)
    observation['disk'] = {'state': 'unknown', 'allocatedBytes': None,
                           'ageSeconds': None, 'provenance': None}
    try:
        roots = (roots_provider or runtime.verified_worktrees)(runs)
        if roots:
            with runtime.runs_directory(runs) as directory:
                rows = disk.refresh_persisted(directory, roots, runtime.read_json_at,
                                              runtime.write_json_at, now=now)
            # Recheck custody after the slow scan; a replaced attempt cannot
            # lend its historical attribution to the current observation.
            if (roots_provider or runtime.verified_worktrees)(runs) != roots:
                raise ValueError('disk custody changed')
            instant = time.time() if now is None else now
            if len(rows) == len(roots) and all(row.get('state') in ('historical', 'stale')
                    and type(row.get('allocatedBytes')) is int and row['allocatedBytes'] >= 0
                    and isinstance(row.get('sampledAt'), (int, float))
                    and 0 <= row['sampledAt'] <= instant for row in rows):
                observation['disk'] = {
                    'state': 'stale' if any(row['state'] == 'stale' for row in rows) else 'history',
                    'allocatedBytes': sum(row['allocatedBytes'] for row in rows),
                    'ageSeconds': max(instant - row['sampledAt'] for row in rows),
                    'provenance': 'Historical allocated worktree bytes; excludes node_modules',
                }
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    runtime.publish_observation(runs, observation)
    return observation


def main(argv):
    runs = os.path.expanduser('~/.ashlr-runs')
    try:
        if argv == ['tick']:
            tick(runs)
        elif len(argv) == 2 and argv[0] == 'prepare-private':
            runtime.prepare_private_phase(runs, argv[1])
        elif len(argv) == 3 and argv[0] == 'register':
            runtime.register_claim(runs, argv[1], int(argv[2]))
        else:
            return 2
    except (OSError, ValueError, TimeoutError):
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
