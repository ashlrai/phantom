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
