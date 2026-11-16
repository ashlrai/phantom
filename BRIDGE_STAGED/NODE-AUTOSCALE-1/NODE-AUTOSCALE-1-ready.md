# NODE-AUTOSCALE-1: Security package (staged, not live)

Destination: copy this directory to `~/.ashlr-runs/staged/NODE-AUTOSCALE-1/` and
this file to `~/.ashlr-runs/bus/security/NODE-AUTOSCALE-1-ready.md`. The
authoring lane (claude, RQ-NODE-AUTOSCALE-1) got EPERM on every path under
`~/.ashlr-runs` (read and write, sandbox off), so it could not place the
package there itself. Nothing in it is installed or running.

## Contents

| File | Purpose |
| --- | --- |
| `node_capacity.py` | Stdlib-only, read-only reader dispatchd imports. No network, subprocess or writes. |
| `test_node_capacity.py` | 4 unittest cases over the recorded main-MBP document (`python3 -m unittest test_node_capacity`). |
| `ai.ashlr.node-capacity.plist` | LaunchAgent template: `phm node capacity --out ~/.ashlr-runs/metrics/node-capacity.json` every 60 s. Local only. |

The producer (`phm node capacity`) and the router (`phm node route`) are
ordinary repo code in the RQ-NODE-AUTOSCALE-1 PR, not part of this package.

## Pinned base

`bin/dispatchd.py` live sha256 prefix `d5acb03d` (from the job brief). This lane
could not read the file, so **no diff is cut here**. Security cuts the hunk
against the pinned base and folds it into RQ-DISPATCHD-BATCH-PIN-1 if that pin is
still open (both touch dispatchd's per-lane target computation).

## Integration (one hunk, in the memguard backoff branch only)

Where dispatchd currently lowers a lane with `reason=backoff:memguard`
(Nov 15 23:49 ET: cursor 3->1, grok 6->1):

```python
import node_capacity  # staged module, installed next to dispatchd.py

cap = node_capacity.lane_capacity_cap(lane, running_count, node_capacity.read_doc())
if cap is None:
    new_target = memguard_target            # unchanged behaviour
else:
    new_target = max(memguard_target, min(current_target, cap))
    reason = f"capacity:node-measured ({cap})"
```

Invariants Security should check:

- It runs only inside the existing memguard-backoff branch. PAUSE file, kernel
  pressure, swap growth, loadgate, hard_cap, ceilings and merge-queue checks
  run before and after it unchanged.
- It can only raise a lane up to its current target. Its ceiling is lines
  already running plus `agents_runnable_now[harness]`. That value is computed
  from that harness's measured CLI+MCP footprint and from memory above
  memguard's own 30% raise line.
- `None` (missing, stale >120 s, symlink, not owned, malformed, pressure,
  swap-growth or unmeasured harness, or unmapped lane) keeps memguard's decision.
- Lane to harness map is in `node_capacity.LANE_HARNESS`. Unlisted lanes
  (`zai`, `agy`, `claude-api`, ...) are untouched.

## Remote nodes (not live; needs sign-off before any use)

No new remote path is added. For masons-macbook-pro (tailnet 100.89.122.8) and
the MacBook Air later, phase 2 would be: each node runs the same LaunchAgent
locally, and the main MBP reads the document with the existing tailnet SSH alias,
`ssh <tailnet-alias> phm node capacity --json`. That is read-only and
tailnet-only: no `tailscale serve`, no funnel, no 0.0.0.0 binds. Its output goes to
`phm node route --capacity`. This is described only and not wired.

## Needs Mason at a node (not done by this lane)

1. masons-macbook-pro (8 GB): install a phm build that includes this change, then
   run `phm node capacity --json` once. Its output fills Eng Ops' mac-2-8gb
   ledger row. If macOS asks for permission to run `footprint` or `pgrep`, Mason
   approves it at the node.
2. MacBook Air (16 GB): the tailnet join steps in
   `~/.ashlr-runs/bus/mason-only/macbook-air-join.md` (Tailscale sign-in at the
   machine), then the same as step 1.
3. Approve installing `ai.ashlr.node-capacity.plist` (a new LaunchAgent) on each node.
