# Autofix (phm autofix)

`phm autofix` is the auto-fix side of the Eng Ops self-aware loop. Each tick
reads incident filenames that `self_aware.py` writes at
`~/.ashlr-runs/bus/core/INCIDENT-<key>.md` and appends one status line to
`~/.ashlr-runs/ledger/incidents.jsonl`. It also appends an action line to
`~/.ashlr-runs/ledger/autofix.jsonl`.

The markdown body is not read. Nothing from that body is placed in a command,
an argument, or the environment. The key is taken from the filename and must
match `^[a-z0-9._-]{1,96}$`. A fixed table maps the prefix:

| Prefix | Incident | Action |
| --- | --- | --- |
| `a` | Release draft with 0 assets | Re-kick `ai.ashlr.release-autorun` when the tag passed attest. If a newer release has published, mark `intentional` / `superseded`. |
| `b` | launchd nonzero exit or runs rate | Disable KeepAlive only when a fresh `runs` sample is still climbing by more than 20 in the last hour. |
| `d` | Stalled lane | Reap stale leases and restart that lane's pool, unless `slots.json` target is 0. |
| `e` | Load outside dispatchd | Renice to +15, or +20 for known batch daemons, when load1 exceeds 2 times the CPU count. |
| `g` | Release autorun hold | Detect only. File the key for Security. |

Prefixes `c` and `f` are not in the table. Those keys are refused.

Copy-paste:

```sh
phm autofix --json
phm autofix --apply --json
phm autofix --only launchd-crashloop --apply
```

Dry run is the default. `--apply` performs the actions. `--dry-run` is the
same as the default and cannot be combined with `--apply`.

## Refusals

The tick does nothing when `~/.ashlr/KILL` exists.

A launchd disable also refuses when:

- the newest `runs` sample is stale, the two samples are under 60 seconds apart, or the count is no longer increasing
- `phm authority resident status` reports `Resident admission: admitted` with an active grant and `ai.ashlr.daemon` running (`refused_admitted`, and an RQ file is written instead)
- the job plist, or a `.rollback.*` sibling, was written in the last 15 minutes

Disable is `launchctl disable` and `launchctl bootout` of that user-domain job
only. It does not delete the plist. An admitted resident that is healthy at
`runs = 1` is not a crash loop.

Release actions never delete, close, or move a draft or a tag, and they never
sign. A dependency-audit dispatch runs only when the autorun log shows
`audit absent` for that tag's commit.

A lane whose `slots.json` target is 0 is `intentional`. Load control never
kills, and it never renices dispatchd-owned pids, the kernel, or allowlisted
interactive apps.

A hand edit of an installed pinned file (`dispatchd.py`, `dispatchd_guard.py`,
`lane_rules.py`, `launch.sh`, sandbox profiles, `publish.sh`, `git-safe-env.sh`,
`release-autorun.sh`, `version-bump-train.sh`) is detect-only. The report goes
to Security. The file is not restored.

## Ledgers

`incidents.jsonl` lines are `{key, status, reason, ts}`. `status` is `fixed`,
`failed`, `intentional`, or `refused`.

`autofix.jsonl` lines are `{ts, fixer, target, action, before, after, result}`.

Neither ledger is sent through `router-queue.md`. No model call is made.
