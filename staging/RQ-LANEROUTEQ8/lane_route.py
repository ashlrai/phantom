"""Offline dispatchd lane selection; caller persists the returned queue under its lock.

One READY job's `pool` field is its requested lane (the queue line's `pool=`
envelope). `eligible` is the dispatcher's ordered list of pools that are
policy-approved, available and unheld right now. This module never grants
pool access, billing authority, release from a hold, or a launch — it only
selects the lane a READY job claims next and makes every move explicit.

- A requested lane that is eligible is honored verbatim: the job runs on the
  pool it asked for, never silently re-ranked onto a cheaper default.
- A requested lane that is unavailable fails over to the first eligible pool
  — explicitly: `requestedPool` preserves the original request and `failover`
  records the move and its reason. With no eligible pool the job keeps its
  request and is held; it never launches on a lane that cannot serve it. When
  the original request becomes eligible again before the job is claimed, it
  is restored and the diversion is recorded the same way.
- A job the local lane serves under a declared bound of at most 100 changed
  lines (`size<=100` in envelope syntax) stays on the fast tier regardless of
  its declared tier. Larger jobs — and any job without a declared bound —
  keep the tier the line asked for.

Only READY jobs are routed. CLAIMED or RUNNING work is never re-pooled in
place (the claim owner's fencing decides what a dead claim means), and a held
or finished job is not a lane decision. Envelope fields are untrusted queue
data: a malformed bound never promotes a job to the fast tier, and no `bet=`
or `src=` value grants anything.
"""
from copy import deepcopy

LOCAL_POOL = 'local'
FAST_TIER = 'fast'
# Envelope `size<=N` is a declared upper bound; a bound of 100 lines or fewer
# is the "under 100 lines" class the local fast tier serves.
LOCAL_FAST_MAX_LINES = 100
# router-lint's EST-LINES bound; a larger declared bound is corrupt input.
MAX_DECLARED_LINES = 1_000_000
FAILOVER_REASON = 'pool-unavailable'
RESTORE_REASON = 'requested-available'


def _declared_size(job):
    """The job's declared changed-line bound, or None when absent or corrupt."""
    size = job.get('size')
    if isinstance(size, bool) or not isinstance(size, int):
        return None
    return size if 1 <= size <= MAX_DECLARED_LINES else None


def route(queue, job_id, *, eligible):
    """Select the lane one job claims next. Returns (queue, decision).

    `queue` maps job id to job record; the returned mapping is a deep copy —
    the caller's snapshot is never mutated, and the caller persists the result
    atomically under the queue lock. `eligible` is the dispatcher's ordered
    approved-pool list; its order picks the failover lane.

    decision is {'job': id, 'kind': 'requested'|'failover'|'held',
    'lane': pool|None, 'reason': str|None, 'tier': str|None,
    'restored': bool}. It is metadata for the tick log; the job record itself
    carries the durable failover markers.
    """
    result = deepcopy(queue)
    job = result[job_id]
    decision = {'job': job_id, 'kind': 'held', 'lane': None, 'reason': None,
                'tier': job.get('tier'), 'restored': False}
    if job.get('status') != 'READY':
        decision['reason'] = 'not-ready'
        return result, decision
    pools = [pool for pool in eligible if isinstance(pool, str) and pool]
    # The honored request is the original ask while a job is diverted; after
    # any failover `requestedPool` — not the current `pool` — is what eligible
    # is checked against. A corrupt marker degrades to the declared pool,
    # which still must be eligible to serve.
    requested_pool = job.get('requestedPool')
    requested = requested_pool if isinstance(requested_pool, str) and requested_pool else job.get('pool')
    if not isinstance(requested, str) or not requested:
        decision['reason'] = 'pool-undeclared'
        return result, decision
    if requested in pools:
        lane, kind = requested, 'requested'
        if requested_pool is not None:
            if job['pool'] != requested:
                # The requested lane is open again before the job was claimed:
                # restore it explicitly, the same visibility a failover gets.
                prior = job['pool'] if isinstance(job['pool'], str) and job['pool'] else 'undeclared'
                job['failover'] = {'requested': prior, 'lane': requested,
                                   'reason': RESTORE_REASON}
                job['pool'] = requested
                decision['restored'] = True
            # Diversion over (or the marker was stale): the request is served.
            del job['requestedPool']
    elif pools:
        lane = pools[0]
        kind = 'failover'
        if job.get('requestedPool') != requested:
            # First diversion preserves the original ask; a corrupt marker is
            # replaced so the real request still survives in the record.
            job['requestedPool'] = requested
        job['pool'] = lane
        job['failover'] = {'requested': requested, 'lane': lane,
                           'reason': FAILOVER_REASON}
    else:
        decision['reason'] = 'no-eligible-pool'
        return result, decision
    size = _declared_size(job)
    if lane == LOCAL_POOL and size is not None and size <= LOCAL_FAST_MAX_LINES:
        job['tier'] = FAST_TIER
    decision.update(kind=kind, lane=lane, tier=job.get('tier'))
    return result, decision
