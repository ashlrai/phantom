#!/usr/bin/env python3
"""Offline merge latency evidence. No network, writes, or merge authority."""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re

PERCENTILES = (50, 90, 95, 99)


def timestamp(value):
    try:
        # Colonless offsets (+0000) predate fromisoformat's widening on 3.11.
        text = re.sub(r'([+-]\d\d)(\d\d)\Z', r'\1:\2', value.strip().replace('Z', '+00:00'))
        parsed = datetime.fromisoformat(text)
        return parsed.timestamp() if parsed.tzinfo else None
    except (ValueError, AttributeError, TypeError):
        return None


def measure(starts, merges, now):
    """(seconds, issue) between one start boundary and one merge boundary."""
    if len(starts) != 1 or len(merges) != 1:
        return None, 'missing_or_ambiguous_boundaries'
    if starts[0] is None or merges[0] is None:
        return None, 'missing_timestamp'
    if not starts[0] <= merges[0] <= now:
        return None, 'reversed_or_future_timestamp'
    return merges[0] - starts[0], None


def percentiles(durations):
    durations = sorted(durations)
    return {f'p{p}': durations[max(0, math.ceil(len(durations) * p / 100) - 1)]
            if durations else None for p in PERCENTILES}


def analyze(rows: list, now: float, stale_seconds: float = 86400, since=None) -> dict:
    groups, seen = {}, set()
    duplicates = invalid = 0
    for row in rows:
        if not isinstance(row, dict):
            invalid += 1
            continue
        key = json.dumps(row, sort_keys=True)
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        job = row.get('jobId', row.get('job', row.get('job_id')))
        if not isinstance(job, str) or not job:
            invalid += 1
            continue
        groups.setdefault(job, []).append(row)
    durations, pub_durations, queued_ages = [], [], []
    jobs, candidates, per_pool = [], [], {}
    blocking = {}
    closed = 0
    for job, events in sorted(groups.items()):
        def state(r):
            return str(r.get('state', r.get('outcome', r.get('status', r.get('event', ''))))).upper()
        def at(r):
            field = 'mergedAt' if state(r) == 'MERGED' else 'closedAt' if state(r) == 'CLOSED' else 'ts'
            return timestamp(r.get(field, r.get('ts', r.get('timestamp', r.get('at')))))
        queues = [at(r) for r in events if state(r) == 'QUEUED' or r.get('event') == 'queued']
        pubs = [at(r) for r in events if state(r) == 'PUBLISHED' or r.get('event') == 'published']
        merges = [at(r) for r in events if state(r) == 'MERGED']
        terminal = {state(r) for r in events} & {'MERGED', 'CLOSED', 'FAILED', 'CANCELLED'}
        urls = sorted({r.get('prUrl', r.get('url', r.get('pr'))) for r in events
                       if isinstance(r.get('prUrl', r.get('url', r.get('pr'))), str)})
        conflict = len(terminal) > 1 or len(urls) > 1
        pool = next((r['pool'] for r in events if isinstance(r.get('pool'), str) and r['pool']), None)
        start_bounds = [t for t in queues + pubs if t is not None]
        if since is not None and (not start_bounds or min(start_bounds) < since):
            continue
        if start_bounds and not terminal:
            queued_ages.append(max(0.0, now - min(start_bounds)))
        elif 'CLOSED' in terminal and 'MERGED' not in terminal:
            closed += 1
        if conflict:
            seconds = pub_seconds = None
            issue = pub_issue = 'conflicting_outcomes_or_prs'
        else:
            seconds, issue = measure(queues, merges, now)
            pub_seconds, pub_issue = measure(pubs, merges, now)
        if seconds is not None:
            durations.append(seconds)
            per_pool.setdefault(pool or 'unknown', []).append(seconds)
        if pub_seconds is not None:
            pub_durations.append(pub_seconds)
        timed = sorted((at(r), json.dumps(r, sort_keys=True), r) for r in events if at(r) is not None and at(r) <= now)
        # Equal-time differing observations cannot establish a blocking interval.
        for index, (start, _, row) in enumerate(timed):
            end = timed[index + 1][0] if index + 1 < len(timed) else now
            reason = row.get('blockingReason', row.get('blocking_reason', row.get('reason')))
            if (state(row) in {'BLOCKED', 'HELD'} and isinstance(reason, str)
                    and not conflict and end > start
                    and not (index and timed[index - 1][0] == start)
                    and not (index == len(timed) - 1 and terminal)):
                blocking[reason] = blocking.get(reason, 0) + end - start
        latest = timed[-1][0] if timed else None
        stale = not terminal and latest is not None and now - latest >= stale_seconds
        merge_conflict = bool(timed and timed[-1][2].get('mergeable') == 'CONFLICTING')
        if urls and (stale or conflict or (merge_conflict and not terminal)):
            candidates.append({'job': job, 'prs': urls, 'stale': stale,
                               'conflicting': conflict or merge_conflict})
        jobs.append({'job': job, 'queueToMergeSeconds': seconds, 'unmeasuredReason': issue,
                     'publishedToMergeSeconds': pub_seconds, 'publishedUnmeasuredReason': pub_issue})
    durations.sort()
    return {'schemaVersion': 'merge-latency.v1', 'measured': len(durations),
            'queueToMergeSeconds': percentiles(durations),
            'publishedMeasured': len(pub_durations),
            'publishedToMergeSeconds': percentiles(pub_durations),
            'queued': {'count': len(queued_ages),
                       'oldestAgeSeconds': max(queued_ages) if queued_ages else None},
            'closed': closed, 'byPool': {pool: {'count': len(values), **percentiles(values)}
                                       for pool, values in sorted(per_pool.items())},
            'generatedAt': datetime.fromtimestamp(now, timezone.utc).isoformat(),
            'blockingSeconds': dict(sorted(blocking.items())), 'candidates': candidates,
            'jobs': jobs, 'duplicates': duplicates, 'invalidRows': invalid}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs', type=Path,
                        default=Path.home() / '.ashlr-runs/metrics/jobs.jsonl',
                        help='ledger path (default ~/.ashlr-runs/metrics/jobs.jsonl)')
    parser.add_argument('--now', default=datetime.now(timezone.utc).isoformat())
    parser.add_argument('--stale-hours', type=float, default=24)
    parser.add_argument('--since-hours', type=float,
                        help='only jobs whose earliest queue/publish boundary is in the last N hours')
    args = parser.parse_args()
    now = timestamp(args.now)
    window = args.since_hours
    if (now is None or not math.isfinite(args.stale_hours) or args.stale_hours < 0
            or (window is not None and (not math.isfinite(window) or window < 0))):
        parser.error('use a timezone-aware --now and nonnegative finite --stale-hours/--since-hours')
    try:
        rows = [json.loads(line) for line in args.jobs.read_text().splitlines() if line.strip()]
    except (OSError, ValueError):
        parser.exit(2, 'Cannot read jobs JSONL; no report produced.\n')
    since = now - window * 3600 if window is not None else None
    print(json.dumps(analyze(rows, now, args.stale_hours * 3600, since), sort_keys=True, allow_nan=False))


if __name__ == '__main__':
    main()
