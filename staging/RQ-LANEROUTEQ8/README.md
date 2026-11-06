# RQ-LANEROUTEQ8 lane-selection handoff

This is a staged integration for the external router queue dispatcher,
following `staging/RQ-DUPMATCHFIXQ7` and the sibling `RQ-LANERECOVERQ8`
handoff. It is not installed or activated by this repository. `dispatchd.py`
and its authoritative queue writer are absent from this checkout; the fix is
delivered as a pure transition module plus its regression suite for Masbot to
adapt under the real queue lock. No provider is invoked and no queue is
written here.

## Diagnosis

Queue lines carry a requested lane and tier in the envelope
(`pool=`, `tier=`, `size<=N`, `bet=`, `src=`). Leader-emitted bets — the
`RQ-BET-*` family and `src=leader` lines — were the jobs whose lane request
was not being honored: a line asking for an eligible pool could be re-ranked
onto another, and a line asking for an unavailable pool moved pools with no
durable record of what was asked or why it moved. Small local work also lost
its fast-tier classification whenever a line declared a heavier `tier=` than
the local fast lane serves.

The corrected contract this module implements:

- **Requested eligible lanes are honored.** A READY job whose declared `pool`
  is in the dispatcher's eligible set claims that pool — never a preferred
  default. Eligibility order only chooses a failover lane, never overrides a
  served request.
- **Unavailable lanes fail over explicitly.** When the requested pool is not
  eligible, the job moves to the first eligible pool and the move is written
  on the job: `requestedPool` preserves the original ask and `failover`
  records `{requested, lane, reason: 'pool-unavailable'}`. With no eligible
  pool the job stays on its request and is held — it never launches on a lane
  that cannot serve it, and nothing is silently rewritten. A diverted job
  whose original request becomes eligible again is restored before it is
  claimed, with the same explicit record (`reason: 'requested-available'`).
- **Local jobs remain fast-tier under 100 lines.** On the `local` lane, a job
  whose declared bound is at most 100 changed lines (`size<=100` in envelope
  syntax) runs on the `fast` tier whatever `tier=` declared. Larger jobs, and
  jobs without a declared bound, keep the declared tier. The bound is
  inclusive: `size` is an upper bound, so `size<=100` is the sub-100-line
  class. A corrupt or absent bound never promotes a job.

Only `READY` jobs are routed. `CLAIMED`/`RUNNING` work is never re-pooled in
place — claim fencing owns what a dead claim means (see the sibling recovery
module) — and terminal or held jobs are not lane decisions. `bet=`/`src=`
fields are untrusted envelope data: they identify the job family for logging
but grant nothing.

## Dispatcher integration contract

Under the existing authoritative queue lock:

1. Read the latest queue keyed by stable job ID. Adapt each record to
   `status`, `pool`, `tier`, optional `size` (the `size<=N` bound, integer),
   and any existing `requestedPool`/`failover` markers.
2. Compute `eligible` once per tick: the ordered list of pools that are
   policy-approved for this job kind, available (window, readiness, engine),
   and not on hold. This module cannot grant pool access, billing authority,
   or release from a hold; an empty list is a valid answer.
3. For each READY job in launch order, call `route(queue, id, eligible=...)`.
   It returns a deep-copied queue and a `decision` record
   (`kind`: `requested`/`failover`/`held`, `lane`, `reason`, `tier`,
   `restored`). Persist the returned queue atomically; log the decision.
   Launch only `requested`/`failover` lanes through the existing claim path —
   the claim owner still rechecks status, attempts and fencing.
4. A `held` decision mutates nothing. `not-ready`, `pool-undeclared` and
   `no-eligible-pool` keep the job visible for the next tick or for explicit
   reconciliation; never map a held job to DONE.
5. Never drop `requestedPool` or `failover` when persisting. They are the
   audit trail a leader-bet reroute must leave; recovery (RQ-LANERECOVERQ8)
   may also exclude `requestedPool`/`triedPools` pools when re-eligibility is
   computed after a failure.

Do not deploy without adapting and testing the actual dispatcher's lock,
queue schema and atomic persistence. The pure transition tests prove lane
selection semantics — honored requests, explicit failover, local fast-tier —
not live exactly-once claiming. No installation, provider invocation,
production rerouting or billing occurs here.

## Offline checks

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s staging/RQ-LANEROUTEQ8 -v
```
