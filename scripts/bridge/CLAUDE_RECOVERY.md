# Claude dispatch recovery contract

`claude_recovery.py` is a host integration seam, not an activated dispatcher.
The live Claude API dispatch/precheck scripts are absent from this repository.
The only precheck source found here is the proposal under
`staging/RQ-DUPMATCHFIXQ7/precheck.sh`; do not treat it as the installed script.

The supervisor can call `recover` with its existing precheck, dispatch and
admission-controlled reroute operations. It must retain the original durable
job and lease throughout the call. Each dispatch callback must wait for the
attempt to stop before returning. Set `transient` only for classified transport,
rate-limit or server failures; never for auth, budget, policy or sandbox denial.
No raw transcript or credential is needed by the recovery layer.

- Successful nonempty dispatch completes normally.
- Exit 1 with an empty parsed result is ambiguous: eligible jobs may reroute,
  but the result never proves success and is not blindly retried.
- Other explicit transient failures get three total attempts, separated by one
  and two seconds, with prechecks repeated before each launch.
- Precheck 13 is an existence heuristic, so it holds the job for reconciliation.
  Codes 10–12 also hold it: an already closed target or open PR does not itself
  authorize acknowledging the original job's acceptance criteria.
- Exhausted transient failures may reroute eligible jobs. Deterministic failures
  and precheck holds never reroute.
- `reroute` must atomically/idempotently enqueue the same job identity in an
  independently authorized pool before returning True. False or an exception
  leaves the original outstanding. A crash after enqueue must be reconciled by
  job identity, never by dropping the original or generating a new job ID.

The return value contains only state, classification and attempt count.
`held` must never trigger queue completion. `rerouted` records a durable handoff,
not task completion. Activation requires wiring these callbacks in the private
host dispatcher and testing its durable queue transaction and crash recovery;
these operations cannot be verified from this checkout.

Run the hermetic seam tests:

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s scripts/bridge -p test_claude_recovery.py
```
