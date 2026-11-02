#!/usr/bin/env python3
"""Fenced host lease for leader election; invoke remotely through trusted SSH.

The SQLite database lives on the coordinator's local disk, never on a network
mount. Every mutation runs inside BEGIN IMMEDIATE and all times come from the
coordinator clock. acquire grants only a free or expired lease and returns a
fencing number that rises on every change of holder; the holder must record
it because status and errors never disclose it. renew and release require the
exact holder and fencing number, and an expired holder cannot renew. When a
role names a primary, a non-primary acquire succeeds only once --grace seconds
have passed since expiry, so a brief primary restart does not flip the leader.
HOST_LEASE_CLOCK_FILE points default_clock at a file containing the current
time and exists only so tests can share a fake coordinator clock.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time

IDENTITY = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
MAX_FENCING = 2**63 - 1


def identifier(value):
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise ValueError('invalid identity')
    return value


def default_clock():
    override = os.environ.get('HOST_LEASE_CLOCK_FILE')
    if override is None:
        return time.time()
    with open(override) as handle:
        return float(handle.read())


def database(path):
    # Create private by default; existing database permissions remain the owner's responsibility.
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        os.close(fd)
    db = sqlite3.connect(path, timeout=30, isolation_level=None)
    db.execute('PRAGMA busy_timeout=30000')
    db.executescript('''
        CREATE TABLE IF NOT EXISTS leases (
            role TEXT PRIMARY KEY,
            holder TEXT,
            fencing INTEGER NOT NULL DEFAULT 0,
            expires REAL,
            primary_host TEXT,
            updated REAL NOT NULL
        );
    ''')
    return db


def run(args, clock=default_clock):
    role = identifier(args.role)
    host = identifier(args.host) if getattr(args, 'host', None) else None
    primary = identifier(args.primary) if getattr(args, 'primary', None) else None
    db = database(args.db)
    try:
        db.execute('BEGIN IMMEDIATE')
        now = clock()
        row = db.execute('SELECT holder, fencing, expires, primary_host FROM leases WHERE role=?',
                         (role,)).fetchone()
        result = {'ok': True, 'role': role, 'now': now}
        if args.action == 'status':
            if row is None:
                result.update(state='free', holder=None, expires=None, primary=None)
            else:
                holder, _, expires, stored = row
                state = 'free' if holder is None else ('held' if expires > now else 'expired')
                result.update(state=state, holder=holder, expires=expires, primary=stored)
        elif args.action == 'acquire':
            if row is None:
                expires = now + args.ttl
                db.execute('INSERT INTO leases VALUES (?, ?, 1, ?, ?, ?)',
                           (role, host, expires, primary, now))
                result.update(state='held', holder=host, fencing=1, expires=expires)
            else:
                holder, fencing, expires, stored = row
                named = stored if stored is not None else primary
                if primary is not None and stored is not None and primary != stored:
                    result.update(ok=False, error='primary mismatch', primary=stored)
                elif holder is not None and expires > now:
                    result.update(ok=False, error='lease held', holder=holder, expires=expires)
                elif (holder is not None and named is not None and host != named
                      and now < expires + args.grace):
                    result.update(ok=False, error='within primary grace', holder=holder,
                                  expires=expires, acquire_after=expires + args.grace)
                else:
                    expiry = now + args.ttl
                    db.execute('UPDATE leases SET holder=?, fencing=fencing+1, expires=?,'
                               ' primary_host=COALESCE(?, primary_host), updated=? WHERE role=?',
                               (host, expiry, primary, now, role))
                    result.update(state='held', holder=host, fencing=fencing + 1, expires=expiry)
        elif args.action == 'renew':
            if row is None or row[0] != host or row[1] != args.fencing:
                result.update(ok=False, error='not the lease holder')
            elif row[2] <= now:
                result.update(ok=False, error='lease expired')
            else:
                expires = now + args.ttl
                db.execute('UPDATE leases SET expires=?, updated=? WHERE role=?', (expires, now, role))
                result.update(state='held', holder=host, expires=expires)
        elif args.action == 'release':
            if row is None or row[0] != host or row[1] != args.fencing:
                result.update(ok=False, error='not the lease holder')
            else:
                db.execute('UPDATE leases SET holder=NULL, fencing=fencing+1, expires=NULL,'
                           ' updated=? WHERE role=?', (now, role))
                result.update(state='free', holder=None, fencing=row[1] + 1)
        db.execute('COMMIT')
        return result
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise
    finally:
        db.close()


def positive(value):
    try:
        number = int(value)
        if 1 <= number <= 86400:
            return number
    except ValueError:
        pass
    raise argparse.ArgumentTypeError('must be an integer from 1 to 86400')


def nonnegative(value):
    try:
        number = int(value)
        if 0 <= number <= 86400:
            return number
    except ValueError:
        pass
    raise argparse.ArgumentTypeError('must be an integer from 0 to 86400')


def fencing_number(value):
    try:
        number = int(value)
        if 1 <= number <= MAX_FENCING:
            return number
    except ValueError:
        pass
    raise argparse.ArgumentTypeError('must be an integer from 1 to 2**63 - 1')


def parser():
    p = argparse.ArgumentParser(description=__doc__, epilog=(
        'On the coordinator use a local disk DB, never a network mount. Example from a second host '
        'using existing SSH trust: ssh coordinator python3 /opt/phantom/scripts/mac-bridge/'
        'host_lease.py --db /var/local/phantom/lease.sqlite acquire fleet-leader --host mac2 '
        '--primary mac1. acquire returns the fencing number once; record it for renew and release.'))
    p.add_argument('--db', required=True, help='coordinator local SQLite database path')
    sub = p.add_subparsers(dest='action', required=True)
    acquire = sub.add_parser('acquire')
    acquire.add_argument('role', type=identifier)
    acquire.add_argument('--host', required=True, type=identifier)
    acquire.add_argument('--ttl', type=positive, default=30, help='lease seconds (1-86400)')
    acquire.add_argument('--primary', type=identifier, help='designated primary host for this role')
    acquire.add_argument('--grace', type=nonnegative, default=30,
                         help='seconds past expiry a non-primary must wait (0-86400)')
    renew = sub.add_parser('renew')
    renew.add_argument('role', type=identifier)
    renew.add_argument('--host', required=True, type=identifier)
    renew.add_argument('--fencing', required=True, type=fencing_number)
    renew.add_argument('--ttl', type=positive, default=30, help='lease seconds (1-86400)')
    release = sub.add_parser('release')
    release.add_argument('role', type=identifier)
    release.add_argument('--host', required=True, type=identifier)
    release.add_argument('--fencing', required=True, type=fencing_number)
    status = sub.add_parser('status')
    status.add_argument('role', type=identifier)
    return p


def main():
    args = parser().parse_args()
    try:
        result = run(args)
    except (ValueError, OSError, sqlite3.Error, OverflowError):
        result = {'ok': False, 'error': 'invalid input or coordinator failure'}
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
