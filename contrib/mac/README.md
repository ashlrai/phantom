# Job outcome reconciliation

Run `./contrib/mac/metrics-outcomes reconcile --jobs /path/to/jobs.jsonl` before
reading the outcome metrics. This requires Python 3 and an existing authenticated
`gh` installation. It creates no tokens and does not publish or merge PRs.
Account access must be commissioned through Locus by the operator.

The ledger must already exist. Each publication is a JSON object with
`outcome: "PUBLISHED"`, a string `jobId`, and a `prUrl` containing the full base
repository GitHub PR URL. The legacy names `status`, `job` (or `id`), and `pr`
are also accepted. Other routing metadata is preserved. Blank lines are ignored;
malformed JSON refuses reconciliation without repairing or truncating the ledger.

Each unique job and PR is resolved with `gh pr view URL --json
state,mergedAt,closedAt`. Fork heads and squash merges need no special inference:
the PR's state is authoritative. Open PRs produce no outcome. Terminal events
retain the publication's field names, set `ts` to GitHub's merge or close time,
and include `mergedAt` or `closedAt`, `reconciledAt`, and a reconciler `source`.
Thus a historical backfill belongs to the actual merge/close window rather than
the time the repair ran. Existing MERGED or CLOSED job/PR pairs are never appended
again. This command reconciles published jobs only, not every PR in a repository.

A sibling `jobs.jsonl.reconcile.lock` serializes reconciler processes. Each append
is flushed and synced. Other ledger writers should use the same advisory lock
when appending to avoid racing reconciliation. The command rereads the ledger
before each lookup/append, preserves all original bytes and adds a missing final
newline. It never rewrites historical events. Keep the lock file in place.

Failures produce a nonzero exit and a count in the JSON summary; successful PRs
still reconcile. Failed and open PRs are retried next run. Diagnostics omit raw
GitHub output to avoid exposing credential-helper messages. A malformed ledger
or unavailable executable also fails closed. No live GitHub lookup is needed for
the fixture suite:

```sh
HOME=$(mktemp -d) python3 -B -m unittest discover -s contrib/mac/tests -v
```

# PR titles for the bridge publisher

`contrib/mac/pr-title.sh` prints one `type(scope): summary` line at or under 72
characters for a job's pull request, or the job id when no better source
resolves. It never contacts GitHub and never fails after argument validation.
Set `PHANTOM_ROOT` to this checkout. In the external `~/.ashlr-runs/bin/publish.sh`,
keep the job id in the PR body (the existing `Automated bridge job \`$J\`` line)
and replace the literal `--title` argument with:

```bash
title=$(bash "$PHANTOM_ROOT/contrib/mac/pr-title.sh" "$J" "$R/$J.job-line" "$R/$J.diff")
gh pr create --repo "$REPO" --head "masonwyatt23:$BR" --base "$DEF" --title "$title" --body-file "$R/$J.body.md"
```

`$R/$J.job-line` is the router queue line the publisher already reads;
`$R/$J.diff` is optional — write `git diff "$BASE" "$TREE"` there before the
title call to let a loopback-only local model summarize the diff instead
(`PR_TITLE_MODEL`/`PR_TITLE_MODEL_URL` configure the endpoint; the model answer
is sanitized to one printable line and any error falls back to the router-line
title, then to the job id). The helper's own extraction drops the `JOB (meta):`
envelope and a leading `VISION` marker, keeps the first task sentence, infers a
conventional type, and scopes from `repo=`. Host deployment of the changed
`publish.sh` stays an owner step under the security pin.

Verification:

```sh
HOME=$(mktemp -d) npx vitest run test/pr-title.test.ts test/publish-sh-title.test.ts
```

# Mac bridge worktree disk pruning

`wt-prune.sh` reclaims ignored build directories from finished and kept but idle
Git worktrees physically under `~/.ashlr-runs`. Install it next to the #1066
queue scripts. It needs Bash 3.2+, Python 3.9+, Git, and macOS `lsof` (Linux
uses `/proc`). No credentials or network access are needed.

```sh
bash contrib/mac/test-wt-prune.sh
contrib/mac/wt-prune.sh --dry-run
```

The only removable directories are `target/`, `node_modules/.cache/`, `.turbo/`
and `dist/`, including those in nested packages such as `desktop/src-tauri/`.
Dependencies outside `.cache` remain installed. All candidates must be ignored
by repository Git rules and contain no tracked or unignored files, symlinks,
hardlinked files, special files, mount crossings, or nested repositories.

