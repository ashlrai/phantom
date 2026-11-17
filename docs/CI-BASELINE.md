# CI baseline analyzer

Run `phm ci baseline --json` to inspect open PRs in ashlrai/phantom. Use
`--repo owner/repo` for another repository with a master branch. Analysis is
read-only: it does not rerun jobs, change tests, merge PRs, or update branches.

The version 1 JSON report contains failure groups, per-PR freshness, master
evidence, unknown reasons, and proposed update-branch commands. Latest workflow
runs are checked against the current head and full checkout SHA in job logs.
Unreadable, incomplete, capped, or unverified logs are unknown, never clean.
Vitest FAIL lines identify tests; AssertionError summaries are scrubbed and capped
at 2,000 characters per failure, with at most 100 failures per log.

Two unaffected fresh PRs sharing a test produce `queue-master-fix` and a ready
brief. Test/import changes produce `pr-caused`; a singleton unaffected failure
with an explicit verbose test pass on master's current run produces
`rerun-failed`. Other evidence stays `unknown`. Relative TypeScript imports are
followed transitively from master (100-file cap); package imports track dependency
manifests. Unresolved imports prevent independence claims. Nonverbose pass output
does not establish an individual test pass. The scan caps open PRs, runs, and jobs
at 100 each and reports unknown rather than drawing conclusions from truncated
run/job listings. Master reproduction remains an explicit step in the fix brief.

`phm ci baseline --queue --json` appends only master-fix briefs to
`~/.ashlr-runs/queue/router-queue.md`, at tier `work`, deduplicated by repository
and test id. `--queue-file /absolute/path` overrides that file. Queueing is an
explicit local write independent of `--apply`; no other group is queued.

Update-branch commands are always plans by default. `--apply` executes them only
when the exact test explicitly passes on current master and a merged master PR
with the deterministic job id in its body has a merge commit reachable from
master. Missing provenance means skip. The API receives `expected_head_sha` so a
changed PR head is not silently updated. A passing master test alone is not proof
of a merged fix. Rerun proposals are never executed by this command.
