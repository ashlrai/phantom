# Mac bridge recovery helpers

These Bash 3.2 helpers integrate with the operator's external bridge scripts.
Those scripts are not tracked in this repository. They need Git and an existing
Locus-authorized `gh` context, with credentials supplied through Phantom Secrets
when needed. They do not acquire tokens, switch accounts, push, or merge.

## Two hook lines

Set `PHANTOM_ROOT` to this checkout. Replace the existing PR creation in
`publish.sh` and worktree creation in `launch.sh`, respectively, with:

```bash
bash "$PHANTOM_ROOT/contrib/mac/pr-create.sh" "$repo" "$fork:$branch" "$base" "$title" "$body_file" || exit $?
bash "$PHANTOM_ROOT/contrib/mac/worktree-add.sh" "$repo_dir" "$job" "$worktree" "$start_ref" || exit $?
```

Map these variable names to the bridge's existing values. `repo` is the bare
repository name (for example, `phantom`) under `ashlrai`; `fork` is the head
owner login; `branch` is the already-pushed head branch. Pass an explicit base,
title, and readable body file. The PR helper prints only the created or reused
PR URL to stdout. Diagnostics go to stderr, without replaying raw CLI errors.
Retain the publisher's existing push, validation and approval gates around this
replacement. A successful URL does not establish CI or mergeability.

The PR helper first runs `gh pr list --head fork:branch`. Because
[gh documents qualified heads as unsupported](https://cli.github.com/manual/gh_pr_list),
an empty or failed lookup is checked with REST GET using the exact head and base.
Lookup failures stop creation. Existing open PRs are reused, including after an
ambiguous create failure. Only HTTP 5xx or GraphQL timeout errors retry
`gh pr create`, for three total attempts, with 2s and 4s backoff. After those
failures it checks again, then makes one REST POST to
`/repos/ashlrai/<repo>/pulls` through `gh api`, preserving title and body.
Permanent errors stop; a failed POST is reconciled with a lookup, never repeated.
Concurrent publishers can still race between lookup and creation; GitHub's
duplicate-head rejection is reconciled by the same lookup.

`job` is a single branch component; the launch helper creates
`codex-bridge/<job>` at `start_ref` (for example, `origin/main`). If normal
`git worktree add -b` fails specifically because that branch exists, the helper
checks NUL-delimited worktree porcelain records. Only an unused branch may be
reset with `-B`. Any registered worktree, including locked or missing paths,
blocks reuse. Recovery also refuses an existing destination, even an empty
directory: older Git can reset `-B` before reporting an occupied path. Nothing
is pruned and `--force` is never used. Recovery reserves the destination with
`mkdir` before `-B`, so its parent must already exist and be writable. If Git
subsequently fails, only that empty directory is removed; inspect any partial
worktree and the branch tip before retrying. An unused stale
branch's tip is intentionally reset to `start_ref`; retain valuable commits
elsewhere before relaunching that job. Paths can contain spaces or newlines.

## Local verification

```bash
bridge_test_home=$(mktemp -d)
HOME="$bridge_test_home" node --test contrib/mac/bridge.test.mjs
```

The tests use fake `gh` and `sleep` executables and disposable Git repositories.
They never contact GitHub or use the operator's credentials. The helper scripts
are invoked with `bash`, so no installation or executable-bit change is needed.
