"""Advisory only. Never read packet bodies, change routes, signal workers or launch.

Security must review/re-pin dispatcher + launcher integration before activation.
The TypeScript resume contract validates the packet and acquires Agent Bus claims.
"""
import re


def handoff_advice(job, lane, trigger, target=None):
    label = r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}"
    if (not all(isinstance(x, str) and re.fullmatch(label, x) for x in (job, lane))
            or trigger not in ("rate-limit", "quota-exhausted")
            or (target is not None and (not isinstance(target, str) or not re.fullmatch(label, target)))):
        return None
    return {"schema": "session-failover.v1", "event": "session_handoff_advisory",
            "advisory": True, "job": job, "lane": lane, "trigger": trigger,
            "target": target, "packet": "handffs/" + job + ".jsonl",
            "next": "validate-packet-repo-capabilities-and-claim", "dispatched": False}
