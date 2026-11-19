# Prune finished job worktrees

## `phm worktrees`

Run `phm worktrees` to list every job worktree with its job, repo, state (live
job, merged PR, empty result, open PR, kept on purpose or unknown), age, size
and whether it is safe to remove, followed by counts by state and the total
size that can be reclaimed. A worktree is safe to remove only when its PR
merged or the job ended empty, it is at least six hours old, `git status`
shows no modified or untracked files, no job is running in it and it is not on
`queue/keep.txt`, in `status.json` kept worktrees or pinned in
`~/.ashlr/kept-worktrees.json`. If any safety record cannot be read, nothing is
safe. Ignored build output such as `node_modules` does not block removal.

Run `phm worktrees --reap` to preview the removal (a dry run), then
`phm worktrees --reap --apply` to remove the safe worktrees with
`git worktree remove`, never `--force`. Each removal is checked for changes
again just before Git runs, printed and appended to
`~/.ashlr-runs/queue/worktree-reap.jsonl`. Add `--json` for the
`worktrees.v1` report. The Home view's Disk card shows the same counts.

The same command reports reaper health (`reaper` in the JSON). It is
`healthy` when nothing is safe to remove or the last removal attempt in
`worktree-reap.jsonl` is under 24 hours old, and `stale` when safe worktrees
are waiting and the reaper never ran, last ran over 24 hours ago, or its last
batch only failed. A publisher marker over six hours old is listed under
`stuckRuns`. It is `unknown` when a record cannot be read. `eligible` lists the
safe jobs; the check only reads, so live, open, kept, dirty and unmerged
worktrees are never listed or removed by it.

## `phm worktrees prune`


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
