# Daily CI trigger plan

Run these commands from the repository root:

```sh
ashlr fleet ci-plan
ashlr fleet ci-plan --patch | git apply
```

The first command reads workflow YAML and prints a table and owner follow-ups.
The second applies the printed patch and is for Mason to run after reviewing it.
The fleet cannot apply it itself: workflow files require owner review and cannot
be edited and auto-merged by fleet workers. The planner never writes files.
Use `--json` for the full result or `--cron "3 9 * * *"` to override newly
added schedules. Default new schedules use 09:03–09:30 UTC, ordered by filename
and wrapping after 28 workflows. Existing schedules, including weekly ones,
are preserved. Parse failures are reported as skipped with their errors.

The planner removes `pull_request`, `pull_request_target`, and branch `push`
triggers. Tag-only pushes are retained. Manual, reusable, release, repository
dispatch and merge-group events remain, as do existing schedules. Therefore
this is a trigger migration proposal, not a global once-per-day rate limiter.
Review retained events and workflows whose jobs depend on PR event payloads
before applying; adding a schedule does not adapt those jobs automatically.

After CI stops running for PRs, the required **Merge Gate** check never
completes. Mason must remove that requirement in branch protection/rulesets
and require **ashlr/verify**, the host-verified gate implemented in
`src/core/fleet/host-merge.ts` and `src/core/fleet/verify-check-run.ts`.
Read current branch protection checks with:

```sh
gh api 'repos/{owner}/{repo}/branches/master/protection/required_status_checks'
```

This command only reads settings. Review rulesets separately and ensure host
verification is configured before switching merge requirements.
