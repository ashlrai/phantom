#!/usr/bin/env python3
"""Read-only verdict: could the standby take over now, and how much is lost?

Answers the second-computer failover question for one role: the lease database
is opened read-only (SQLite mode=ro) so the holder and expiry are observed
without acquiring, renewing or releasing anything, and the newest snapshot
generation is proven through latest_failover.read_pointer and
latest_failover.verified -- complete, verified, and matching latest.json.
Nothing is written, restored or started: no store writes, no restores, no
processes. Prints one JSON object and exits 0 whether or not the standby is
ready; argparse exits 2 on bad arguments. A missing input is a blocker, never
a crash. Blocker strings are stable: no-lease-db, primary-mismatch,
no-snapshot, snapshot-unverified, snapshot-incomplete, snapshot-stale,
snapshot-age-unknown.
"""

import argparse
import json
import math
from pathlib import Path
import sqlite3
import sys

import host_lease
import latest_failover
import leader_failover
import state_snapshot

TOOL = 'standby_readiness'
DEFAULT_MAX_AGE = 900  # seconds; takeover loses at most this much work


def probe_lease(db_arg, role, primary, now, blockers):
    """(holder, expiresInSec) for role; never opens the database for writing."""
    try:
        if not Path(db_arg).is_file():
            raise LookupError('missing')
        db = sqlite3.connect(Path(db_arg).resolve().as_uri() + '?mode=ro',
                             uri=True)
        try:
            row = db.execute('SELECT holder, expires, primary_host FROM leases'
                             ' WHERE role=?', (role,)).fetchone()
        finally:
            db.close()
    except (LookupError, OSError, sqlite3.Error):
        blockers.append('no-lease-db')
        return None, None
    if row is None:
        return None, None
    holder, expires, stored_primary = row
    # A stored primary differing from --primary fails every future acquire.
    if stored_primary is not None and stored_primary != primary:
        blockers.append('primary-mismatch')
    if holder is None or not isinstance(expires, (int, float)) \
            or isinstance(expires, bool) or not math.isfinite(expires):
        return holder, None
    return holder, expires - now


def probe_snapshot(store_arg, now, max_age, blockers):
    """(generation, snapshotAgeSec) for the verified latest.json selection."""
    store = Path(store_arg)
    if store.is_symlink() or not store.is_dir():
        blockers.append('no-snapshot')
        return None, None
    store = store.resolve()
    try:
        name, digest = latest_failover.read_pointer(store)
    except latest_failover.SelectionError:
        blockers.append('no-snapshot')
        return None, None
    directory = (store / name).resolve()
    if not state_snapshot.inside(directory, store):
        blockers.append('snapshot-unverified')
        return name, None
    check = state_snapshot.verify_snapshot(directory)
    if not check['ok']:
        # A generation latest.json names but the store lacks is no snapshot;
        # anything else failed integrity and is unverified.
        blockers.append('no-snapshot' if not directory.is_dir()
                        else 'snapshot-unverified')
        return name, None
    if check['manifest'].get('skipped'):
        blockers.append('snapshot-incomplete')
        return name, None
    try:
        # The authoritative complete-and-matches-latest.json proof.
        latest_failover.verified(directory, digest)
    except latest_failover.SelectionError:
        blockers.append('snapshot-unverified')
        return name, None
    created = check['manifest'].get('created')
    if not isinstance(created, (int, float)) or isinstance(created, bool) \
            or not math.isfinite(created):
        blockers.append('snapshot-age-unknown')
        return name, None
    age = max(0.0, now - created)
    if age > max_age:
        blockers.append('snapshot-stale')
    return name, age


def evaluate(args, clock=host_lease.default_clock):
    """The readiness report; clock defaults to the coordinator clock."""
    now = clock()
    blockers = []
    holder, expires_in = probe_lease(args.db, args.role, args.primary, now,
                                   blockers)
    generation, age = probe_snapshot(args.snapshot_store, now, args.max_age,
                                     blockers)
    return {
        'version': 1,
        'tool': TOOL,
        'ready': not blockers,
        'blockers': blockers,
        'leaseHolder': holder,
        'leaseExpiresInSec': None if expires_in is None else round(expires_in),
        'generation': generation,
        'snapshotAgeSec': None if age is None else round(age),
        # The work lost if takeover happened now; null is never a guess.
        'wouldLoseSec': None if age is None else round(age),
    }


def build_parser():
    p = argparse.ArgumentParser(
        description=__doc__,
        epilog='Strictly read-only: the standby takes over through '
               'leader_failover/latest_failover; this tool only reports.')
    p.add_argument('--db', required=True,
                   help='coordinator lease database, opened read-only')
    p.add_argument('--snapshot-store', required=True, type=Path,
                   help='existing snapshot_publish destination directory')
    p.add_argument('--primary', required=True, type=host_lease.identifier,
                   help='designated primary host for the role')
    p.add_argument('--role', required=True, type=host_lease.identifier)
    p.add_argument('--host', required=True, type=host_lease.identifier,
                   help='standby host this verdict answers for')
    p.add_argument('--max-age', type=leader_failover.bounded(60, 86400),
                   default=DEFAULT_MAX_AGE, metavar='SECONDS',
                   help='newest snapshot may be at most this old '
                        '(60-86400, default 900)')
    return p


def main(argv=None, clock=host_lease.default_clock):
    args = build_parser().parse_args(argv)
    print(json.dumps(evaluate(args, clock), separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
