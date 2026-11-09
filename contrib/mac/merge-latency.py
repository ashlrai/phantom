#!/usr/bin/env python3
"""Offline merge latency evidence. No network, writes, or merge authority."""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo else None
    except (ValueError, AttributeError, TypeError):
        return None


def analyze(rows: list, now: float, stale_seconds: float = 86400) -> dict:
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
    durations, jobs, candidates, blocking = [], [], [], {}
    for job, events in sorted(groups.items()):
        def state(r):
            return str(r.get('state', r.get('outcome', r.get('status', r.get('event', ''))))).upper()
        def at(r):
            field = 'mergedAt' if state(r) == 'MERGED' else 'closedAt' if state(r) == 'CLOSED' else 'ts'
            return timestamp(r.get(field, r.get('ts', r.get('timestamp', r.get('at')))))
        queues = [at(r) for r in events if state(r) == 'QUEUED' or r.get('event') == 'queued']
        merges = [at(r) for r in events if state(r) == 'MERGED']
        terminal = {state(r) for r in events} & {'MERGED', 'CLOSED', 'FAILED', 'CANCELLED'}
        urls = sorted({r.get('prUrl', r.get('url', r.get('pr'))) for r in events
                       if isinstance(r.get('prUrl', r.get('url', r.get('pr'))), str)})
        conflict = len(terminal) > 1 or len(urls) > 1
        seconds = None
        issue = None
        if conflict:
            issue = 'conflicting_outcomes_or_prs'
        elif len(queues) != 1 or len(merges) != 1:
            issue = 'missing_or_ambiguous_boundaries'
        elif queues[0] is None or merges[0] is None:
            issue = 'missing_timestamp'
        elif not queues[0] <= merges[0] <= now:
            issue = 'reversed_or_future_timestamp'
        else:
            seconds = merges[0] - queues[0]
            durations.append(seconds)
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
        jobs.append({'job': job, 'queueToMergeSeconds': seconds, 'unmeasuredReason': issue})
    durations.sort()
    return {'schemaVersion': 'merge-latency.v1', 'measured': len(durations),
            'queueToMergeSeconds': {f'p{p}': durations[max(0, math.ceil(len(durations)*p/100)-1)]
                                    if durations else None for p in (50, 90, 95, 99)},
            'blockingSeconds': dict(sorted(blocking.items())), 'candidates': candidates,
            'jobs': jobs, 'duplicates': duplicates, 'invalidRows': invalid}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jobs', required=True, type=Path)
    parser.add_argument('--now', default=datetime.now(timezone.utc).isoformat())
    parser.add_argument('--stale-hours', type=float, default=24)
    args = parser.parse_args()
    now = timestamp(args.now)
    if now is None or not math.isfinite(args.stale_hours) or args.stale_hours < 0:
        parser.error('use a timezone-aware --now and nonnegative finite --stale-hours')
    try:
        rows = [json.loads(line) for line in args.jobs.read_text().splitlines() if line.strip()]
    except (OSError, ValueError):
        parser.exit(2, 'Cannot read jobs JSONL; no report produced.\n')
    print(json.dumps(analyze(rows, now, args.stale_hours * 3600), sort_keys=True, allow_nan=False))


if __name__ == '__main__':
    main()
