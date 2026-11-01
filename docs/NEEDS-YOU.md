# Needs-you Items

The Needs-you drawer in the Phantom desktop console keeps a watch on every lane
and this Mac.  Items from **fleet** (running locally) come from a snapshot of
`~/.ashlr-runs` read by `fleet-needs-you.ts`; items from **release** and
**cloud-triage** (remote) come from the server.  The drawer polls every 15
seconds and flags only problems Mason, a contributor, or an agent can fix.

## Fleet on this Mac

_fleet-needs-you.ts_ items (local snapshot).

| Id | Fires when | Says | Next step | Opens |
|---|---|---|---|---|
| claude-lane-down | The Claude lane reports down | "The Claude lane is down" | Run the fix script from the runs bin folder | Fleet ▸ Claude lane (terminal) |
| switches-on | A dispatch switch file exists | "Dispatch is paused by {switch}" | Clear the switch in Fleet ▸ Switches | Fleet ▸ Switches |
| runs-dir-missing | The runs directory does not exist | "The runs directory is missing on this Mac" | Start the dispatcher to create it — Settings ▸ Connection | Settings ▸ Connection |
| stall-incident | Nothing starts and nothing merges for 30 min | "Stall incident" | Check Live runs and the leaders in Ops | Ops ▸ Leader journal |
| leader-overdue | No leader pass in 30 minutes | "No leader process is running" | Check leaders in Ops and restart the leader loop | Ops ▸ Leader journal |
| lane-held:{lane} | A lane has a hold reason | "Lane {lane} is held" | Check the lane in Ops ▸ Live runs | Ops ▸ Live runs |
| supply-personal-reset | Personal reset hit but lane still held | "Personal Codex has reset; its lane is still held" | Release the hold in Fleet ▸ Lanes, or wait for it to expire | Fleet ▸ Lanes |
| supply-personal-out | Personal limit reached (≥ 100 %) | "Personal Codex is out until {reset}" | Those jobs wait for the reset; leaders should route elsewhere | Fleet ▸ Supply |
| supply-personal-low | Personal usage at 90 %+ | "Personal Codex is at {used} %" | Move new work to Devin and local lanes before it runs out | Fleet ▸ Supply |
| host-disk-low | Disk free < 5 GB (danger) or < 20 GB (warning) | "Disk is critically/nearly full on this Mac" | Free space: empty ~/.ashlr-runs/archive and old clones | Ops ▸ Host |
| host-pressure | Disk < 10 GB or memory < 10 % free | "This Mac is under pressure" | Free disk space or memory on this Mac | Ops ▸ Host |
| lane-idle:{lane} | A lane has queued jobs but none running | "Lane {lane} is idle" | Check the lane's hold and target in Lanes | Fleet ▸ Lanes |
| drop-pending | Leader jobs awaiting ingest | "{n} pending drop file(s)" | Ingest sweeps every few minutes; check in Ops | Ops ▸ Leader journal |

## Release Needy

_release-needs-you.ts_ items (remote, per repo).

| Id | Fires when | Says | Next step | Opens |
|---|---|---|---|---|
| release-blocked | A release PR has failing/blocked checks | "Release {version} is blocked" | Open the release PR; Merge Gate reruns after the fix | Fleet ▸ Releases |
| release-ready | A release PR is green, no failures | "Release PR #{num} is green" | Open the release PR; Merge Gate reports all green | Fleet ▸ Releases |

## Cloud Triage

_cloud-triage.ts_ items (remote, per delivery lane).  The drawer's server
response attaches **cloud** or **devin** prefixes to each row.

| Id | Fires when | Says | Next step | Opens |
|---|---|---|---|---|
| fleet:owner-lane-pr:cloud-{taskId} | A cloud PR gate preview exists | PR title (varies) | Action on the preview (approve / reject / fix) | Fleet ▸ Releases |
| fleet:owner-lane-pr:devin-{taskId} | A Devin session preview exists | Session title (varies) | Action on the preview (approve / reject / fix) | Fleet ▸ Releases |

## Not covered

The drawer does **not** currently flag:

- a single stuck worker (no per-worker health check in fleet-needs-you.ts)
- a lane with target > 0 but only errors (no active item fires)
- a cloud PR that has been idle for many days without checks (covered only when blocking or green)
- a leader with a single old inbox entry (leader-overdue requires 30-min silence)
- a host with disk > 20 GB and memory > 10 % (below all thresholds)
