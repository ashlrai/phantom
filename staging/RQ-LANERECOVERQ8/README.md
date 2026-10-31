# RQ-LANERECOVERQ8 recovery handoff

This is a staged integration for the external router queue dispatcher, following
`staging/RQ-DUPMATCHFIXQ7`. It is not installed or activated by this repository.
`dispatchd.py` and its authoritative queue writer are absent here. Do not apply
this reducer to the unrelated GitHub issue router in `contrib/router`.

## Diagnosis

The previous staged precheck returns 13 when named files and a matching test
exist, or when backticked symbols are defined. These are existence checks, not
acceptance checks; repair/regression work necessarily names existing code.
The replacement `precheck.sh` removes those heuristics and their dead fetch /
source-search code, preserving exact duplicate checks. Legacy code 13 is BLOCKED
by recovery, never silently completed. PRECHECK_UNSURE (12) is likewise BLOCKED;
a confirmed existing PR can be terminalized without spawning another worker.

Repeated Claude empty failures cannot be attributed to authentication, quota,
provider health, or prompt quality from the repository alone: there are no live
attempt receipts here. Treat them as a recovery class, not a proven root cause.
Only exit 1 with supervisor-confirmed process termination, empty result, pristine
worktree, and no published PR is eligible. Uncertain evidence, timeouts, signals,
partial edits and success are blocked for reconciliation. A caller must include
external side effects in its pristine assessment; an empty patch is insufficient.

## Dispatcher integration contract

Under the existing authoritative queue lock:

1. Read the latest queue keyed by stable job ID. Adapt its fields to `status`,
   `pool`, `attempts` (total launches, initially zero), and opaque `receipt`.
2. Before launch, call `claim` with a never-reused receipt, persist the entire
   returned queue atomically and durably, then launch exactly once. A failed
   persist must never launch. A crash after claim requires reconciliation with
   the worker; do not blindly launch a RUNNING receipt again.
3. After confirmed worker termination, call `recover` using that launch receipt.
   Supply only currently policy-approved, available, unheld pools in `eligible`.
   This does not authorize spending, create credentials, or bypass lane policy.
4. Atomically persist the result under the same lock. Rerouting updates the same
   job to READY; it never appends a replacement or drops queue history. The next
   tick claims it. Replayed or stale completion events are no-ops.
5. Keep BLOCKED jobs visible for explicit reconciliation. Never map BLOCKED to
   DONE-NOOP. Retry exhaustion (three total attempts), missing alternate pools,
   and ambiguous prechecks retain the original job. Prior pools are excluded.

Do not deploy without adapting and testing the actual dispatcher's lock, queue
schema, atomic persistence and crash reconciliation. The pure transition tests
prove identity preservation and replay safety, not live exactly-once delivery.
No installation, provider invocation, production rerouting or billing occurs here.

## Offline checks

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s staging/RQ-LANERECOVERQ8 -v
HOME=$(mktemp -d) PRECHECK="$PWD/staging/RQ-LANERECOVERQ8/precheck.sh" bats staging/RQ-DUPMATCHFIXQ7/precheck_dup_match.bats
```
