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
| `ashlr fleet main-red-age` | Reports each repo's guardian state and minutes red from `~/.ashlr-runs/guardian/state.json` (read-only; `--state <file>` overrides) |

Exit codes: `0` pass, `1` fail, `2` invalid args, `3` unknown/cancelled,
`4` timeout, `5` another guardian already holds the state file (retry later).

## Repair escalation

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
