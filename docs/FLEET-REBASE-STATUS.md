# Rebase-wave status

Run `phm fleet rebase-status --repo ashlrai/phantom --json` (repeat `--repo` for more repositories). The command reads open PRs through `gh pr list` and the local `~/.ashlr-runs/queue/ready.tsv`; `--root /absolute/path` selects another runs directory. It does not change PRs or queue jobs.

Each repository reports conflicting `bridge:` PRs, median and oldest PR creation age in seconds, and coverage by active queuegen `RQ-REBASE-<repo>-<PR>-<head>` jobs. Coverage distinguishes the current head, stale heads, no active job, and unknown head. Duplicate jobs do not increase coverage. Queue coverage is null if the queue is missing or degraded; a failed GitHub read is unavailable, and a 1,000-row result is marked truncated. A nonzero exit signals incomplete evidence. Repository short names must be unique across the queried fleet because queuegen IDs omit the owner.

This is a snapshot, not a measured conflict or re-conflict rate: PR creation age is not conflict age. Compare timestamped snapshots to observe changes, without treating differences as a count of re-conflicts.

To turn the conflicting population into rebase-job batches (same-file clusters together, disjoint spread), see [rebase-plan](FLEET-REBASE-PLAN.md) — `phm fleet rebase-plan` emits ready.tsv-ready job specs for the same `bridge:` set this report counts.
