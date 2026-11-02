#!/usr/bin/env python3
"""Supervised bridge launch: admission shims plus pressure pause/resume.

`with-memory.sh --supervise` routes here instead of the legacy wrap-only path.
pressure_worker owns the child process group and drives pause/resume from
metrics; the child it spawns is `memory_admission.py wrap`, which installs the
heavy-command admission shims and execs the real launcher in place. The
launcher therefore is the supervised group leader — no intermediate wrapper is
signalled — and it holds no reservation itself: reservations are still taken
per heavy shim step from inside that group.
"""

import argparse
import math
from pathlib import Path
import subprocess
import sys

import memory_admission
import pressure_worker

ADMISSION = Path(memory_admission.__file__).resolve()


def supervised_command(command, state_dir, pause_file, job):
    """Argv pressure_worker spawns: wrap installs shims, then execs command."""
    return [sys.executable, str(ADMISSION), 'wrap',
            '--state-dir', str(state_dir), '--pause-file', str(pause_file),
            '--job', job, '--', *command]


def main(argv=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    state_dir, pause_file = memory_admission.defaults()
    parser = argparse.ArgumentParser(description=__doc__)
    # Routing marker set by with-memory.sh; harmless on direct invocation.
    parser.add_argument('--supervise', action='store_true')
    parser.add_argument('--job', default='heavy')
    parser.add_argument('--state-dir', type=Path, default=state_dir)
    parser.add_argument('--pause-file', type=Path, default=pause_file)
    parser.add_argument('--metrics', type=Path, required=True,
                        help='memguard metrics JSON (e.g. ~/.ashlr-runs/memguard.json)')
    parser.add_argument('--max-age-seconds', type=float, required=True,
                        help='metrics older than this count as unavailable')
    parser.add_argument('--receipt-dir', type=Path,
                        default=Path('~/.ashlr-runs/pressure-workers').expanduser())
    parser.add_argument('--poll-seconds', type=float, default=pressure_worker.POLL_SECONDS)
    parser.add_argument('--healthy-samples', type=int, default=pressure_worker.HEALTHY_SAMPLES,
                        help='consecutive healthy samples before launch/resume')
    parser.add_argument('--launch-wait-seconds', type=float,
                        default=pressure_worker.LAUNCH_WAIT_SECONDS)
    parser.add_argument('--deadline-seconds', type=float, default=None,
                        help='optional caller deadline over launch wait plus runtime')
    parser.add_argument('--term-grace-seconds', type=float,
                        default=pressure_worker.TERM_GRACE_SECONDS)
    # Split at -- so child options are never interpreted or echoed by argparse.
    divider = raw.index('--') if '--' in raw else len(raw)
    args = parser.parse_args(raw[:divider])
    command = raw[divider + 1:]
    if not command:
        parser.error('a command after -- is required')
    timings = [args.max_age_seconds, args.poll_seconds, args.launch_wait_seconds,
               args.term_grace_seconds]
    if args.deadline_seconds is not None:
        timings.append(args.deadline_seconds)
    if (any(not math.isfinite(v) or v <= 0 for v in timings) or
            args.healthy_samples < 1 or not memory_admission.IDENTIFIER.fullmatch(args.job)):
        raise ValueError('invalid timing, sample or job configuration')
    return pressure_worker.run(
        supervised_command(command, args.state_dir.absolute(),
                           args.pause_file.absolute(), args.job),
        args.metrics, args.max_age_seconds, args.receipt_dir,
        poll=args.poll_seconds, healthy_samples=args.healthy_samples,
        launch_wait=args.launch_wait_seconds, deadline=args.deadline_seconds,
        term_grace=args.term_grace_seconds)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError):
        # Exceptions can include argv or arbitrary filesystem contents.
        print('memory-supervised: invalid configuration or unavailable host telemetry',
              file=sys.stderr)
        sys.exit(70)