A worktree is eligible only when **every descendant's modification and change
timestamps are at least 20 minutes old**, no process has its cwd inside, and
the bridge's worktree lease and owner claim allow it. The pruner uses the same
persistent `locks/SHA256(canonical_worktree).lock` flock as the bridge and
never overwrites its metadata. Live owner or supervisor PIDs veto cleanup even
after moving cwd. Invalid claims and failed inspections preserve the worktree.
Launchers must acquire this same lease before reusing a kept worktree.

`~/.codex*`, `~/.ashlr-runs/queue`, symlinked run roots/worktrees, and worktrees
outside the run root are excluded. Sidecar paths cannot expand the boundary.
Run from outside a candidate worktree: the invoking shell's cwd also counts as
live. This is artifact cleanup, never `git worktree remove` or branch deletion.

## WT_REMOVED and the 30-minute sweep

This checkout does not contain the deployed `launch.sh`, `publish.sh`, or event
dispatcher. The adapters below are installation steps for that external bridge;
adding these files alone does not activate a service. No launcher, publisher,
release configuration, or CI configuration is changed by this contribution.

Copy `wt-prune.sh` and `wt-prune.py` together to the bridge directory, then run
`wt-prune.sh --dry-run` before enabling cleanup. At the existing `WT_REMOVED`
handler, after releasing the worktree lease and leaving its cwd, invoke:

```sh
"$BRIDGE_DIR/wt-prune.sh" --event WT_REMOVED
```

This sweeps remaining finished and kept worktrees. An optional absolute path
restricts the sweep to one worktree:

```sh
"$BRIDGE_DIR/wt-prune.sh" --event WT_REMOVED "$REMOVED_WORKTREE"
```

An event is a trigger, never an exemption from the safety checks. An already
removed path is a no-op. Directories lacking Git metadata cannot be qualified
and are preserved. Older launchers storing worktrees under `Projects/.../wt`
are outside this task's boundary and are preserved.

For periodic cleanup, install **one** of these options (off until installed):

```sh
# crontab: substitute the installed absolute script and log paths.
*/30 * * * * /path/to/mac-bridge/wt-prune.sh >> /path/to/wt-prune.log 2>&1

# Or supervise this process; it sweeps immediately, then every 1800 seconds.
/path/to/mac-bridge/wt-prune.sh --watch
```

Both modes accept `--dry-run`. The dry run inspects artifacts without deleting
them; it can create persistent lease files needed for coordination. Overlapping
event and periodic runs skip busy worktrees. A failed global inspection exits
nonzero; `--watch` retries at its next interval. Individual unsafe worktrees
increase `held` without blocking other worktrees. Logs contain counts only:

```text
WT_PRUNE freed_bytes=8192 would_free_bytes=0 removed=1 held=0
```

`freed_bytes` sums allocated file blocks successfully removed, and dry runs
always report zero there with an estimate in `would_free_bytes`. APFS clones,
snapshots, compression and directory metadata can make physical free-space
changes differ. No paths, process arguments, environment values or secrets are
printed. Partial failures retain a conservative successful-removal count.

## Optional shared Rust builds for launch.sh

These environment options are **flag-off by default**. Add this opt-in block
to the externally managed launcher before it starts the agent. `REPO` here is
the launcher's validated repository slug (for example `phantom`), shared by
that repository's worktrees, never a job or branch name.

```sh
if [ "${ASHLR_SHARED_CARGO_TARGET:-0}" = 1 ]; then
  case "$REPO" in ''|*[!A-Za-z0-9_.-]*|.|..) exit 2;; esac
  export CARGO_TARGET_DIR="$HOME/.cache/ashlr/cargo-target/$REPO"
  mkdir -p "$CARGO_TARGET_DIR"
fi
if [ "${ASHLR_SCCACHE:-0}" = 1 ]; then
  command -v sccache >/dev/null 2>&1 || exit 2
  export RUSTC_WRAPPER=sccache
fi
```

Enable either flag only for launches that should use it, for example:

```sh
ASHLR_SHARED_CARGO_TARGET=1 ASHLR_SCCACHE=1 /path/to/launch.sh JOB phantom POOL
```

Install `sccache` separately before opting in. No installation, credential,
remote cache or provider configuration is performed here. Cargo serializes
concurrent builds sharing a target directory; this saves disk and repeated
compilation at the cost of possible build-lock waits. Keep different repositories
in separate target directories. Shared output and the optional sccache cache
live outside `~/.ashlr-runs` and are never pruned by this helper. Existing
caller-provided Rust environment settings are unchanged when the flags are off.
