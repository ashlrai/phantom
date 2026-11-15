# Merge cockpit

Run `phm fleet merge-cockpit --json` for the rebase treadmill as one read-only, loopback-safe snapshot. `--root /absolute/path` selects another runs directory (`ASHLR_RUNS_DIR` is honoured), and `--hours <n>` bounds the window (default 24, max 720). The Verse API serves the same report at `GET /api/verse/fleet/merge-cockpit`. Nothing here runs `gh` or `git`, changes the queue, or touches a pull request.

The report reads `~/.ashlr-runs` only:

- `queue/*.queuegen-state.json` — queuegen's emitted map (`<owner>/<repo>#<pr>` -> `{id, at}`). An `RQ-REBASE-<short>-<pr>-<head>` id is durable proof the fleet triaged that PR as DIRTY at `at`; that is the cockpit's triage timestamp. `RQ-FIXUP-` ids are check-failure work, not conflicts.
- `queue/ready.tsv` and `queue/claimed.tsv` — live rebase jobs (READY, running, PARKED-*).
- `metrics/jobs.jsonl` — enqueue/claim/launch/finish rows for rebase jobs; `outcome` rows carry the PR url and `ttm_s` for close evidence and merge rate (MERGED and CLOSED both count as close).
- `queue/landed-closes.jsonl` — `phm fleet landed-close` closes (ashlrai/phantom only; the writer is pinned to that repo).
- `metrics/merge-events.jsonl` — optional external ledger (`conflict`, `merged`, `closed`); absent is fine.

Per repo the report shows:

- `conflictsOpen` — triaged conflicts with no close evidence after the earliest triage, still fresh (triaged inside the window or holding a live rebase job). Older records without close evidence are dropped, not counted as open.
- `coverage` — for each open conflict, whether a live rebase job covers its latest emitted head (`current`), only a different head (`staleHead`), the job already reached launch/finish (`worked`), or nothing covers it (`uncovered`). Null when the queue is unreadable. `conflictsUntracked` counts open conflicts seen only through queue rows.
- `rebase` — `ready`/`running`/`parked` live rows, `spins` (distinct rebase job ids with any in-window evidence), `runs` (ids that reached launch/finish), and `repeatPrs` (PRs needing a second rebase id — the head moved under them again).
- `triageToCloseS` — earliest triage to earliest close in seconds (count, median, p90, max) for conflicts closed inside the window.
- `merges` — MERGED outcomes in the window, per-hour rate and median `ttm_s`.

Every source reports `healthy`, `missing` or `degraded`; `known:false` means nothing was readable, and `jobsClipped` flags a truncated ledger tail. Rebase job ids carry repo short names only, so live rows and ledger events join to `owner/name` through the queuegen state — a short name shared by two owners is never attributed by guess. The exit code is always 0; this is a projection, not an authority.

The Verse console's **Live fleet** section shows the same report as a "Merge cockpit" block, refreshed with the live status poll; a failed fetch renders `Unknown`, never a blank view.
