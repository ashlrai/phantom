```sh
ashlr fleet doctor
```

Start here. Doctor checks whether each worker engine is installed, signed in
and ready. Then use the matching read-only check below to investigate a problem.
For agents, run `ashlr fleet doctor --json`; every example below also uses `--json`.
`phm` is an alias for `ashlr`.

# Fleet health

Read results in plain words:

- **ok**: the available evidence looks healthy.
- **warn**: something needs attention, or evidence is missing, stale or unknown.
  Unknown does not mean healthy.
- **red**: a reported failure or blocked engine needs fixing.

These are reading guidelines, not shared JSON values. Each verb keeps its own
fields and thresholds. Doctor currently returns engine readiness rows (`ready`,
`installed`, `authed`), not an `ok`/`warn`/`red` report. Read the result,
not just the exit code: several report commands exit 0 even with problems.

| Check | Example command | What to read |
| --- | --- | --- |
| Engines | `ashlr fleet doctor --json` | `ready: true` is ok; unknown authentication is warn; a missing or blocked engine is red. Does not start workers. |
| Fleet overview | `ashlr fleet status --json` | Daemon, queue and engine evidence; inspect missing or degraded sources before trusting totals. |
| Lanes | `ashlr fleet lanes --json` | Lane capacity, queue depth and live jobs; unknown readings need attention. |
| Leader | `ashlr fleet leader-health --json` | Failures in a row, hours since success, last bet and cause. Unknown means no evidence; exits 1 at two consecutive failures. |
| Queue and supervisors | `ashlr fleet heartbeat --json` | `stale: false` is fresh. Older than 30 minutes, missing or unreadable is stale; exits 1 if any source is stale. |
| Default branches | `ashlr fleet main-health --json` | Repo `state`, failing check and fix jobs. Red means failing checks; also inspect `stale`, `source` and `guardianOff`. Add `--strict` for exit 1 on red, stale or unavailable evidence. |
| Guardian freshness | `ashlr fleet health-age --json` | `fresh` means at most 30 minutes old. Stale, missing or invalid evidence exits 1. |
| Sign-in holds | `ashlr fleet login-health --json` | Expired-login holds and whether a later nonempty finish was observed. Top-level `status: ok` means the ledger was read, not that all logins work. |
| Stuck PRs | `ashlr fleet stuck-prs --json` | Lists PRs still recorded open after 60 minutes. An empty list with an error is unknown, not healthy. |
| Wasted runs | `ashlr fleet waste --json` | Last six hours of skips, empty finishes, pool errors and runs without a PR. Counts overlap; unavailable totals stay unknown. |
| Old worktrees | `ashlr fleet worktree-stale --json` | Lists cleanup candidates, oldest first. This example only lists; do not add `--apply` for a health check. |
| Brain activity | `ashlr fleet brains --json` | Last recorded action; stale after 90 minutes, missing log is unknown. |
| Disk | `ashlr fleet disk --json` | Free-space trend and largest runs folders; unknown readings are not zero. |
| Memory | `ashlr fleet memory --json` | Recorded free memory, swap and memory guard state; check the sample age. |
| Judge | `ashlr fleet judge-health --json` | Recorded calibration, verdict distribution and warnings. Leave out `--degradation` to avoid running new judge evaluations. |
| Evidence source | `ashlr fleet evidence doctor decisions --json` | Source state and reason; healthy, cold-start and recovered retry exit 0. Other states exit 1; cold-start still means little evidence. |

Follow the reason in the affected result, fix that problem, then rerun that check.
These commands inspect health; they do not authorize dispatch, cleanup or merge.
See [all fleet verbs](FLEET-VERBS.md) for other fleet tools.
