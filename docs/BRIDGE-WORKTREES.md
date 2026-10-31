# Mac bridge disk lifecycle

The bridge wrappers in `scripts/bridge/` provide dependency preparation,
per-repository Cargo targets, publication cleanup, and disk accounting for
trusted local worktrees. They do not publish packages, create PRs, acquire
credentials, or change agent admission. The owning scheduler retains those
responsibilities and must invoke these boundaries.

## Launch

After the existing bridge creates a linked Git worktree and admits its job:

```sh
sh scripts/bridge/launch.sh \
  --source /path/to/installed-checkout --worktree /path/to/job-worktree \
  --job RQ-EXAMPLE -- /absolute/path/to/existing-authorized-agent arg1 arg2
```

The command runs in the worktree and inherits the existing environment with
`CARGO_TARGET_DIR` set to `~/.ashlr-runs/repos/<repo-key>/target`. The key hashes
the canonical Git common directory: linked worktrees share a target; separate
repositories do not. `CARGO_BUILD_BUILD_DIR` is removed so that inherited
intermediate-output overrides cannot silently bypass accounting. Explicit
`cargo --target-dir` or command-local overrides must not be used by the bridge.
Real `CARGO_HOME` and `RUSTUP_HOME` are preserved.

For Node projects, source and target manifests/lockfiles must match. The
dependency helper from RQ-MAC-WTCLONE clones files through macOS `clonefile(2)`.
This supplies APFS copy-on-write semantics without `cp -c`'s possible ordinary
copy fallback. Launch uses `--require-clone`: unsupported filesystems, clone
errors, and clone deadlines refuse launch, clean partial output, and never
fall back to a full copy or shared writable symlink. The standalone helper
retains #963's opt-in caller compatibility:

```sh
node scripts/bridge-worktree.mjs --require-clone SOURCE_CHECKOUT TARGET_WORKTREE
```

The source installation must remain stable while cloning. Clones preserve
executable modes and relative package links, and isolate subsequent writes.
The helper requires matching root package-manager inputs; it does not install
or independently validate nested workspace dependency graphs.

## Disk budget and leases

Launch refuses below 20 GiB free and stops its command on a detected floor or
target-cap breach. The shared target defaults to an 8 GiB cap; pass
`--target-cap-bytes N` to lower it (raising above 8 GiB is refused). A stale
over-cap cache is cleared before launch only under an exclusive repository
lease. Concurrent launches hold shared leases, so they can overlap. Publication
clears the target immediately when no launch holds a lease; otherwise it writes
a pending cleanup record for the idle reaper.

The supervisor samples once per second, plus the time taken by `du` (bounded
at 60 seconds). This is a monitored cap, not a filesystem quota: rapid writes
or unrelated disk consumers can overshoot between samples. Failed/unknown
target measurements refuse operation. Cleanup never removes a target held by
a cooperating launch. Bridge children inherit the worktree and Cargo lease
descriptors, retaining the locks if the supervisor is killed. Commands must
remain in their foreground process group and preserve inherited leases;
daemonizing or deliberately closing those descriptors is outside this trusted
bridge contract. The wrapper stops its owned group before releasing its leases.

## Publication completion and reaping

Stop all worktree writers, successfully publish through the existing authorized
publisher, then obtain fresh PR metadata through Locus. Write a JSON file:

```json
{"url":"https://github.com/ashlrai/phantom/pull/123","head_oid":"<full published commit SHA>","observed_at":1793000000}
```

`observed_at` is the Unix time of the successful remote lookup. The bridge must
not refresh timestamps without another lookup. This is trusted caller evidence,
not an independently authenticated publication receipt. Repository, local HEAD,
and freshness (five minutes) are checked before cleanup. From a directory
outside the worktree being removed, immediately invoke:

```sh
sh scripts/bridge/publish.sh --worktree /path/to/job-worktree \
  --job RQ-EXAMPLE --publication /path/to/fresh-publication.json
```

Only worktrees prepared by this lifecycle, with the matching private run receipt,
are eligible. Main/current/locked worktrees, tracked changes, hidden index
entries, submodules, active leases, replaced dependency trees, and mismatched
publication evidence retain the worktree. Cleanup deletes only the exact
dependency directory cloned by this run (device/inode identity and absence of
tracked files are checked). All remaining untracked **and ignored** files,
including old unmanaged target directories, move atomically to a unique
`~/.ashlr-runs/quarantine/<job>-<id>/` directory, preserving relative names and
symlinks. Quarantine must be on the same filesystem; it is never automatically
expired or deleted. It preserves data but does not reclaim those bytes.

After another head/cleanliness check, cleanup uses plain `git worktree remove`
and `git worktree prune`. It never uses force, deletes branches, or discards
tracked changes. Partial failures leave quarantine recoverable; post-removal
cleanup failures are distinguished from retained worktrees in the log.

Call the reaper in the scheduler's `finally` block on every cycle, including
idle and failed dispatch cycles. With fresh `--publication` it retries the same
worktree completion flow. Without it, it retries deferred Cargo target cleanup:

```sh
sh scripts/bridge/reaper.sh --worktree /path/to/existing-checkout --job cycle
```

The `--worktree` here supplies the volume measurement path. All wrappers accept
`--state-dir` for isolated qualification. They do not replace the existing
scheduler, queue schema, publisher, or #970's test-HOME isolation.

## Measurements and acceptance

Each run appends JSON lines to `~/.ashlr-runs/disk.log` before launch and at
completion/refusal, and before/after publication cleanup. Entries include volume
free/used bytes plus `du -sk` attribution for the worktree, node_modules,
worktree targets, shared target, and quarantine. Missing measurements are null.
APFS shared extents are counted again by `du`; volume free-byte deltas measure
physical growth. Attribution categories overlap and must not be added together.
No environment values, command arguments, file contents, or Git stderr are logged.

For a manual snapshot in an existing linked worktree:

```sh
python3 -B scripts/bridge/disk.py measure --worktree /path/to/job-worktree --job audit
# Attribute all registered worktrees of that repository (read-only du scan):
python3 -B scripts/bridge/disk.py attribute --worktree /path/to/job-worktree --job audit
```

The 20-launch acceptance must compare volume free bytes before and after twenty
actual adopted bridge launches, use a stable source installation/shared target,
retain all disk records, and require less than 5 GiB growth. Unrelated writers,
new Rust builds, and quarantine growth must be attributed separately. Local
fixture acceptance proves clone/lifecycle behavior, not twenty authenticated
production launches. Historical loss cannot be reconstructed from a single
current snapshot; retain measurements over the incident interval.

Run the focused suites with isolated HOME (preserve real toolchain homes if
extending these tests to invoke Cargo):

```sh
HOME=$(mktemp -d) npx vitest run test/bridge-worktree.test.ts
HOME=$(mktemp -d) python3 -B -m unittest discover -s scripts/bridge -p 'test_*.py' -v
# Native APFS fixture: 20 launches with a 320 MiB dependency payload each.
HOME=$(mktemp -d) python3 -B scripts/bridge/acceptance.py --report /tmp/bridge-disk-acceptance.json
```
