# Main Guardian

The main guardian keeps every repo's default branch green after merge.

## How it works

When a PR lands on main, the guardian enqueues a `FIXUP-MAIN` job. A loop
runs detached post-merge verification (CI checks) against that merge commit
and writes pass / fail / unknown results to a state file. Each state entry
is keyed so the next loop iteration skips already-verified work.

## CLI commands

| Command | Role |
|---------|------|
| `ashlr fleet guardian-verify` | Runs verification passes until all manifest entries are pass or fail |
| `ashlr fleet guardian-compact` | Prunes stale entries so the state file reflects only active manifests |
| `ashlr fleet guardian-retry` | Removes a failed entry so it can be re-verified |
| `ashlr fleet main-repair-time` | Measures how long each `FIXUP-MAIN` repair takes |
| `ashlr fleet stuck-fixes` | Lists `FIXUP-MAIN` jobs whose PR is still open past 20 minutes |
| `ashlr fleet guardian-stuck` | Reports repos red for over 60 minutes with no current job; use `--json` for the typed report |
| `ashlr fleet main-red-age` | Reports each repo's guardian state and minutes red from `~/.ashlr-runs/guardian/state.json` (read-only; `--state <file>` overrides) |

Exit codes: `0` pass, `1` fail, `2` invalid args, `3` unknown/cancelled,
`4` timeout, `5` another guardian already holds the state file (retry later).

## Repair escalation

For a read-only service and freshness check, run `phm fleet health-age --service`
on the guardian's macOS user session. Add `--json` for the typed report. Exit 0
requires a fresh status, a loaded service and a successful last exit; exit 1
includes stale or missing status, an unloaded service, a failed exit, or unknown
evidence. A loaded service without a recorded exit is unknown, not a success.
The check reads launchd without changing it or printing its raw output. Follow
the diagnostic in the report to inspect the service or its logs. Add `--diagnose` to run the status, service and log checks together and list
one repair per problem; it only reads, so it never repeats the guardian's own
fixups. The existing `phm fleet health-age` checks freshness alone. Add `--log` to count error,
failed, failure and exception lines in the last 24 hours of the bounded 256 KiB
log tail. The JSON `log` object reports source availability, recent errors and
error lines with missing, invalid or future timestamps separately; it never
prints log text. Missing logs or undated errors are unknown and exit 1. The
count is limited to the tail, not necessarily the entire 24-hour period.

1. **Compact** prunes old entries. Stale state (entries no longer in the
   manifest) is removed so the state file stays under 1 000 entries.
2. **Retry** drops a specific failed entry. The output state is then fed
   back into `guardian-verify`, which re-runs verification for that repo.
3. **Repair time** is tracked via `~/.ashlr/guardian.jsonl` and
   `~/.ashlr/jobs-finished.jsonl` so slow repairs surface in `main-health`.

## Revert behavior

Guardian failures do not auto-revert. A `fail` result records the reason
(`code-failure`, `verification-infrastructure`, `invalid-input`, etc.) and
the failure category (`code`, `infra`, `timeout`). An agent watches the
fleet lanes; red repos with no fix jobs surface through `main-health-needs-you`
as urgent items so a human or agent can act (manual revert, infra fix, or
retry).

## ashlr fleet main-health

`ashlr` exposes a `/api/verse/runs-history/main-health` endpoint that reports:

- Per-repo state: green, red, or unknown (with failing check and SHA).
- `stale` flag: the guardian has not written status recently.
- `guardianOff` flag: the kill-switch (`~/.ashlr-runs/queue/MAIN_GUARDIAN_OFF`)
  is active, pausing all guardian work.

Run the typed CLI to inspect:

```
ashlr fleet main-repair-time --json
```

Agents read this data to decide whether to enqueue a retry, investigate a
code failure, or flag infrastructure for a fleet member.

`guardian-stuck` reads `guardian/state.json` under `ASHLR_RUNS_DIR` (or
`~/.ashlr-runs` by default). It exits 1 for stuck entries or unread/invalid
state, 0 when none are found, and 2 for invalid arguments. Revert status is
unknown unless the state records `revert_status` or a boolean `reverted`.
