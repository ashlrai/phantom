# Mac bridge dependency preparation

`scripts/bridge-worktree.mjs` prepares dependencies in an existing, trusted
worktree. It uses only Node builtins and a small native `clonefile(2)` worker;
it does not install packages, start an agent, or change sandbox policy.

```sh
node scripts/bridge-worktree.mjs /path/to/installed-checkout /path/to/worktree
# {"method":"apfs-clone","durationMs":123}
```

Both checkouts must have byte-identical `package.json` and dependency lockfiles.
Present package-manager configuration must also match. The source must contain
a real `node_modules` directory and the target must not already have one. The
source installation must be kept stable during preparation. A mismatch requires
a separate install, rather than reuse of potentially incompatible dependencies.

On macOS the helper calls native `clonefile` for individual files and symbolic
links, preserving relative `.bin` links and executable modes. Individual calls
allow interruption between entries in a large tree. This avoids both macOS
`cp -c`'s silent byte-copy fallback and Node's unsupported clone flag on macOS.
The worker prefers Python at fixed Homebrew paths, then `/usr/bin/python3`,
using isolated mode (`-I`). It never installs or resolves an interpreter from
`PATH`. Missing Python, unsupported filesystems, and the five-second worker
deadline select the symlink fallback.

The fallback shares the source dependency directory, including writes. Use it
only for trusted bridge checkouts; do not use it as a sandbox boundary. Do not
run dependency installers or remove the source installation while linked
worktrees are in use. APFS clones isolate subsequent file writes.

Preparation refuses less than 20 GiB of available disk space, and checks again
before and after publishing the prepared directory. Unknown disk state fails
closed. The floor is fixed, with no environment override. Concurrent unrelated
disk use can still consume space between checks; this helper is not a volume
reservation service.

Distinct target worktrees have independent staging directories and locks.
Duplicate preparation of the same target fails immediately. Failed operations
remove only their own staging/output. If the process is killed before cleanup,
the target's `.bridge-dependencies.lock` intentionally blocks reuse: first
verify the owning launch and clone worker have exited, then remove that target's
orphan lock/staging directory. Never reap a lock solely because it is old.

`durationMs` includes validation, clone/fallback, and cleanup. It does not
include Git checkout or agent startup. A clone deadline does not impose a hard
deadline on filesystem cleanup or a host whose I/O is stalled.

## Bridge integration boundary

The Mac bridge's active `launch.sh` and `queue.v1` station schema are external
to this checkout. The helper does not replace that launcher. Its caller must:

1. Preserve bridge admission, disk-floor, account, and launch safety checks.
2. Invoke dependency preparation after creating the worktree and before
   starting the existing authorized agent command.
3. Run independent launches concurrently; awaiting them in a serial shell loop
   would still serialize startup despite this helper's independent locks.
4. Record the complete launch duration using the bridge's actual `queue.v1`
   station contract, including Git checkout and readiness, with dependency
   method/timing as supporting measurements.

The focused suite exercises actual native cloning and write isolation on macOS,
deadline fallback, disk/manifest failures, cleanup, and a barrier proving that
20 preparations can enter cloning before any finishes. It does not establish
20 live bridge launches or complete-worktree readiness under 15 seconds.
