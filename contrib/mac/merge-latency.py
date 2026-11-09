#!/usr/bin/env python3
"""Merge queue latency report from the job outcome ledger (metrics/jobs.jsonl).

Latency is the time from a job's PUBLISHED record to its MERGED record. Jobs with
no MERGED/CLOSED record yet are "queued". Read-only: never writes the ledger,
never calls GitHub (run `metrics-outcomes reconcile` first for fresh outcomes).
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import re
import sys

PERCENTILES = (50, 90, 95)


def parse_ts(value):
    """Aware datetime from an ISO-8601 string, else None (naive or unparseable)."""
    if not isinstance(value, str):
        return None
    text = re.sub(r'([+-]\d\d)(\d\d)\Z', r'\1:\2', value.strip().replace('Z', '+00:00'))
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def load(path):
    """Ledger rows; blank, malformed and non-object lines are skipped and counted."""
    rows, skipped = [], 0
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            row = None
        if isinstance(row, dict):
            rows.append(row)
        else:
            skipped += 1
    return rows, skipped


def percentile(sorted_values, pct):
    """Nearest-rank percentile of an ascending list; None when empty."""
    if not sorted_values:
        return None
    return sorted_values[max(1, math.ceil(pct / 100 * len(sorted_values))) - 1]


def stats(seconds):
    values = sorted(seconds)
    out = {'count': len(values)}
    for pct in PERCENTILES:
        out[f'p{pct}'] = percentile(values, pct)
    out['max'] = values[-1] if values else None
    return out


def key(row):
    job = row.get('jobId', row.get('job', row.get('id')))
    url = row.get('prUrl', row.get('pr'))
    if not isinstance(job, str) or not job:
        return None
    return job, url.rstrip('/') if isinstance(url, str) else None


def report(rows, now, since=None):
    """Summarize merge latency; `since` drops publications older than that instant."""
    published, outcomes, invalid = {}, {}, 0
    for row in rows:
        state = row.get('outcome', row.get('status'))
        if state not in ('PUBLISHED', 'MERGED', 'CLOSED'):
            continue
        ident, ts = key(row), parse_ts(row.get('ts'))
        if ident is None or ts is None:
            invalid += 1
            continue
        if state == 'PUBLISHED':
            # Earliest publication wins; a re-published PR keeps its original queue entry.
            if ident not in published or ts < published[ident][0]:
                published[ident] = (ts, row.get('pool'))
        else:
            seen = outcomes.setdefault(ident, {})
            seen[state] = min(ts, seen.get(state, ts))
    merged, closed, queued, per_pool = [], 0, [], {}
    for ident, (start, pool) in published.items():
        if since and start < since:
            continue
        done = outcomes.get(ident, {})
        if 'MERGED' in done:
            seconds = (done['MERGED'] - start).total_seconds()
            if seconds < 0:
                invalid += 1  # merge recorded before publication: clock skew or bad data
                continue
            merged.append(seconds)
            per_pool.setdefault(pool or 'unknown', []).append(seconds)
        elif 'CLOSED' in done:
            closed += 1
        else:
            queued.append(max(0.0, (now - start).total_seconds()))
    return {
        'generatedAt': now.isoformat(),
        'merged': stats(merged),
        'closed': closed,
        'queued': {'count': len(queued), 'oldestAgeSeconds': max(queued) if queued else None},
        'missingOrInvalid': invalid,
        'byPool': {pool: stats(values) for pool, values in sorted(per_pool.items())},
    }


def human(seconds):
    if seconds is None:
        return '-'
    seconds = int(seconds)
    return (f'{seconds // 3600}h{seconds % 3600 // 60:02d}m' if seconds >= 3600
            else f'{seconds // 60}m{seconds % 60:02d}s')


def render(result):
    m, q = result['merged'], result['queued']
    lines = [f"merged {m['count']}  " + '  '.join(f"p{p} {human(m[f'p{p}'])}" for p in PERCENTILES)
             + f"  max {human(m['max'])}",
             f"queued {q['count']}  oldest {human(q['oldestAgeSeconds'])}",
             f"closed {result['closed']}  missing/invalid timestamps {result['missingOrInvalid']}"]
    lines += [f"  {pool}: {s['count']} merged  p50 {human(s['p50'])}  p95 {human(s['p95'])}"
              for pool, s in result['byPool'].items()]
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs', type=Path, help='ledger path (default ~/.ashlr-runs/metrics/jobs.jsonl)')
    parser.add_argument('--since-hours', type=float, help='only jobs published in the last N hours')
    parser.add_argument('--now', help='ISO-8601 instant to measure queue age from (default: now)')
    parser.add_argument('--json', action='store_true', help='print machine-readable JSON')
    args = parser.parse_args(argv)
    now = parse_ts(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        print('--now needs a timezone-aware ISO-8601 instant', file=sys.stderr)
        return 2
    path = args.jobs or Path(os.path.expanduser('~/.ashlr-runs/metrics/jobs.jsonl'))
    try:
        rows, skipped = load(path)
    except OSError:
        print('Cannot read ledger', file=sys.stderr)
        return 1
    since = now - timedelta(hours=args.since_hours) if args.since_hours is not None else None
    result = report(rows, now, since)
    result['malformedLines'] = skipped
    print(json.dumps(result, sort_keys=True) if args.json else render(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
