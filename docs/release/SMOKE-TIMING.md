# Desktop release smoke timing

This page tracks the duration and pass rate of the `Desktop release smoke` job
(`release-build` in [the CI workflow](../../.github/workflows/ci.yml)). It
records the baseline before RQ-RELEASE-ISOLATED-BUILD-1 and appends each later
release smoke so the next five are measured with the same method.

## Method

- Source: GitHub Actions REST API job records for `ci.yml` runs with event
  `workflow_dispatch` or `schedule` (the `Desktop release smoke` job is skipped on
  every other event). Each row is the latest attempt's job, from `started_at` to
  `completed_at`.
- An eligibility no-op is not a smoke: a green job that built, downloaded and
  smoked nothing (no eligible push CI yet) is excluded. One baseline-window run
  was excluded for that reason: 42580805064 (17 s).
- Median and p95 use linear interpolation between ranks, the same method as the
  CI Efficiency measurement.
- Refresh: `node scripts/release-smoke-timing.mjs list --limit 10` prints the
  newest ten. `node scripts/release-smoke-timing.mjs append` adds newer runs to
  the tracked table below. Both read through `gh api` and never write to GitHub.

## Baseline: last 10 release smokes before the change

Read from the public API on 2026-11-10 at about 03:30 UTC.

| Run | Job started (UTC) | Event | Ref | Commit | Input | Seconds | Result | Failed step |
|---|---|---|---|---|---|---:|---|---|
| [42737802873](https://github.com/ashlrai/phantom/actions/runs/42737802873/attempts/1) | 2026-11-10T01:43:51Z | schedule | master | `62e2cea98a` | built | 390 | failure | 11: Build unsigned desktop and original package once |
| [42728489451](https://github.com/ashlrai/phantom/actions/runs/42728489451/attempts/1) | 2026-11-10T00:28:12Z | workflow_dispatch | master | `2eba5f2331` | built | 413 | failure | 11: Build unsigned desktop and original package once |
| [42702755433](https://github.com/ashlrai/phantom/actions/runs/42702755433/attempts/1) | 2026-11-09T21:28:28Z | workflow_dispatch | v3.30.28 | `5d9e9350bc` | built | 450 | failure | 12: Capture original immutable input custody |
| [42641808027](https://github.com/ashlrai/phantom/actions/runs/42641808027/attempts/1) | 2026-11-09T15:09:59Z | workflow_dispatch | v3.30.28 | `5d9e9350bc` | built | 257 | failure | 12: Capture original immutable input custody |
| [42588329326](https://github.com/ashlrai/phantom/actions/runs/42588329326/attempts/1) | 2026-11-09T08:46:18Z | workflow_dispatch | v3.30.28 | `5d9e9350bc` | built | 467 | failure | 12: Capture original immutable input custody |
| [42540893153](https://github.com/ashlrai/phantom/actions/runs/42540893153/attempts/1) | 2026-11-09T00:34:29Z | schedule | master | `3f63ab182a` | built | 458 | success |  |
| [42521331240](https://github.com/ashlrai/phantom/actions/runs/42521331240/attempts/1) | 2026-11-08T20:40:54Z | schedule | master | `f6c706dd95` | built | 392 | success |  |
| [42498509763](https://github.com/ashlrai/phantom/actions/runs/42498509763/attempts/1) | 2026-11-08T16:10:36Z | schedule | master | `6e1fcc4b6f` | built | 257 | success |  |
| [42466747879](https://github.com/ashlrai/phantom/actions/runs/42466747879/attempts/1) | 2026-11-08T09:20:34Z | schedule | master | `9fe880bb9a` | built | 380 | failure | 16: Smoke desktop release artifact |
| [42335580261](https://github.com/ashlrai/phantom/actions/runs/42335580261/attempts/1) | 2026-11-07T03:47:45Z | workflow_dispatch | master | `36c73f8387` | built | 401 | success |  |

Baseline: pass 4/10, median 396.5 s, p95 462.9 s.

The CI Efficiency measurement reported the same median and p95 but 5/10
passes. The job records above show four green attempts. Every one of the ten
attempts built from source. The last reuse of an existing immutable build was
run 42321514764 (92 s). Earlier reuse runs took 48 to 95 s.

Where the time went, as medians over the same ten jobs:

| Step | Median | Note |
|---|---:|---|
| Build unsigned desktop and original package once | 315 s | npm ci, full JS build, Bun SEA, debug Tauri bundle, pack |
| Post Cache native compiler inputs | 25.5 s | Saved a new commit-keyed cache on every green run (4 of 4) |
| Smoke desktop release artifact | 12 s | 5 runs reached it |
| Set up Rust / Set up Node / Install pinned build tools | 9 / 7.5 / 5 s | Sequential |
| Cache native compiler inputs (restore) | 1 s | 0 to 1 s in 8 of 10 jobs: no usable entry restored |

Failure causes in the baseline:

- Two failures at step 11 were the "source changed after build" drift. `npm run build`
  ran `scripts/generate-docs-llms.mjs`, which rewrote the tracked `docs/llms.txt`
  whenever a docs page had merged without regenerating it.
- Three failures at step 12 were tag-vs-master custody on `v3.30.28`. #4577
  fixed this by admitting the ancestor stable tag in `producerRef`.
- One failure was in the smoke step itself (run 42466747879).

## Changes measured by the tracked runs

- The build no longer writes any tracked file. `docs/llms.txt` is
  regenerated and committed. [`scripts/build-outputs.mjs`](../../scripts/build-outputs.mjs)
  lists every in-tree build output, and `test/build-outputs.test.ts` proves each
  one is gitignored and untracked.
- Build, custody capture and smoke run in a detached worktree of the pinned
  commit, created by [`scripts/release-isolated-tree.mjs`](../../scripts/release-isolated-tree.mjs).
  `verify` runs after the build and again after pack. It fails on any tracked
  change (`git diff --exit-code <sha>`, worktree and index), any unignored file,
  any hidden index flag, or any undeclared ignored output.
- The native cache key is the `Cargo.lock` hash without the commit. An exact
  hit skips the post-job save (median 25.5 s above), and runs no longer evict
  each other's entries.
- The pinned npm and Tauri CLI install runs in the background while Bun, Rust
  and the cache restore (about 5 s). The smoke step runs the native launch and
  the updater feed read concurrently. Fail-fast step timeouts: build 45 min,
  tool install 5 min, smoke 6 min.
- Attest, sign, notarize and secret gates are unchanged. Attestation already
  downloads the qualified artifact and never rebuilds.

## Tracked release smokes after the change

<!-- smoke-timing:tracked:start -->
| Run | Job started (UTC) | Event | Ref | Commit | Input | Seconds | Result | Failed step |
|---|---|---|---|---|---|---:|---|---|

Tracked 0 of the next 5 release smokes: pass 0/0, median n/a, p95 n/a.
<!-- smoke-timing:tracked:end -->
