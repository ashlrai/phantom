"""Offline dispatchd transition; caller persists the returned queue under its lock.

Never launches providers or appends a replacement job. Attempt receipts are opaque
IDs assigned durably before launch. Evidence must come from the supervisor, not
from provider output. Unknown or partially completed work requires reconciliation.
"""
from copy import deepcopy

MAX_ATTEMPTS = 3


def recover(queue, job_id, receipt, *, precheck=None, reason='', exit_code=None,
            empty=False, pristine=False, stopped=False, eligible=()):
    """Return (queue, classification). No mutation on replay or stale receipts.

    eligible is the dispatcher's current policy/readiness-approved pool list;
    this module cannot grant pool access, billing authority, or bypass holds.
    """
    result = deepcopy(queue)
    job = result[job_id]
    if job['status'] != 'RUNNING' or job['receipt'] != receipt:
        return result, 'stale'
    attempts = job['attempts']
    if not isinstance(attempts, int) or isinstance(attempts, bool) or not 1 <= attempts <= MAX_ATTEMPTS:
        raise ValueError('invalid attempt count')
    # Prechecks execute before any worker. UNSURE must remain visible, never DONE.
    if precheck is not None:
        if precheck in (10, 11) or (precheck == 12 and reason.startswith('id_open_pr_')):
            job['status'] = 'DONE'
            kind = 'already-handled'
        else:
            job['status'] = 'BLOCKED'
            kind = 'acceptance-unproven' if precheck == 13 else 'precheck-unavailable'
    else:
        # An empty patch alone is not proof that a worker did nothing. Require
        # confirmed process termination, pristine worktree and no published PR.
        retryable = stopped and pristine and empty and exit_code == 1
        kind = 'empty-worker' if retryable and job['pool'] == 'claude' else 'worker-failure'
        tried = job.get('triedPools', [])
        candidates = [pool for pool in eligible if pool not in [*tried, job['pool']]]
        if kind == 'empty-worker' and attempts < MAX_ATTEMPTS and candidates:
            job['triedPools'] = [*tried, job['pool']]
            job['pool'] = candidates[0]
            job['status'] = 'READY'
        else:
            job['status'] = 'BLOCKED'
    job['recovery'] = {'receipt': receipt, 'classification': kind}
    return result, kind


def claim(queue, job_id, receipt):
    """Reserve the same job once, under the dispatcher's queue lock, before launch."""
    result = deepcopy(queue)
    job = result[job_id]
    if job['status'] != 'READY':
        return result
    if not receipt or receipt == job.get('receipt'):
        raise ValueError('a fresh attempt receipt is required')
    attempts = job['attempts']
    if attempts >= MAX_ATTEMPTS:
        job['status'] = 'BLOCKED'
        return result
    job.update(status='RUNNING', receipt=receipt, attempts=attempts + 1)
    return result
