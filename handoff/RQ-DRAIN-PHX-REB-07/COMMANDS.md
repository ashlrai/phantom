# Commands and outcomes

All builds, tests and checks ran under `nice -n 10`. Test commands used a fresh
`test_home=$(mktemp -d /tmp/reb07-test.XXXXXX)`. The verifier used a separate
`verify_home=$(mktemp -d /tmp/reb07-verify.XXXXXX)`.

Setup/read commands:

```sh
npm install -g @ashlr/phantom
npm install -g --prefix "$phantom_recovery_prefix" @ashlr/phantom
phm docs --agent --json
phm help
phm mcp list --json
phm wire status --json
HOME="$phantom_discovery_home" "$phantom_recovery_prefix/bin/phm" docs --agent --json
HOME="$phantom_discovery_home" "$phantom_recovery_prefix/bin/phm" mcp list --json
HOME="$phantom_discovery_home" "$phantom_recovery_prefix/bin/phm" wire status --json
HOME="$phantom_discovery_home" "$phantom_recovery_prefix/bin/phm" mcp doctor --json
HOME="$phantom_discovery_home" "$phantom_recovery_prefix/bin/phm" authority status --json
HOME="$phantom_discovery_home" "$phantom_recovery_prefix/bin/phm" authority setup --dry-run --json
gh pr view 8043 --repo ashlrai/phantom --json number,state,headRefOid
nice -n 10 npm ci --ignore-scripts
```

The first install and GitHub CLI command failed on denied configuration writes
or reads. Temporary-prefix installation and dependency repair passed. Initial
host discovery attempted an OS-denied Codex config read; all later diagnostics
used temporary HOME. No wire/config command was run.

Git operations:

```sh
git fetch origin master '+refs/pull/8043/head:refs/remotes/origin/pr-8043' '+refs/pull/8042/head:refs/remotes/origin/pr-8042' '+refs/pull/8030/head:refs/remotes/origin/pr-8030' '+refs/pull/8022/head:refs/remotes/origin/pr-8022' '+refs/pull/7999/head:refs/remotes/origin/pr-7999' '+refs/pull/7992/head:refs/remotes/origin/pr-7992'
git fetch --deepen=1500 origin master '+refs/pull/8043/head:refs/remotes/origin/pr-8043' '+refs/pull/8042/head:refs/remotes/origin/pr-8042' '+refs/pull/8030/head:refs/remotes/origin/pr-8030' '+refs/pull/8022/head:refs/remotes/origin/pr-8022' '+refs/pull/7999/head:refs/remotes/origin/pr-7999' '+refs/pull/7992/head:refs/remotes/origin/pr-7992'
git fetch --unshallow origin master
git merge --ff-only origin/master
git ls-remote origin refs/heads/master
git diff --check
```

Python orchestration ran `git merge-tree --write-tree origin/master origin/pr-N`
for N=8043,8042,8030,8022,7999,7992. Initial shallow checks failed; full ancestry
then exposed the actual conflicts. Each unique temporary candidate ran
`git merge --no-commit --no-ff origin/master` at its original PR head, resolved
conflicts, then `git reset --mixed origin/master` and `git add -N` for new paths.
`git diff --binary` exported separate patches; `git apply` combined them locally.
One preview edit initially referenced an unavailable temporary ref and was
corrected before tests. Shared Git worktree creation failed with EPERM; isolated
repositories with object alternates were used. No commit or publication ran.

Focused tests, per candidate:

```sh
HOME="$test_home" ASHLR_VITEST_UNIT_MAX_WORKERS=1 nice -n 10 npm run test:ci -- test/leader-compact-brief.test.ts
HOME="$test_home" nice -n 10 npm run test:web -- src/web-ui/routes/verse/home/FleetNowPanel.test.tsx src/web-ui/routes/verse/home/HomePane.test.tsx src/web-ui/routes/verse/home/HomePane.board.test.tsx --maxWorkers=1 --no-file-parallelism
HOME="$test_home" ASHLR_VITEST_UNIT_MAX_WORKERS=1 nice -n 10 npm run test:ci -- test/fleet-now-route.test.ts test/leader-compact-brief.test.ts
HOME="$test_home" nice -n 10 npm run test:web -- src/web-ui/routes/verse/fleet/FleetNowCard.test.tsx src/web-ui/routes/verse/sections/FleetSection.test.tsx --maxWorkers=1 --no-file-parallelism
HOME="$test_home" ASHLR_VITEST_UNIT_MAX_WORKERS=1 nice -n 10 npm run test:ci -- test/jobs-family-stops.test.ts test/recut-check.test.ts test/jobs-empty-apply.test.ts test/queue-autofill.test.ts test/fleet-self-tick.test.ts
HOME="$test_home" ASHLR_VITEST_UNIT_MAX_WORKERS=1 nice -n 10 npm run test:ci -- test/authority-tier1-closure-310b.test.ts
HOME="$test_home" ASHLR_VITEST_UNIT_MAX_WORKERS=1 nice -n 10 npm run test:ci -- test/jobs-family-stops.test.ts
```

Integration and final checks:

```sh
HOME="$test_home" ASHLR_VITEST_UNIT_MAX_WORKERS=1 nice -n 10 npm run test:ci -- test/jobs-family-stops.test.ts test/recut-check.test.ts test/jobs-empty-apply.test.ts test/queue-autofill.test.ts test/fleet-self-tick.test.ts test/leader-compact-brief.test.ts test/fleet-now-route.test.ts
HOME="$test_home" nice -n 10 npm run test:web -- src/web-ui/routes/verse/home/FleetNowPanel.test.tsx src/web-ui/routes/verse/home/HomePane.test.tsx src/web-ui/routes/verse/home/HomePane.board.test.tsx src/web-ui/routes/verse/fleet/FleetNowCard.test.tsx src/web-ui/routes/verse/sections/FleetSection.test.tsx --maxWorkers=1 --no-file-parallelism
HOME="$verify_home" ASHLR_VITEST_UNIT_MAX_WORKERS=1 nice -n 10 node scripts/verify-changed.mjs
nice -n 10 npm run typecheck
nice -n 10 npm run lint
nice -n 10 npm run lint:realio-lane
nice -n 10 npm run lint:verse-sync-io
nice -n 10 npm run check:docs
nice -n 10 node --import tsx scripts/generate-cli-reference.ts
nice -n 10 node --import tsx scripts/generate-cli-reference.ts --check
nice -n 10 node node_modules/eslint/bin/eslint.js test/jobs-family-stops.test.ts
nice -n 10 perl .github/tests/secret-shape/scrub.pl --check --allow-fixtures < /tmp/RQ-DRAIN-PHX-REB-07/candidate.diff
nice -n 10 gitleaks stdin --redact --no-banner --report-format json --report-path /tmp/RQ-DRAIN-PHX-REB-07/gitleaks.json < /tmp/RQ-DRAIN-PHX-REB-07/candidate.diff
```

Scoped ESLint also ran over each candidate's changed TypeScript files; the
foreground verifier independently checked every changed TypeScript path.
Commands redirected verbose output into the temporary job's per-PR logs.
No xcodebuild, release, publish, push, force-push, merge-queue override or live
installation command was run. No new PR was opened.
