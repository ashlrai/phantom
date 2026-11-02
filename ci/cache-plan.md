# Phantom dependency cache handoff

CI Efficiency owns workflow integration. This is a proposed additive cache plan, not a change to test selection or required checks. The default branch is `master`; references to main-branch saves below mean pushes to `master`. GitHub makes default-branch caches available to eligible PR and tag runs, subject to cache scope, runner OS, architecture and key matching. A changed lockfile, toolchain or platform can legitimately miss. See [GitHub cache scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

| Cache | Paths | Key inputs |
| --- | --- | --- |
| npm | `~/.npm` | OS, architecture, root `package-lock.json` hash |
| Bun, when a Bun lockfile exists | `~/.bun/install/cache` | OS, architecture, `bun.lock` hash |
| Cargo | `~/.cargo/registry`, `~/.cargo/git`, `desktop/src-tauri/target` | rust-cache's OS, architecture, installed Rust toolchain, Cargo manifests, lockfiles and configuration, plus `desktop/src-tauri/Cargo.lock` hash |

The root npm job below covers the root install. The independent `src/raycast/package-lock.json` and `examples/universe-site/package-lock.json` require separate keys and installs if their jobs are cached. Do not share a root key with those installs. There is currently no tracked `bun.lock`; do not enable a Bun cache until its owning package and lockfile are present. For that package replace `bun.lock` below with its actual repo-relative path and run the install in that package directory. Never cache `node_modules`, credentials, `.npmrc`, Cargo credentials, or an entire home directory.

## Fast-lane npm caching (current)

The `quick` step in `ci.yml` uses `setup-node` with `cache: npm` for PR and merge_group runs. `setup-node` v7 manages restore and save automatically using key `npm-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('**/package-lock.json') }}`. Do not add a manual npm cache step to the quick job: it would conflict with the built-in handler and produce a stale cache key (the built-in globs `**/package-lock.json` while this plan pins to the root lockfile only).

## Default-branch npm warmer (proposed)

Add this job to the CI workflow and configure its push trigger for `master` without removing existing triggers. Mirror the OS/architecture matrix and Node version of consuming jobs. It is independent of required checks. Use the same restore step and key in consumers, without the save step or `setup-node`'s automatic npm cache. Run `npm ci` on hits as well as misses.

```yaml
cache-npm-master:
  if: github.event_name == 'push' && github.ref == 'refs/heads/master'
  strategy:
    matrix:
      os: [ubuntu-latest, macos-latest, windows-latest]
  runs-on: ${{ matrix.os }}
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        persist-credentials: false
    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
      with:
        node-version: '22'
        package-manager-cache: false
    - name: Restore npm downloads
      id: npm-cache
      uses: actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4
      with:
        path: ~/.npm
        key: npm-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}
    - run: npm ci
    - name: Save npm downloads
      if: success() && steps.npm-cache.outputs.cache-hit != 'true'
      uses: actions/cache/save@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4
      with:
        path: ~/.npm
        key: npm-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}
```

## Bun template

For a future tracked root `bun.lock`, add these steps to a trusted `master` push job after checkout and pinned Bun setup. Consumers use the identical restore step and run `bun install --frozen-lockfile`; only the trusted push job saves. No fallback key is needed. Do not enable this template with a missing lockfile: `hashFiles` would return an empty string.

```yaml
- name: Restore Bun downloads
  id: bun-cache
  uses: actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4
  with:
    path: ~/.bun/install/cache
    key: bun-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('bun.lock') }}
- run: bun install --frozen-lockfile
- name: Save Bun downloads on master
  if: success() && github.event_name == 'push' && github.ref == 'refs/heads/master' && steps.bun-cache.outputs.cache-hit != 'true'
  uses: actions/cache/save@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4
  with:
    path: ~/.bun/install/cache
    key: bun-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('bun.lock') }}
```

## Cargo integration

The existing macOS broker job explicitly excludes pushes and protects executable compilation outputs with an exact source, toolchain, SDK, image and flags identity. Do not replace or overlap its `target/debug` cache with the following generic cache: rust-cache uses fallback keys and does not provide that exact identity guarantee. Instead, for a separate native job whose cache trust policy permits rust-cache, run the same snippet after checkout and the pinned Rust setup on both the trusted master push warmer and consuming PR/tag jobs. The warmer must execute the same locked Cargo build/test commands and prepare the same Tauri fixtures as its consumer, so target artifacts are actually populated. Use matching OS, architecture, toolchain, flags and build configuration. A successful master push saves via the action's post step; PR and tag runs only restore. The cache includes registry and git dependencies and dependency artifacts in the workspace target; workspace crates and Cargo binaries are excluded by default/configuration. rust-cache computes its own composite key, including the toolchain and environment; the explicit lock hash and shared key isolate this namespace across job IDs. See [rust-cache inputs and key behavior](https://github.com/Swatinem/rust-cache/tree/401aff9a7a08acb9d27b64936a90db81024cff97).

```yaml
- name: Restore and save Rust dependencies
  uses: Swatinem/rust-cache@401aff9a7a08acb9d27b64936a90db81024cff97 # v2.8.2
  with:
    prefix-key: phantom-cargo-v1
    shared-key: desktop-native
    key: ${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('desktop/src-tauri/Cargo.lock') }}
    workspaces: desktop/src-tauri -> target
    cache-bin: 'false'
    save-if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/master' }}
```

Use a separate namespace per incompatible native build domain. Confirm the upstream action's fallback behavior and security policy before using executable cached artifacts. Keep the existing broker cache and all its validation intact until an equally strict replacement is reviewed. Do not add credentials or new tokens.

## Acceptance and rollout

Caching must not alter the classifier or drop Tier-1, security, required-check or full-suite tests. Unmapped paths, lockfiles, config and test-helper changes must retain the full-suite fallback. Verify a successful master push writes each enabled cache, then inspect restore logs on a same-key PR and tag run; check a changed lockfile and toolchain produce misses. Report cold and warm install/build wall times and cache sizes by platform, and disable a cache if transfer costs exceed savings. Cache eviction, version changes, or a first run can still cause a miss; a miss must execute the normal install and all checks.
