#!/usr/bin/env python3
"""Reference merge of state/resource-live.json into state/resource-pool.json.

For the Eng Ops ai.ashlr.resource-pool builder. The builder stays the only
writer of resource-pool.json: it calls merge() on the document it is about to
write. `phm usage resource-live` stays the only writer of resource-live.json.
Neither process opens the other's file for writing, so nothing races.

merge() is pure. It adds one key, "live", and changes nothing else. A reading
that is unverified or past its stale_after carries nulls, never zero.

  python3 -I resource_live_merge.py POOL.json LIVE.json   # prints the merged document
"""
import datetime
import json
import sys

SCHEMA = "resource-live.v1"
STALE_S = 60 * 60
VALUE_KEYS = ("used", "limit", "unit", "used_pct", "remaining", "reset_at")


def _epoch(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _reading(row, now):
    stale_at = _epoch(row.get("stale_after"))
    observed_at = _epoch(row.get("observed_at"))
    stale_over_1h = None if observed_at is None or observed_at > now else now - observed_at > STALE_S
    current = (row.get("verified") is True and stale_at is not None and now < stale_at
               and stale_over_1h is False)
    out = {key: (row.get(key) if current else None) for key in VALUE_KEYS}
    out.update(
        id=row.get("id"), lane=row.get("lane"), verified=current,
        stale=not current if row.get("verified") is True else None, stale_over_1h=stale_over_1h,
        # Source and observed_at stay on a stale row: they say what was last seen and when.
        source=row.get("source"), source_tier=row.get("source_tier"), observed_at=row.get("observed_at"),
        reason=row.get("reason") if row.get("verified") is not True else (None if current else "stale"),
    )
    return out


def merge(pool, sidecar, now):
    """Return a copy of pool with a "live" block built from the sidecar."""
    merged = dict(pool) if isinstance(pool, dict) else {}
    live = {"schema": SCHEMA, "generated_at": None, "current": False, "readings": {}, "lane_order": [], "allowances": []}
    if isinstance(sidecar, dict) and sidecar.get("schema") == SCHEMA:
        generated = _epoch(sidecar.get("generated_at"))
        live["generated_at"] = sidecar.get("generated_at") if generated is not None else None
        for row in sidecar.get("readings") or []:
            if isinstance(row, dict) and isinstance(row.get("id"), str):
                live["readings"][row["id"]] = _reading(row, now)
        # The plan was computed at generated_at. An old plan is dropped rather than followed.
        if generated is not None and 0 <= now - generated < STALE_S:
            plan = sidecar.get("burn_down") if isinstance(sidecar.get("burn_down"), dict) else {}
            live["current"] = True
            live["lane_order"] = [lane for lane in plan.get("lane_order") or [] if isinstance(lane, str)]
            live["allowances"] = [row for row in plan.get("allowances") or [] if isinstance(row, dict)]
    merged["live"] = live
    return merged


def lane_rank(pool):
    """Spend order for a router: lane -> position, lower first. Empty when the plan is not current.

    A lane that is absent keeps whatever order the router already had. A held
    lane is absent too, and the router should read its allowance row for why.
    """
    live = pool.get("live") if isinstance(pool, dict) else None
    if not isinstance(live, dict) or live.get("current") is not True:
        return {}
    return {lane: index for index, lane in enumerate(live.get("lane_order") or [])}


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-1].strip(), file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as handle:
        pool = json.load(handle)
    try:
        with open(argv[2], encoding="utf-8") as handle:
            sidecar = json.load(handle)
    except (OSError, ValueError):
        sidecar = None
    json.dump(merge(pool, sidecar, datetime.datetime.now(datetime.timezone.utc).timestamp()), sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
