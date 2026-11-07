#!/usr/bin/env python3
"""One bounded JSON queue request on stdin, one bounded JSON response on stdout."""

import argparse
import base64
import binascii
import json
import os
import sqlite3
import sys
import tempfile
from types import SimpleNamespace

import host_queue

# Requests fit a maximum-size base64 payload inside a small JSON envelope.
MAX_REQUEST = MAX_RESPONSE = 96 * 1024
RECEIPT_KEYS = frozenset(('job', 'host', 'token', 'generation'))
FIELDS = {
    'enqueue': (frozenset(('job', 'payload_base64')), frozenset()),
    'claim': (frozenset(('host',)), frozenset(('ttl',))),
    'renew': (frozenset(('receipt',)), frozenset(('ttl',))),
    'complete': (frozenset(('receipt',)), frozenset()),
    'release': (frozenset(('receipt', 'assert-stopped')), frozenset()),
    'status': (frozenset(('job',)), frozenset()),
}


class Reject(Exception):
    """A request violation; the message is a static string with no input data."""


def ttl(request):
    value = request.get('ttl', 300)
    if type(value) is not int or not 1 <= value <= 86400:
        raise Reject('invalid request fields')
    return value


def receipt(value):
    if not isinstance(value, dict) or set(value) != RECEIPT_KEYS:
        raise Reject('invalid receipt')
    try:
        job = host_queue.identifier(value['job'])
        host = host_queue.identifier(value['host'])
    except ValueError:
        raise Reject('invalid receipt')
    token, generation = value['token'], value['generation']
    if not isinstance(token, str) or not host_queue.TOKEN.fullmatch(token):
        raise Reject('invalid receipt')
    if type(generation) is not int or not 1 <= generation <= 2**63 - 1:
        raise Reject('invalid receipt')
    return {'job': job, 'host': host, 'token': token, 'generation': generation}


def private_file(directory, name, data):
    path = os.path.join(directory, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(data)
    return path


def payload_file(directory, encoded):
    if not isinstance(encoded, str):
        raise Reject('invalid payload')
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise Reject('invalid payload')
    if not data or len(data) > host_queue.MAX_PAYLOAD:
        raise Reject('invalid payload')
    return private_file(directory, 'payload', data)


def translate(request, directory):
    # Map a validated request to run() attributes without mutating state.
    action = request.get('action')
    if not isinstance(action, str) or action not in FIELDS:
        raise Reject('unsupported action')
    required, optional = FIELDS[action]
    keys = set(request) - {'action'}
    if not required <= keys <= required | optional:
        raise Reject('invalid request fields')
    fields = {'action': action}
    for name in ('job', 'host'):
        if name in keys:
            try:
                fields[name] = host_queue.identifier(request[name])
            except ValueError:
                raise Reject('invalid request fields')
    if 'ttl' in optional:
        fields['ttl'] = ttl(request)
    if action == 'release' and request['assert-stopped'] is not True:
        raise Reject('invalid request fields')
    if action == 'enqueue':
        fields['payload'] = payload_file(directory, request['payload_base64'])
    if action in ('renew', 'complete', 'release'):
        data = json.dumps(receipt(request['receipt']), separators=(',', ':')).encode()
        fields['receipt'] = private_file(directory, 'receipt', data)
        if action == 'release':
            fields['assert_stopped'] = True
    return fields


def process(db):
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise Reject('request exceeds size limit')
    try:
        request = json.loads(raw)
    except (ValueError, RecursionError):
        raise Reject('request is not valid JSON')
    if not isinstance(request, dict):
        raise Reject('request is not a JSON object')
    with tempfile.TemporaryDirectory(prefix='host-queue-stdio-') as private:
        fields = translate(request, private)
        try:
            return host_queue.run(SimpleNamespace(db=db, **fields))
        except (ValueError, OSError, sqlite3.Error, OverflowError):
            raise Reject('invalid input or coordinator failure')


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        'Request: {"action": ...} plus its fields: enqueue job+payload_base64 (1-65536 '
        'decoded bytes); claim host+ttl?; renew/complete/release receipt={job,host,token,'
        'generation} (release adds "assert-stopped":true); status job. Invoke through '
        'already trusted transport such as ssh; this opens no socket and adds no auth.'))
    parser.add_argument('--db', required=True, help='coordinator local SQLite database path')
    args = parser.parse_args()
    try:
        result = process(args.db)
    except Reject as rejection:
        result = {'ok': False, 'error': str(rejection)}
    except Exception:
        # Diagnostics never carry request bytes, payload, or receipt material.
        result = {'ok': False, 'error': 'invalid input or coordinator failure'}
    encoded = json.dumps(result, separators=(',', ':'))
    if len(encoded) > MAX_RESPONSE:
        result = {'ok': False, 'error': 'response exceeds limit'}
        encoded = json.dumps(result, separators=(',', ':'))
    print(encoded, flush=True)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
