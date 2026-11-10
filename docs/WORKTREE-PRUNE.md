# Prune finished job worktrees

Run `phm worktrees prune` to preview clean, inactive job worktrees whose latest
local job ledger records a merged or closed outcome, or an empty result finished
more than six hours ago. A finish timestamp is required for every candidate.
Each entry includes its reason and measured logical size; an incomplete size is
a partial estimate. Add `--json` for machine-readable output. `--dry-run` is
an explicit synonym for the default preview.

Run `phm worktrees prune --apply` to remove eligible worktrees using Git. The
command checks the job ledger, running-job markers, process table, retention
policy and Git status again before removal. Dirty worktrees, including ignored
files, and worktrees with missing or unreadable safety evidence are preserved.
The command reads the local ledger; it does not query GitHub, so a closed or
merged PR without a recorded outcome is not eligible.
