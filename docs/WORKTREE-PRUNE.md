# Prune finished job worktrees

Run `phm worktrees prune --json` to preview clean, unkept job worktrees whose
latest local job ledger record says merged, closed, or empty and whose finish
is over two hours old. Each entry includes its reason and measured logical
size; `sizeComplete: false` means the size is a partial estimate. `--dry-run`
is an explicit synonym for the default preview.

Run `phm worktrees prune --apply --json` to remove the listed worktrees using
Git. The command checks the job ledger, kept-worktree policy and Git status
again before removal. Dirty worktrees, including ignored files, are preserved.
Missing or unreadable evidence is preserved. The command reads the local ledger;
it does not query GitHub, so a closed or merged PR without a recorded outcome
is not eligible. A finish timestamp is required to establish age.
