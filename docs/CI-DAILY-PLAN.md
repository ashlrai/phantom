# CI daily plan (`ashlr fleet ci-plan`)

Mason's Nov 1 2026 order: GitHub Actions run at most once a day per repo — a
scheduled nightly — with the per-PR and per-push triggers removed. Merges gate
on the fast local check instead of a per-PR workflow run.

Workflow files are owner-reviewed, so the fleet cannot edit them and
auto-merge. What the fleet can do is compute the exact change and hand it to
the owner as one command.

## Commands

Plan (read only — a table plus the follow-ups):

```bash
ashlr fleet ci-plan
```

Apply (the only two commands Mason needs):

```bash
ashlr fleet ci-plan --patch | git apply --check   # dry run
ashlr fleet ci-plan --patch | git apply           # write .github/workflows
```

Then commit the workflow diff by hand. `ashlr fleet ci-plan --json` prints the
same plan as JSON; `--cron "M H * * *"` overrides the staggered nightly slot.

## What the planner does

For every `*.yml`/`*.yaml` in `.github/workflows` (read only, never written):

- removes the top-level `pull_request`, `pull_request_target` and `push`
  triggers — except a `push` filtered to tags only, which is kept and noted;
- keeps `workflow_dispatch`, `workflow_call`, `merge_group`, `release`,
  `schedule`, `repository_dispatch` and anything else it does not recognize;
- adds `schedule:` with a nightly cron when a workflow lost a trigger and had
  none — default slots spread 09:03–09:30 UTC across the files that need one,
  deterministic by file name order;
- reports `keep` when nothing is removed, `skip` when the file does not parse
  (the parse error is in `reason`).

The rewrite is a YAML round-trip: comments, key order and `workflow_dispatch`
inputs survive.

## Required-check follow-up (owner action)

Once `ci.yml` no longer runs on `pull_request`, the **Merge Gate** required
check never completes on a PR — branch protection must stop requiring it or
merges wedge. The fleet's host merge path becomes the gate instead:
`src/core/fleet/host-merge.ts` waits on the host-verified required check
`ashlr/verify` posted by `src/core/fleet/verify-check-run.ts`. Make
`ashlr/verify` the required check on master in place of `Merge Gate`.

List the required checks currently on master (read only):

```bash
gh api 'repos/{owner}/{repo}/rules/branches/master' \
  --jq '[.rules[] | select(.type=="required_status_checks")]'
gh api 'repos/{owner}/{repo}/branches/master/protection/required_status_checks'
```

## Why the fleet cannot apply it itself

`.github/workflows/**` is owner-reviewed. A fleet worker that wrote the patch
into the worktree would need the change committed and merged through the very
required checks this change disables — circular. So the planner stays pure:
it computes `before`/`after` per file and renders a unified diff; only Mason
runs `git apply` and commits.
