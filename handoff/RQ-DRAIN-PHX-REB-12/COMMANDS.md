# Commands and results

All builds, tests, lint and static checks used `nice -n 10`. Test commands used
fresh temporary homes created with `mktemp -d /tmp/rq-reb12-test.XXXXXX` (or the
verify/baseline equivalents). No authentication files were copied into them.

- `npm install -g @ashlr/phantom`: failed EPERM. Existing binary retained.
- `cat docs/AGENT-MCP-CLI.md`; `phm docs --agent --json`;
  `phm mcp list --json`; `phm --version`; `node --version`: completed.
- Read planning-with-files SKILL.md and created ignored task_plan.md/notes.md.
- `git status --short`; `git remote -v`: clean starting tree, fork/origin confirmed.
- `git fetch origin master refs/pull/7665/head:refs/remotes/origin/audit-7665 refs/pull/7652/head:refs/remotes/origin/audit-7652 refs/pull/7593/head:refs/remotes/origin/audit-7593 refs/pull/7591/head:refs/remotes/origin/audit-7591 refs/pull/7588/head:refs/remotes/origin/audit-7588 refs/pull/7583/head:refs/remotes/origin/audit-7583`: passed.
- Initial `git diff origin/master...origin/audit-<PR>` reads failed because the
  repository was shallow. `git fetch --deepen=1500 origin master refs/pull/7665/head refs/pull/7652/head refs/pull/7593/head refs/pull/7591/head refs/pull/7588/head refs/pull/7583/head` exited 128 after a concurrent shallow-file update. Subsequent `git rev-parse --is-shallow-repository` returned false and all merge bases resolved.
- For each PR in supplied order: `git diff --stat origin/master...origin/audit-<PR>`;
  `git merge-tree --write-tree origin/master origin/audit-<PR>`: inspected.
  All six merge-tree commands reported content conflicts. No equality claimed.
- `git log origin/master -S <text> --format='%h %s' -- <path>` and `git show <commit>`:
  checked replacements and existing behavior. Connected GitHub get_pr_info verified
  all six heads twice and confirmed the six cited replacement PRs are merged.
  fetch_pr_patch inspected all six patches; search_prs checked supersession.
- `gh pr view 7665 --repo ashlrai/phantom --json number,state,headRefOid,statusCheckRollup`:
  failed because gh configuration was inaccessible. No credential workaround used.
- `mkdir -p ~/.ashlr-runs/handoff/RQ-DRAIN-PHX-REB-12`: denied EPERM. Used the worktree fallback.
- `nice -n 10 env HOME="$(mktemp -d /tmp/rq-reb12-test.XXXXXX)" npm run test:ci -- test/fleet-filler-yield.test.ts test/fleet-lane-yield.test.ts test/fleet-supply.test.ts`:
  before repair 21 pass/3 fail; after repair 24 pass/0 fail.
- `nice -n 10 npm run lint`; `nice -n 10 npm run typecheck`: initial attempts failed
  because ESLint internals and tsgo were missing.
- `nice -n 10 npm run install:worktree`: passed; repaired dependencies without manifest changes.
- `nice -n 10 npm run typecheck`: passed backend and web.
- `nice -n 10 npm run lint`: retried after dependency repair; final status in BRIDGE_NOTES.md.
- `nice -n 10 node node_modules/eslint/bin/eslint.js src/cli/fleet-filler-yield.ts src/cli/fleet-lane-yield.ts src/cli/fleet-supply.ts src/core/fleet/jobs-ledger-dialect.ts test/fleet-filler-yield.test.ts test/fleet-lane-yield.test.ts test/fleet-supply.test.ts`: passed.
- `nice -n 10 env HOME="$(mktemp -d /tmp/rq-reb12-test.XXXXXX)" npm run test:ci -- test/fleet-filler-yield.test.ts test/fleet-lane-yield.test.ts test/fleet-supply.test.ts test/fleet-job-outcomes.test.ts test/fleet-dep-gate.test.ts test/fleet-runs-parked-unmet-deps.test.ts test/jobs-yield.test.ts test/lanes-yield-cli.test.ts test/type-entry-preservation-808s.test.ts test/contributing-verify-changed.test.ts`:
  123 pass/2 fail. Retry without the documentation module: 120 pass/1 timeout.
- Baseline: `git archive HEAD` extracted into a temporary directory with only a
  node_modules symlink; `nice -n 10 npm run test:ci -- test/fleet-job-outcomes.test.ts test/contributing-verify-changed.test.ts`, temporary HOME: 11 pass/2 fail, reproducing both failures.
- `nice -n 10 env HOME="$(mktemp -d /tmp/rq-reb12-verify.XXXXXX)" node scripts/verify-changed.mjs`:
  passed once, foreground. No verifier rerun or protected-baseline regeneration.
- `nice -n 10 npm run check:docs`: passed, zero errors.
- `nice -n 10 npm run lint:realio-lane`; `nice -n 10 npm run lint:verse-sync-io`:
  final results in BRIDGE_NOTES.md.
- `git diff --check`: passed. `git diff --cached --stat`: empty.
- `ps -Ao pid,ppid,etime,comm`: denied by the environment while inspecting long checks;
  no process details or environment values were read.

Python scripts extracted the original three regression additions from the PR
diff, edited the four implementation files, added six parser cases and wrote
the contract/report files. Scoped rg/sed/cat reads inspected repository files
and temporary verification logs. No repository-wide or home-directory scan ran.
No commit, push, rebase, merge commit, tag, publish, release, PR creation,
closure, comment, auto-merge change or live install command ran.
