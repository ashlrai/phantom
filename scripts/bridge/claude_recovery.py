"""Recovery seam for an operator-owned Claude bridge; never acknowledges queue jobs.

The host supplies zero-argument precheck/dispatch callbacks and a reroute callback
that durably queues the SAME job before returning True. Exceptions propagate so
an uncertain handoff never looks successful. Callers retain the original lease
until recovery returns; held jobs remain outstanding. No child output is logged.
"""
from dataclasses import dataclass
import time
from typing import Callable


@dataclass(frozen=True)
class Result:
    code: int
    # Set by the dispatcher after parsing its result, not by searching a transcript.
    empty: bool = False
    transient: bool = False


def classify(result: Result, precheck: bool = False) -> str:
    if precheck:
        # 13 is only an existence heuristic, never acceptance evidence. Open PRs
        # and unreadable GitHub state (12) also retain the original queue job.
        if result.code == 0:
            return 'go'
        if result.code == 10:
            return 'already-closed'
        return {11: 'open-pr', 12: 'duplicate-or-unsure',
                13: 'acceptance-unverified'}.get(result.code, 'precheck-failed')
    if result.code == 0 and not result.empty:
        return 'completed'
    if result.code == 1 and result.empty:
        return 'empty-exit-1'
    if result.transient:
        return 'transient'
    return 'failed'


@dataclass(frozen=True)
class Recovery:
    state: str
    reason: str
    attempts: int


def recover(precheck: Callable[[], Result], dispatch: Callable[[], Result], *,
            reroute: Callable[[], bool], eligible: bool = False,
            sleep: Callable[[float], None] = time.sleep) -> Recovery:
    """At most three launches, with 1s/2s backoff and fresh prechecks.

    Empty exit-1 is ambiguous, not success or proof of a provider outage. Retry
    only dispatcher-classified transient failures (e.g. transport/429/5xx), then
    offer eligible jobs to the host's existing admission-controlled fallback.
    Empty exit-1 may also reroute, but deterministic failures never do. Rerouting
    does not bypass a precheck hold, budget, authentication or sandbox gate.
    """
    attempts = 0
    while True:
        gate = classify(precheck(), precheck=True)
        if gate != 'go':
            return Recovery('held', gate, attempts)
        result = dispatch()
        attempts += 1
        reason = classify(result)
        if reason == 'completed':
            return Recovery('completed', reason, attempts)
        if reason == 'transient' and attempts < 3:
            sleep(2 ** (attempts - 1))
            continue
        if eligible and reason in ('transient', 'empty-exit-1') and reroute():
            return Recovery('rerouted', reason, attempts)
        return Recovery('held', reason, attempts)
