#!/usr/bin/env python3
"""Single-machine SQLite coordinator; invoke remotely through trusted SSH."""

import argparse
import base64
import json
import os
import re
import secrets
import sqlite3
import sys
import time

MAX_PAYLOAD = 65536
IDENTITY = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
TOKEN = re.compile(r'[0-9a-f]{64}\Z')


def identifier(value):
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise ValueError('invalid identity')
    return value


def receipt(path):
    if path == '-':
        raw = sys.stdin.buffer.read(4097)
    else:
        with open(path, 'rb') as handle:
            raw = handle.read(4097)
    if len(raw) > 4096:
        raise ValueError('invalid receipt')
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError('invalid receipt')
    job, host, token, generation = (data.get(k) for k in ('job', 'host', 'token', 'generation'))
    identifier(job)
    identifier(host)
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError('invalid receipt')
    if type(generation) is not int or not 1 <= generation <= 2**63 - 1:
        raise ValueError('invalid receipt')
    return job, host, token, generation


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
        CREATE TABLE IF NOT EXISTS jobs (
            job TEXT PRIMARY KEY, payload BLOB NOT NULL,
            state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
            host TEXT, token TEXT, expires REAL
        );
        CREATE TABLE IF NOT EXISTS recoveries (
            job TEXT NOT NULL, old_generation INTEGER NOT NULL,
            recovered_at REAL NOT NULL, PRIMARY KEY (job, old_generation)
        );
    ''')
    return db


def run(args):
    job = identifier(args.job) if hasattr(args, 'job') else None
    host = identifier(args.host) if hasattr(args, 'host') else None
    payload = None
    if args.action == 'enqueue':
        with open(args.payload, 'rb') as handle:
            payload = handle.read(MAX_PAYLOAD + 1)
        if not payload or len(payload) > MAX_PAYLOAD:
            raise ValueError('payload must contain 1 to 65536 bytes')
    current = receipt(args.receipt) if hasattr(args, 'receipt') else None
    db = database(args.db)
    try:
        db.execute('BEGIN IMMEDIATE')
        now = time.time()
        # Expiry is irreversible without explicit recovery, including when a receipt is stale.
        db.execute("UPDATE jobs SET state='uncertain' WHERE state='claimed' AND expires <= ?", (now,))
        result = {'ok': True}
        if args.action == 'enqueue':
            try:
                db.execute("INSERT INTO jobs (job, payload, state) VALUES (?, ?, 'queued')", (job, payload))
            except sqlite3.IntegrityError:
                result = {'ok': False, 'error': 'job already exists'}
        elif args.action == 'claim':
            row = db.execute("SELECT job, payload, generation FROM jobs WHERE state='queued' ORDER BY rowid LIMIT 1").fetchone()
            if row is None:
                result['claim'] = None
            else:
                job, payload, generation = row
                generation += 1
                token = secrets.token_hex(32)
                expires = now + args.ttl
                db.execute("UPDATE jobs SET state='claimed', host=?, token=?, generation=?, expires=? WHERE job=?",
                           (host, token, generation, expires, job))
                result['claim'] = {'job': job, 'host': host, 'token': token, 'generation': generation,
                                   'expires': expires, 'payload_base64': base64.b64encode(payload).decode('ascii')}
        elif args.action in ('renew', 'complete', 'release'):
            job, host, token, generation = current
            row = db.execute("SELECT 1 FROM jobs WHERE job=? AND host=? AND token=? AND generation=? AND state='claimed' AND expires>?",
                             (job, host, token, generation, now)).fetchone()
            if not row:
                result = {'ok': False, 'error': 'receipt is not current'}
            elif args.action == 'renew':
                expires = now + args.ttl
                db.execute('UPDATE jobs SET expires=? WHERE job=?', (expires, job))
                result['expires'] = expires
            else:
                state = 'completed' if args.action == 'complete' else 'queued'
                db.execute('UPDATE jobs SET state=?, host=NULL, token=NULL, expires=NULL WHERE job=?', (state, job))
        elif args.action == 'recover':
            row = db.execute("SELECT 1 FROM jobs WHERE job=? AND state='uncertain' AND generation=?",
                             (job, args.generation)).fetchone()
            if not row:
                result = {'ok': False, 'error': 'uncertain generation not found'}
            else:
                db.execute('INSERT INTO recoveries VALUES (?, ?, ?)', (job, args.generation, now))
                db.execute("UPDATE jobs SET state='queued', host=NULL, token=NULL, expires=NULL WHERE job=?", (job,))
        elif args.action == 'status':
            row = db.execute('SELECT state, generation, host, expires FROM jobs WHERE job=?', (job,)).fetchone()
            if row is None:
                result = {'ok': False, 'error': 'job not found'}
            else:
                result.update(zip(('state', 'generation', 'host', 'expires'), row))
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


def parser():
    p = argparse.ArgumentParser(description=__doc__, epilog=(
        'On the coordinator use a local disk DB. Example from a second host using existing SSH trust: '
        'ssh coordinator python3 /opt/phantom/scripts/mac-bridge/host_queue.py '
        '--db /var/local/phantom/queue.sqlite claim --host mac2'))
    p.add_argument('--db', required=True, help='coordinator local SQLite database path')
    sub = p.add_subparsers(dest='action', required=True)
    enqueue = sub.add_parser('enqueue')
    enqueue.add_argument('job')
    enqueue.add_argument('payload', help='opaque local file, 1-65536 bytes')
    claim = sub.add_parser('claim')
    claim.add_argument('--host', required=True)
    claim.add_argument('--ttl', type=positive, default=300, help='lease seconds (1-86400)')
    for name in ('renew', 'complete', 'release'):
        command = sub.add_parser(name)
        command.add_argument('--receipt', required=True, help='claim JSON object file, or - for stdin')
        if name == 'renew':
            command.add_argument('--ttl', type=positive, default=300)
        if name == 'release':
            command.add_argument('--assert-stopped', action='store_true', required=True,
                                 help='assert execution has stopped before requeue')
    recover = sub.add_parser('recover')
    recover.add_argument('job')
    recover.add_argument('--generation', type=int, required=True)
    recover.add_argument('--assert-safe', action='store_true', required=True,
                         help='assert prior execution is stopped and re-execution is safe')
    status = sub.add_parser('status')
    status.add_argument('job')
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
