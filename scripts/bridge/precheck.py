"""Dispatcher queue transition for a completed precheck (no subprocess or I/O).

Call under the dispatcher's queue lock, before consuming READY work. Persist
returned rows atomically. Only launch=True authorizes passing to normal dispatch
checks; it grants no provider, spending or merge authority.
"""

import re


def apply_precheck(job, code, output):
    """Keep uncertain work retryable; duplicates stay blocked until rechecked.

    Never infer completion from legacy exit 13 or arbitrary subprocess errors.
    Reapplying a result is idempotent and preserves the job identity and payload.
    """
    row = dict(job)
    if row.get("status") not in ("READY", "BLOCKED"):
        return row, False
    if row["status"] == "BLOCKED" and row.get("precheckReason") not in (
        "precheck_duplicate", "precheck_awaiting_merge"
    ):
        return row, False
    job_id = row.get("id", "")
    if not re.fullmatch(r"RQ-[A-Z0-9-]+[A-Z0-9]", job_id):
        raise ValueError("invalid queue job identity")
    status, reason, launch = "READY", "precheck_unknown", False
    # Anchor the entire receipt, including identity. No task/raw tool output is
    # copied into queue diagnostics; malformed or mismatched receipts retry.
    receipt = re.fullmatch(
        rf"SKIP {re.escape(job_id)} code={code} reason=(\w+)\n?", output
    )
    detail = receipt.group(1) if receipt else ""
    if code == 0 and output in (f"GO {job_id}", f"GO {job_id}\n"):
        reason, launch = "precheck_go", True
    elif code == 10 and re.fullmatch(r"id_merged_pr_[1-9][0-9]*|pr_[1-9][0-9]*_(MERGED|CLOSED)", detail):
        status, reason = "DONE", "precheck_completed"
    elif code == 11 and re.fullmatch(r"pr_[1-9][0-9]*_green_clean", detail):
        status, reason = "BLOCKED", "precheck_awaiting_merge"
    elif code == 12 and re.fullmatch(r"id_open_pr_[1-9][0-9]*", detail):
        status, reason = "BLOCKED", "precheck_duplicate"
    elif code == 64 and output in ("REJECT code=64 reason=invalid_job", "REJECT code=64 reason=invalid_job\n"):
        status, reason = "FAILED", "precheck_invalid_job"
    row.update(status=status, precheckReason=reason)
    return row, launch
