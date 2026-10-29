# Inner loop research

This note records how long the edit-to-verified-result loop takes today in seven public Ashlr repos, and ranks the changes most likely to bring a typical edit under 5 seconds. Every timing below was measured on this VM on 2026-10-26, or it is quoted from a linked source and marked as such. This pull request adds this note only. It does not change code, CI, workflows, or package files.

A loop under 5 seconds is local feedback. The merge gate stays the existing CI for each repo. No test set is dropped on the way to a green merge. Tier-1 and security tests still run before merge. Where a repo already has a local gate that keeps those tests, the plan keeps that gate.

## Machine

| Item | Value |
| --- | --- |
| Date | 2026-10-26 |
| CPU | 4 cores, 1 thread per core, Intel Xeon (family 6, model 173), KVM |
| Cache | L3 480 MiB |
| Memory | MemTotal 16387280 kB |
| OS | Linux 6.12.94+ |
| Node | v22.23.4 |
| bun | 1.4.4 |
| hyperfine | 1.19.0 |
| mold | 2.30.0 (apt) |
| cargo-nextest | 0.9.149 |
| rustc stable | 1.99.1 (58cf8f9c3, 2026-10-13), used for locus and ashlr-md |
| rustc 1.95.0 | phantom-secrets `rust-toolchain.toml` |
| rustc nightly | 1.101.0-nightly (76456a688, 2026-10-25), Cranelift preview installed |

`rustc` 1.99.1 links with `-fuse-ld=lld` (observed by asking it to print the link line through `/bin/echo` on a one-line crate). mold was compared with that default, not with GNU ld.

Candidate tools installed outside the repos, under `/tmp/tools`: TypeScript 7.0.2 (the native `tsc`), oxlint 1.89.0, Biome 2.6.3, esbuild 0.25.11, Rolldown 1.2.15, `@swc/core` 1.15.3. Project compilers, measured from each repo's `node_modules`: phantom 5.9.3, lexicon 7.0.2, ashlr-md 5.8.3, ashlr-stack 5.9.3, ashlr-plugin 5.9.3. ashlr-stack's own Biome is 1.9.4. ashlr-md's own Biome is 2.4.16.

## Revisions

Phantom timings were taken at `6de63815` (2026-10-25, "feat(run): route governed clients through an opted-in gateway"). `origin/master` then gained `9b8804c1`, which only declares `esbuild` and `@eslint/js` as direct dependencies. This note sits on that commit. The phantom commands were not re-run after it.

| Repo | SHA | Commit time |
| --- | --- | --- |
| ashlrai/phantom | `6de63815` (timings) | 2026-10-25 21:43 -0400 |
| ashlrai/phantom-secrets | `cb72db2` | 2026-10-25 21:39 -0400 |
| ashlrai/locus | `e92247e` | 2026-10-25 21:48 -0400 |
| ashlrai/lexicon | `a57d667` | 2026-10-25 21:30 -0400 |
| ashlrai/ashlr-md | `800afb5` | 2026-10-25 21:00 -0400 |
| ashlrai/ashlr-stack | `300f65d` | 2026-10-25 21:30 -0400 |
| ashlrai/ashlr-plugin | `36e32ca` | 2026-10-25 21:34 -0400 |

The six other repos were cloned read-only. Probe comments used for the one-line edit were removed. Their worktrees were clean at the end.

## How the numbers were taken

hyperfine 1.19.0, `--warmup 1 --runs 5`, with `CI=1` and `NO_COLOR=1`. One heavy command at a time. Tables list the hyperfine mean, standard deviation, min, and max in seconds. Those rows are 5-run means.

Rows marked **one run** are a single observation: a cargo `Finished` line, a tool's own duration line, or a wall-clock bracket. They are not means.

The one-line edit stripped any previous `INNER_LOOP_PROBE` line and appended `// INNER_LOOP_PROBE <timestamp>`. Each timed run therefore changed file content. `git checkout` restored the file afterward.

"Added means" means the commands were timed separately and the means were added on paper. That sum was not timed as one pipeline.

### Files that stood in for a typical edit

Median is by line count, odd-length index `len // 2`.

| Repo | File edited | Lines | Why this file |
| --- | --- | --- | --- |
| phantom | `src/core/inbox/pending-authority.ts` | 252 | Median of `src` excluding `web-ui` and `raycast`: 1359 files, 601222 lines |
| lexicon | `src/cli/prompt.ts` | 229 | Median of `src`: 123 files, 46317 lines |
| ashlr-md web | `src/store/digestStore.ts` | 133 | Median of non-test files under `src`: 164 files, 37963 lines |
| ashlr-md Rust | `src-tauri/src/local_inference.rs` | 347 | A source file in the Tauri crate. The median of `src-tauri/src` is `export.rs` at 311 lines (34 files). The edit file is the next size up. |
| ashlr-stack | `packages/cli/src/lib/agent-preflight.ts` | 115 | Has a colocated test. The median non-site, non-test TypeScript file is `packages/core/src/providers/_api-key.ts` at 123 lines (120 files). |
| ashlr-plugin | `servers/_gateway-target.ts` | 179 | Median of `servers`: 138 files, 34125 lines |
| phantom-secrets | `crates/phantom-broker/src/protocol.rs` | 414 | Broker crate, which is the package the test filter used. The median non-test `.rs` file under `crates/` is `phantom-core/src/teams.rs` at 412 lines (179 files). |
| locus | `crates/locus-core/src/graph.rs` | 444 | Median of `locus-core` `src`: 53 files, 41681 lines |

Direct tests, where one was obvious: `test/m504.goal-direct-authority.test.ts` (phantom), `tests/review.test.ts` (lexicon), `src/store/digestStore.test.ts` (ashlr-md), `packages/cli/src/__tests__/agent-preflight.test.ts` (ashlr-stack), `__tests__/gateway-target.test.ts` (ashlr-plugin).

## Where a typical edit stands

These are the measured pieces. They are not one combined stopwatch, except where a single command is named.

| Repo | Fastest useful feedback | Relevant verify | Under 5 seconds today |
| --- | --- | --- | --- |
| phantom | TypeScript 7.0.2 backend `tsc` 3.289 s, direct vitest 1.318 s | `npm run gate` on the core file, one failing run, vitest 572.97 s for 1036 backend files | The direct test is under 5 s. A verified result for this core file is not. |
| lexicon | `npm run typecheck` 1.681 s plus one vitest file 1.153 s | `vitest related` 25.408 s | The direct path is under 5 s. The related path is not. |
| phantom-secrets | `cargo check` 1.746 s | package nextest 6.901 s, reverse-deps nextest 90.493 s | Check is under 5 s. The tests are not. |
| locus | `cargo check` 4.695 s | package nextest 28.462 s, reverse-deps nextest 44.354 s | Check is just under 5 s. The tests are not. |
| ashlr-md web | `bun run typecheck` 5.304 s | `bun run build` 21.462 s | Typecheck alone is over 5 s. |
| ashlr-md Rust | `cargo check` 1.806 s after a warm tree | package nextest after the edit 11.989 s | Check and clippy are under 5 s. Tests after an edit are not. |
| ashlr-stack | typecheck + lint + one test + cli build, added means 2.719 s | `bun test` 31.685 s | The measured cli edit is under 5 s. The full suite is not. |
| ashlr-plugin | today's `bun run typecheck` 5.155 s | full `bun run test`, one failing run, 33.53 s | Typecheck is just over 5 s. TypeScript 7.0.2 brought that command to 0.680 s. |

## Baseline

### phantom

Commands are the npm scripts unless noted. Typecheck and lint include the whole tree those scripts name.

| Step | Command | Mean | sd | min | max | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| typecheck | `npm run typecheck` (`tsc --noEmit` and the web project) | 57.204 | 1.664 | 55.159 | 59.251 | 5-run |
| lint | `npm run lint` (ESLint, then two node scripts) | 57.577 | 0.939 | 56.480 | 58.881 | 5-run |
| one test file | `npx vitest run test/m504.goal-direct-authority.test.ts` | 1.318 | 0.056 | 1.271 | 1.415 | 5-run |
| related tests | `npx vitest related --run src/core/inbox/pending-authority.ts` |  |  |  |  | warmup aborted, exit 1, wall 02:08:09 to 02:18:11 (602 s) |
| rebuild | `npm run build` |  |  |  |  | one run, exit 1, 36 s wall |
| local gate | `npm run gate` |  |  |  |  | one run, exit 1, wall 02:18:53 to 02:30:23 (690 s) |

`npm run build` got through version check, `tsc` emit, authority surface, asset copy, and `vite build` (vite printed "built in 2.17 s" in that same run). The next step, `scripts/build-release-dependency-inventory.mjs`, threw `ENOENT` on `lstat` of `/usr/lib/node_modules`. That script resolves npm beside the node binary (`trustedNpmCliPath` in that file). This VM's node is `/exec-daemon/node` and that global npm path is absent. There is no 5-run mean for a successful phantom rebuild.

`npm run gate` on the same core file is the project's own related-test loop plus the smoke set in `scripts/gate-smoke.json` (13 backend files and 8 web files). The smoke set includes `test/authority-tier1-closure-310b.test.ts`. In that one run, vitest reported backend **Test Files 4 failed, 963 passed, 69 skipped (1036)** and **Duration 572.97 s**. Web smoke passed: 8 files, 352 tests, 10.89 s. The four failing files were `test/resource-account-identity-witness.test.ts` (2 failed), `test/desktop-artifact-installer.test.ts` (5 failed), `test/m487.daemon-state-quarantine.test.ts` (1 failed), and `test/perf-server-control.test.ts` (1 failed). ESLint in that same gate printed 206 problems, 0 errors, 206 warnings. `scripts/gate.mjs` comments that `vitest related` has a fixed cost of about 40 s. That figure is a comment in the source. It is not a measurement from this VM. This file's import graph selected 1036 backend files, which is why the run took minutes.

### lexicon

Lexicon's installed TypeScript is already 7.0.2. `npm run typecheck` and `npm run lint` are that native `tsc`. Lint is `tsc -p tsconfig.json --noEmit`. Typecheck is that plus `extension/tsconfig.json`.

| Step | Command | Mean | sd | min | max | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| typecheck | `npm run typecheck` | 1.681 | 0.044 | 1.639 | 1.749 | 5-run |
| lint | `npm run lint` | 1.365 | 0.045 | 1.308 | 1.406 | 5-run |
| one test file | `npx vitest run tests/review.test.ts` | 1.153 | 0.013 | 1.135 | 1.172 | 5-run |
| related tests | `npx vitest related --run src/cli/prompt.ts` | 25.408 | 0.146 | 25.187 | 25.595 | 5-run |
| rebuild | `npm run build` (`tsc -p tsconfig.build.json`) | 0.686 | 0.026 | 0.661 | 0.727 | 5-run |

### phantom-secrets

Toolchain 1.95.0. CI already runs cargo-nextest with `scripts/ci/affected-filterset.sh`.

| Step | Command | Mean | sd | min | max | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| cold check | `cargo check --workspace --locked` |  |  |  |  | one run, cargo `Finished` in 50.60 s |
| check after the edit | `cargo +1.95.0 check --workspace --locked` | 1.746 | 0.037 | 1.720 | 1.811 | 5-run |
| clippy | `cargo clippy --workspace --all-targets --locked -- -D warnings` | 5.080 | 0.366 | 4.808 | 5.670 | 5-run |
| package tests, after the edit | `cargo nextest run -p phantom-secrets-broker --locked` | 6.901 | 0.044 | 6.837 | 6.960 | 5-run |
| package tests, no edit | same nextest command | 6.498 | 0.052 | 6.442 | 6.554 | 5-run |
| package tests, no edit | `cargo test -p phantom-secrets-broker --locked -- --test-threads=8` | 6.239 | 0.033 | 6.189 | 6.273 | 5-run |
| reverse deps | `cargo nextest run --workspace -E 'rdeps(=phantom-secrets-broker)'` | 90.493 | 0.612 | 89.943 | 91.511 | 5-run |
| workspace build | `cargo build --workspace --locked` | 3.821 | 0.290 | 3.549 | 4.275 | 5-run |
| npm wrapper | `npm test` in `npm/` | 0.520 | 0.011 | 0.504 | 0.531 | 5-run |
| npm mcp wrapper | `npm test` in `npm-mcp/` | 1.122 | 0.026 | 1.084 | 1.156 | 5-run |

Cold `cargo nextest run --workspace` compiled the test profile in 1 m 32 s (cargo `Finished` line, one run) and then started 2928 tests. That full cold run was not given its own hyperfine mean.

On a warm tree, `cargo test` of the broker package was slightly faster than nextest (6.239 s vs 6.498 s). Nextest is already the CI runner. The measured gap is not a reason to switch back.

### locus

| Step | Command | Mean | sd | min | max | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| cold check | `cargo check --workspace --locked` |  |  |  |  | one run, cargo `Finished` in 15.09 s |
| check after the edit | `cargo +stable check --workspace --locked` | 4.695 | 0.174 | 4.581 | 5.002 | 5-run |
| clippy | `cargo clippy --workspace --all-targets --locked -- -D warnings` | 6.113 | 0.158 | 5.843 | 6.227 | 5-run |
| package tests, after the edit | `cargo nextest run -p locus-core --locked` | 28.462 | 0.140 | 28.228 | 28.570 | 5-run |
| package tests, no edit | same nextest command | 17.975 | 0.123 | 17.760 | 18.053 | 5-run |
| package tests, no edit | `cargo test -p locus-core --locked -- --test-threads=8` | 22.720 | 0.183 | 22.527 | 22.936 | 5-run |
| reverse deps | `cargo nextest run --workspace -E 'rdeps(=locus-core)'` | 44.354 | 0.822 | 43.526 | 45.541 | 5-run |
| workspace build | `cargo +stable build --workspace --locked` | 9.539 | 0.155 | 9.317 | 9.749 | 5-run |
| npm tests | `node --test npm/test/no-self-exec.test.js npm/test/wrappers.test.js` | 0.142 | 0.003 | 0.138 | 0.145 | 5-run |

Cold workspace nextest compiled the test profile in 33.03 s (cargo `Finished` line, one run) and started 935 tests across 35 binaries.

`node --test npm/test` (the CI form, a directory) failed on Node 22.23.4 with `MODULE_NOT_FOUND` for the directory. The two test files above passed, 14 tests. That 0.142 s mean is the working invocation, not the CI line as written.

### ashlr-md

Web commands use the repo's bun scripts. Rust commands use `cargo +stable` with `--manifest-path src-tauri/Cargo.toml`. CI's sidecar stubs were created (`src-tauri/target/release/mdopen` and `mdopener-mcp`) before the Rust runs. The first Rust attempt failed instantly because `--manifest-path` was placed before the cargo subcommand. Those empty results are discarded. The numbers here use the corrected command.

| Step | Command | Mean | sd | min | max | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| web typecheck | `bun run typecheck` | 5.304 | 0.032 | 5.258 | 5.331 | 5-run |
| web lint | `bun run lint` (Biome 2.4.16) | 0.440 | 0.002 | 0.438 | 0.442 | 5-run |
| one web test | `bunx vitest run src/store/digestStore.test.ts` | 0.607 | 0.004 | 0.603 | 0.613 | 5-run |
| web rebuild | `bun run build` (`tsc && vite build`) | 21.462 | 1.026 | 20.755 | 23.279 | 5-run |
| vite only | `bunx vite build` | 16.364 | 0.255 | 16.165 | 16.775 | 5-run |
| cold Rust check | `cargo check --workspace --locked` |  |  |  |  | one run, cargo `Finished` in 48.23 s |
| Rust check after the edit | same check | 1.806 | 0.012 | 1.795 | 1.821 | 5-run |
| Rust clippy | `cargo clippy --workspace --all-targets --locked -- -D warnings` | 2.702 | 0.035 | 2.665 | 2.736 | 5-run |
| Rust tests, reverse deps, after the edit | `cargo nextest run --workspace -E 'rdeps(=md-opener)'` | 12.271 | 0.428 | 12.057 | 13.036 | 5-run, hyperfine reported outliers |
| Rust tests, package, after the edit | `cargo nextest run -p md-opener` | 11.989 | 0.341 | 11.537 | 12.310 | 5-run |
| Rust workspace build | `cargo build --workspace --locked` | 9.239 | 0.184 | 8.929 | 9.391 | 5-run |
| Rust tests, package, no edit | `cargo nextest run -p md-opener` | 1.836 | 0.009 | 1.823 | 1.848 | 5-run |
| Rust tests, package, no edit | `cargo test -p md-opener -- --test-threads=8` | 1.872 | 0.004 | 1.870 | 1.878 | 5-run |

CI for this repo runs `cargo check` and `cargo clippy`. It does not run nextest. The nextest rows are a candidate runner on the same tests.

### ashlr-stack

| Step | Command | Mean | sd | min | max | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| typecheck | `bun run typecheck` | 2.313 | 0.016 | 2.288 | 2.331 | 5-run |
| lint | `bun run lint` (Biome 1.9.4) | 0.224 | 0.002 | 0.223 | 0.226 | 5-run |
| one test file | `bun test packages/cli/src/__tests__/agent-preflight.test.ts` | 0.138 | 0.001 | 0.137 | 0.140 | 5-run |
| full test | `bun test` | 31.685 | 0.238 | 31.470 | 32.085 | 5-run |
| cli rebuild | `bun run --filter @ashlr/stack build` | 0.044 | 0.003 | 0.040 | 0.048 | 5-run |

The root `bun run build` (`bun run --filter '*' build`, including the site) was not timed.

### ashlr-plugin

There is no root build script. `bun run test` is `scripts/run-root-tests.ts`. The one-file command matches that script's `ASHLR_STATS_SYNC=1` and `--parallel=4`.

| Step | Command | Mean | sd | min | max | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| typecheck | `bun run typecheck` | 5.155 | 0.096 | 5.086 | 5.324 | 5-run |
| mdx lint | `bun run mdx-lint` | 0.018 | 0.000 | 0.017 | 0.018 | 5-run |
| one test file | `ASHLR_STATS_SYNC=1 bun test --parallel=4 __tests__/gateway-target.test.ts` | 0.081 | 0.001 | 0.080 | 0.082 | 5-run |
| full test | `bun run test` |  |  |  |  | one run, exit 1, bun reported 33.53 s |

That full run reported 3876 tests across 246 files: 3857 pass, 17 skip, 2 fail. `discoverProjects` expected a clean `https://github.com/acme/widget.git` remote and received the same URL with a credential injected by this environment's git rewrite. `benchmark-refs` timed out at 10000 ms after `git ls-files` failed in the test's temp repo. The suite still has to pass before merge. There is no 5-run mean.

## Candidates tried on this VM

### TypeScript and JavaScript

| Candidate | Where | Result | Kind |
| --- | --- | --- | --- |
| TypeScript 7.0.2 `tsc --noEmit` on phantom backend `tsconfig.json` | `/tmp/tools/ts7` | 3.289 s (sd 0.082), exit 0 | 5-run |
| TypeScript 7.0.2 on `src/web-ui/tsconfig.json` | same | 3.477 s (sd 0.220), exit 0 | 5-run |
| tsc 5.9.3 `--incremental` on phantom backend only | `--tsBuildInfoFile /tmp/bench/phantom.tsbuildinfo`, file toggled each run | times 20.971, 3.996, 3.966, 3.940, 3.996 | 5-run, first run cold |
| oxlint 1.89.0 `oxlint src test` | phantom | 0.358 s (sd 0.015). A separate run exited 1 with 384 warnings and 1 error | 5-run for time |
| Biome 2.6.3 `biome check src test` | phantom | 8.753 s (sd 0.024). A follow-up run reported 9011 errors, 22013 warnings, 21795 infos, and "Diagnostics not shown: 52799" | 5-run for time |
| TypeScript 7.0.2 on lexicon root tsconfig | already the project compiler | 1.318 s (sd 0.036), exit 0. Project `npm run lint` on the same project was 1.365 s | 5-run |
| oxlint `oxlint src tests` | lexicon | 0.063 s (sd 0.007) | 5-run |
| esbuild 0.25.11 bundle of `src/mcp/server.ts` | lexicon | 0.083 s (sd 0.003) | 5-run |
| Rolldown 1.2.15 bundle of the same entry | lexicon | 0.273 s (sd 0.035) | 5-run |
| TypeScript 7.0.2 on ashlr-md | not a successful typecheck | exit 1, two TS2322 errors, not timed | one run |
| TypeScript 7.0.2 on ashlr-stack | not a successful typecheck | exit 1, TS5102 and TS5090, not timed | one run |
| TypeScript 7.0.2 on ashlr-plugin | `tsc --noEmit` | 0.680 s (sd 0.017), exit 0 | 5-run |
| oxlint on plugin `servers hooks scripts __tests__` | plugin | 0.063 s (sd 0.006). A separate run: 0 errors, 311 warnings | 5-run for time |
| `bun build servers/_gateway-target.ts` | plugin | 0.004 s (sd under 0.001) | 5-run |
| `@swc/core` 1.15.3 `transformFileSync` of `pending-authority.ts` | phantom, one file | 27.6 ms (sd 2.5 ms) | 5-run |

The serial sum of the two phantom TypeScript 7 means is 6.766 s. `57.204 / 6.766 = 8.45`. That compares a serial pair of native `tsc` runs with `npm run typecheck`, which runs both projects. A parallel wall time was not measured. Default TypeScript 7 checkers is 4, which matches this VM, so the two projects would contend for the same cores if launched together. Both native runs exited 0. Diagnostics were not diffed against tsc 5.9.3.

The incremental tsc 5.9 mean of all five runs is 7.374 s and is pulled by the 20.971 s first run. The mean of the last four times is 3.975 s. That is backend only. `npm run gate` already uses incremental `tsc` for the backend (`--tsBuildInfoFile .ashlr-gate/tsc.tsbuildinfo`). In the one gate run, that incremental `tsc` completed (the gate build log shows `tsc` then asset copy).

Oxlint's single phantom error was `TS(7060)` in `test/perf/server-bench.mts`. ESLint's `npm run lint` exited 0 with 206 warnings. The rule sets differ (oxlint reported unicorn rules, among others). `57.577 / 0.358 = 161`, and that ratio is a stopwatch ratio of two different checks. It is not a measured replacement of ESLint.

Biome on phantom is slower than oxlint and far noisier than ESLint. It is not a drop-in.

ashlr-md TypeScript 7.0.2 failed with TS2322 at `src/lib/export.ts:936` and `src/lib/pasteImage.test.ts:84` (`Uint8Array<ArrayBufferLike>` not assignable to `BlobPart`). ashlr-stack failed with TS5102 (`baseUrl` removed) at `tsconfig.json:16` and TS5090 (non-relative paths) at lines 18 and 19. Neither was timed.

The lexicon esbuild and Rolldown rows bundle one entry. `npm run build` is a `tsc` emit of the project and took 0.686 s. The SWC row transforms one file. It is not a project build. The plugin `bun build` row emits one file. The project has no compile step for a server change. bun runs TypeScript directly.

`5.155 / 0.680 = 7.58` for the plugin typecheck, both exit 0 on this tree. Diagnostics were not diffed.

### Rust

| Candidate | Where | Result | Kind |
| --- | --- | --- | --- |
| mold 2.30.0, `RUSTFLAGS='-C link-arg=-fuse-ld=mold' cargo build --workspace` | locus, after a one-line edit | 9.458 s (sd 0.162) | 5-run |
| default linker (rust-lld), same workspace build | locus | 9.539 s (sd 0.155) | 5-run |
| mold warmup | same flag change, full rebuild | cargo `Finished` in 27.23 s | one run |
| Cranelift nightly, `-p locus-core`, fresh target dir | `CARGO_PROFILE_DEV_CODEGEN_BACKEND=cranelift` | 5.671 s (sd 0.148) | 5-run |
| nightly LLVM, `-p locus-core`, a different fresh target dir | control for the row above | 7.407 s (sd 0.259) | 5-run |
| long-lived `target/` package build | `cargo build -p locus-core`, directory was 5.5 G after the workspace and mold runs | 6.564 s (sd 0.110) | 5-run |
| fresh ext4 target, `-p locus-core` | warmup then the edit | warmup cargo `Finished` in 18.99 s, then 1.457 s (sd 0.016) | warmup one run, then 5-run |
| fresh tmpfs target, `-p locus-core` | same shape | warmup cargo `Finished` in 18.87 s, then 1.361 s (sd 0.015) | warmup one run, then 5-run |

mold minus the default linker is 0.081 s, smaller than either standard deviation. No measured win. The mold flag change forced a full rebuild first (27.23 s). Only the runs after that warmup are the incremental comparison.

`7.407 / 5.671 = 1.31` for Cranelift against nightly LLVM, package `locus-core` only, separate target directories. This is not a comparison with the stable workspace build of 9.539 s. Tests were not run on Cranelift output.

The 6.564 s package build and the 1.457 s fresh-directory build both printed only `Compiling locus-core`. A later single rebuild on the long-lived directory took 7.78 s and also compiled only that crate. The fresh directory is faster. The cause was not isolated past "the long-lived directory had been through workspace builds and a mold relink, and it was 5.5 G". tmpfs versus a fresh directory on ext4 is 1.457 s versus 1.361 s (0.096 s). That is a real small gap on this VM. It is not the gap between 6.564 s and 1.361 s.

`/dev/shm` is mounted `noexec`. A cargo build there failed with `Permission denied` executing build scripts. A tmpfs mounted as root, without a uid, failed with `Permission denied` creating the target path. The successful tmpfs row used a tmpfs mounted with the user's uid and gid.

### Cache hit

A Python sha256 compare of `pending-authority.ts` against a stamp file took 0.019 s (sd 0.001). That is the cost of noticing an unchanged file. It is not a verifier. A miss still pays the full command being skipped.

## Published numbers (other machines, other repos)

These are not measurements of Ashlr repos.

TypeScript 7 announcement, [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), says full builds typically land between 8x and 12x. Their table, TypeScript 6 versus TypeScript 7 with the default of 4 checkers:

| Codebase | TypeScript 6 | TypeScript 7 | Their speedup |
| --- | --- | --- | --- |
| vscode | 125.7 s | 10.6 s | 11.9x |
| sentry | 139.8 s | 15.7 s | 8.9x |
| bluesky | 24.3 s | 2.8 s | 8.7x |
| playwright | 12.8 s | 1.47 s | 8.7x |
| tldraw | 11.2 s | 1.46 s | 7.7x |

The same post says TypeScript 7.0 ships no programmatic API. The API is expected in 7.1. typescript-eslint still needs the TypeScript 6 API, via the `@typescript/typescript6` package, installed side by side. Source: [microsoft/typescript-go](https://github.com/microsoft/typescript-go).

Oxlint's benchmark page says Oxlint is 50x to 100x faster than ESLint depending on core count, and points at [oxc-project/bench-javascript-linter](https://github.com/oxc-project/bench-javascript-linter). Source: [oxc.rs benchmarks](https://oxc.rs/docs/guide/benchmarks) and [oxc-project/oxc](https://github.com/oxc-project/oxc). Our phantom run was a different rule set, so their multiplier is not applied here.

cargo-nextest's [benchmarks](https://nexte.st/docs/benchmarks/) report 1.37x (penumbra) to 3.38x (crucible) against `cargo test`, excluding build time and doctests, on a Ryzen 9 7950X (16 cores / 32 threads), 64 GB RAM, Rust 1.66. The recorded value is the minimum of runs 3, 4, and 5. Source: [nextest-rs/nextest](https://github.com/nextest-rs/nextest). On this VM, warm locus-core tests were 22.720 / 17.975 = 1.26x for nextest. Warm broker tests were faster under `cargo test` (6.239 s versus 6.498 s).

The Cargo book, [Optimizing Build Performance](https://doc.rust-lang.org/cargo/guide/build-performance.html), says Cranelift should generate code faster than LLVM, needs nightly and `-Z codegen-backend`, produces slower code at runtime, and may not support unwinding. It also says an alternative linker such as mold or wild can help, and that on `x86_64-unknown-linux-gnu` the linker Rust already uses is often fast enough that switching is not worth it. Our mold result matches that second sentence. Cranelift source: [rust-lang/rustc_codegen_cranelift](https://github.com/rust-lang/rustc_codegen_cranelift). mold source: [rui314/mold](https://github.com/rui314/mold). wild source: [davidlattimore/wild](https://github.com/davidlattimore/wild). wild was not installed.

## Ranked wins

Ranking is measured seconds saved against the size of the follow-up pull request. Hour counts were not estimated. "Small" means one pull request with a narrow diff. "Medium" means a command plus tests and a cache. A win that drops tests is not ranked, whatever its stopwatch says.

The merge rule for every repo: the existing CI stays the bar. A local shortcut that skips tests is feedback only.

### phantom

Today's verified loop for the median core file is `npm run gate`. One run took 690 s of wall time and 572.97 s inside backend vitest, because the import graph selected 1036 files. `src/core/` is on the full-qualification list in `.github/scripts/ci-impact-policy.mjs` (`fullChangeReason` returns `backend-or-authority-change`). That policy is advisory (`activationEnabled: false`). GitHub CI still runs `npm run test:ci`, lint, and build. A 5 second loop for this file can be feedback. It cannot replace that gate.

1. **Side-by-side TypeScript 7.0.2 for typecheck.** Measured: backend 3.289 s and web 3.477 s, both exit 0, serial sum 6.766 s, against `npm run typecheck` at 57.204 s (8.45x on that comparison). Effort: small. Risk: no programmatic API until 7.1, so ESLint and anything that imports `typescript` stay on 5.9 or on `@typescript/typescript6`. Both native runs exited 0 here, which is not a diagnostic diff. `--checkers` defaults to 4 and the announcement says more checkers use more memory. The serial sum is still over 5 s before lint and tests.
   Plan: one pull request adds a script that runs the native `tsc` on `tsconfig.json` and `src/web-ui/tsconfig.json`, leaves the `typescript` dependency on 5.9, and fails CI only when the native compiler and tsc 5.9 disagree. A later pull request can make the native binary the default typecheck once a diff on `master` is empty.

2. **Point `npm run typecheck` at the incremental tsc the gate already uses.** Measured: warm backend incremental runs at 3.940 s to 3.996 s (mean of those four, 3.975 s) against a cold incremental run of 20.971 s. Effort: small. Risk: a stale `.tsbuildinfo` after a config change. The gate path already exists.
   Plan: one pull request changes the backend half of `npm run typecheck` to the same `--incremental --tsBuildInfoFile` invocation `scripts/gate.mjs` uses, and runs the web project at the same time. Keep `npm run gate` as the test selector.

3. **Oxlint as a prefilter in front of ESLint.** Measured time: 0.358 s versus `npm run lint` at 57.577 s. The checks differ (oxlint 1 error and 384 warnings, ESLint 0 errors and 206 warnings). Effort: small. Risk: a green oxlint gets treated as a green lint. Biome at 8.753 s, with tens of thousands of findings and a diagnostic cap, is a worse fit.
   Plan: one pull request adds `lint:fast` that runs oxlint on `src` and `test` and prints that ESLint is still `npm run lint`. CI keeps `npm run lint`.

4. **A content-hash stamp around `npm run gate`.** Measured: the hash compare itself was 0.019 s. The thing it can skip is the gate, which was 690 s of wall time in one failing run and is the right local verifier. Effort: medium. Risk: a stamp that forgets an input (lockfile, vitest config, toolchain, `CI`) will skip a run that should have happened. A hit is allowed only for a previous green run of the same command.
   Plan: described in the agent section below. The smoke set, including the tier-1 closure test, stays inside the command that gets stamped. CI does not read the stamp. `src/core` changes still take the full `test:ci` lane before merge.

5. **Keep the direct vitest file as a scratch check, and keep the related set for anything that will merge.** The direct file was 1.318 s. The related set was 1036 files and 572.97 s in one run. Effort: none for the measurement, and a pull request would be wrong if it made the direct file the gate. Risk of switching: almost all coverage for a `src/core` edit disappears. `pending-authority.ts` is also imported by tests other than `m504`.

`npm run build` did not finish on this VM, so a bundler swap is not ranked. Vite's own "built in 2.17 s" line is one observation inside a failing `npm run build`, after `tsc` had already run.

### lexicon

Lexicon is already on TypeScript 7.0.2. A second install of the same compiler, pointed at the root tsconfig, took 1.318 s against `npm run lint` at 1.365 s. There is no compiler upgrade left to rank.

1. **Stop paying for lint as a second root `tsc`.** Typecheck is 1.681 s and already runs the root project plus the extension. Lint is 1.365 s and runs the root project again. Effort: small, in the lexicon repo. Risk: low while `npm run typecheck` remains in CI. The two scripts are not identical, because typecheck also builds the extension project.
   Plan: one pull request makes `lint` a real linter, or makes it call the typecheck the CI job already runs, so a local loop does not typecheck the root twice. Add oxlint or ESLint only if the project wants lint findings. The 0.063 s oxlint timing is a different check and was not compared finding-for-finding.

2. **Keep `vitest related` as the verify step, and cut its fixed cost.** Related tests were 25.408 s. The one file that imports `prompt.ts` was 1.153 s. Typecheck plus that one file is under 5 s (added means 2.834 s) and is the right scratch loop. Effort: medium. Risk: running only `tests/review.test.ts` misses other importers.
   Plan: one pull request in lexicon adds a warm path that caches the related file list for a content hash of the import graph, then runs that same list. The list is recomputed when the graph changes. CI keeps `vitest run` of the whole suite.

3. **Leave the build alone.** `npm run build` is 0.686 s. esbuild bundled one entry in 0.083 s and Rolldown in 0.273 s. Those are not the project emit. A bundler pull request saves less than a second on a loop that is already under 5 s for the direct path.

### phantom-secrets

1. **`cargo check` is the edit feedback.** Measured 1.746 s after the edit, against a cold check of 50.60 s. Effort: small (document it, or have the agent tool run it first). Risk: check is not tests.
   Plan: one pull request in phantom-secrets adds a `just` or npm script named for the local loop that runs `cargo check --workspace --locked` and prints the next command (`cargo nextest` with the affected filterset) rather than replacing it. CI is unchanged.

2. **Package tests for local feedback, reverse-deps before merge.** Package nextest after the edit was 6.901 s. The no-edit run was 6.498 s, so the tests themselves are most of that time. Reverse-deps nextest was 90.493 s. The broker crate has dependents (the workspace filter pulls them in). Effort: small to script the split, zero to adopt nextest (CI already uses it). Risk: shipping on the package run alone misses breakages in dependents.
   Plan: local default is check, then `-p phantom-secrets-broker` when the agent wants tests. The pre-merge command stays the existing affected filterset, which expands to reverse deps. Do not switch the runner to `cargo test` for the 0.259 s noop gap.

3. **Clippy stays off the keystroke path.** Measured 5.080 s, which is the whole 5 second budget by itself. CI already runs it with `-D warnings`.

4. **Do not spend a pull request on the linker.** Workspace build was 3.821 s. The 90 s test run is the wall. mold did not beat rust-lld on locus (see above), and this crate's check is already 1.746 s.

The npm wrappers are already under 2 seconds (`0.520 s` and `1.122 s`).

### locus

1. **`cargo check` for feedback, nextest for verify.** Check was 4.695 s (cold check 15.09 s). Package nextest after the edit was 28.462 s, and with no edit 17.975 s, so a warm test run with nothing to compile is still 18 s. Reverse-deps was 44.354 s. Nextest versus `cargo test` on the warm package was 1.26x (22.720 / 17.975), in the same direction as the upstream benchmarks and smaller than their 1.37x to 3.38x range. CI already uses nextest. Effort: small. Risk: treating check as the merge gate.
   Plan: same shape as secrets. Local first command is `cargo check --workspace --locked`. Pre-merge stays `scripts/ci/affected-filterset.sh` plus nextest, which CI already runs.

2. **A fresh target directory, not a linker swap.** On the long-lived 5.5 G `target/`, `cargo build -p locus-core` was 6.564 s. On a fresh ext4 directory the warmup was 18.99 s and the incremental build was 1.457 s. tmpfs incremental was 1.361 s after an 18.87 s warmup. mold versus rust-lld on the workspace build was a tie (9.458 s versus 9.539 s). Effort: small. Risk: a fresh directory costs the warmup, and a second `CARGO_TARGET_DIR` uses disk.
   Plan: one pull request documents that a mold or rustflags experiment should use a separate target dir, and adds a script that builds `-p <crate>` into a scratch dir when the developer asks for a fast package rebuild. It does not change the default `target/` CI uses. tmpfs is optional. The measured gain over a fresh ext4 dir was 0.096 s.

3. **Cranelift only if package builds dominate and nightly is acceptable.** Measured 5.671 s versus 7.407 s nightly LLVM, a 1.31x on `locus-core` alone. The Cargo book flags slower runtime and missing unwinding. Tests were not timed. This does not bring the 18 s warm test run under 5 s. Effort: medium, because it is nightly and unstable. Ranked under check-first and under a clean target dir.

4. **Fix the npm test invocation.** `node --test npm/test` failed on Node 22.23.4. The two files passed in 0.142 s (14 tests). Effort: small. Risk: low if the file list matches what CI intended.
   Plan: one pull request in locus changes the CI and package script to pass the test files (or a glob Node 22 accepts) and keeps `node --test scripts/check-crypto.test.mjs`.

### ashlr-md

The web loop and the Rust loop are different edits.

1. **Rust: `cargo check` is already the 5 second loop.** Warm check was 1.806 s. Clippy was 2.702 s. Cold check was 48.23 s. Package nextest with no edit was 1.836 s, and `cargo test` was 1.872 s. After the one-line edit, package nextest was 11.989 s and the workspace build was 9.239 s, so the extra time is the test-profile rebuild. Effort: small. Risk: none for using check as feedback. CI already runs check and clippy.
   Plan: one pull request in ashlr-md adds a local script that runs `cargo check --workspace --manifest-path src-tauri/Cargo.toml` and leaves clippy and the web jobs on the CI path. Adopting nextest is not ranked. The noop gap was 0.036 s, and CI does not use nextest today.

2. **Web: separate typecheck from the vite bundle.** Typecheck was 5.304 s, Biome 0.440 s, one vitest file 0.607 s. Added means of those three: 6.351 s. `bun run build` was 21.462 s, of which vite alone was 16.364 s. Effort: small. Risk: a logic change that only shows up in the bundle waits for CI. That is the right trade for an edit loop, because CI already runs the vite build.
   Plan: one pull request documents the local web command as `bun run typecheck`, `bun run lint`, and `bunx vitest run <file>`, and keeps `bun run build` on CI. Biome is already the linter. Do not replace it.

3. **TypeScript 7 is blocked on two errors.** The native compiler exited 1 and was not timed. The errors are the two TS2322 `BlobPart` assignments named above. Effort: small once those two types are fixed, then a remeasure. Risk: the speedup is unknown until it is timed. Plugin's similar-sized typecheck went from 5.155 s to 0.680 s, which is a different repo. Do not copy that ratio onto ashlr-md.
   Plan: one pull request fixes the two assignments (or adjusts the lib types if the project agrees), then runs the same hyperfine. Switch `bun run typecheck` only after the native compiler exits 0 and a diagnostic diff against tsc 5.8.3 is empty.

### ashlr-stack

The measured cli edit is already under 5 seconds. Added means: typecheck 2.313 + lint 0.224 + one test 0.138 + cli build 0.044 = 2.719 s. These were separate commands.

1. **Keep the full `bun test` on CI, and use the one file locally.** Full suite was 31.685 s. The one file was 0.138 s. Effort: small. Risk: the one file misses packages that import `agent-preflight.ts`.
   Plan: one pull request in ashlr-stack adds a local script that maps a changed file to the test file that imports it and runs `bun test` on that set. CI stays `bun test` with no filter. The root build, including the site, was not timed, so this plan does not claim the site rebuild is under 5 s.

2. **Leave the compiler alone.** TypeScript 7.0.2 failed on `baseUrl` and `paths` and was not timed. Typecheck is already 2.313 s. A paths migration is a larger pull request than the time it could save. Revisit only if the site build, once measured, is dominated by `tsc`.

### ashlr-plugin

1. **TypeScript 7.0.2 for `bun run typecheck`.** Measured 0.680 s versus 5.155 s, both exit 0, 7.58x on this tree. That is the step over 5 seconds. One file of tests was 0.081 s. `mdx-lint` was 0.018 s. Added means of native typecheck plus the one file: 0.761 s, timed separately. Effort: small. Risk: exit 0 is not a diagnostic diff against tsc 5.9.3.
   Plan: one pull request adds the native `tsc` beside the current one, fails if they disagree, and switches the script after a clean diff. `bun run check` (smoke, typecheck, mdx lint, root tests, and the server, site, and vscode checks) stays the pre-merge command.

2. **Keep the full suite before merge.** One `bun run test` on this VM exited 1 in 33.53 s with the two environmental failures above. Effort: a follow-up to make those two tests hermetic, separate from the speed work. Risk of skipping the suite: the 0.081 s file does not cover the other 245 files.

3. **Do not add a bundler to the edit loop.** `bun build` of the one server file was 0.004 s and is not a project rebuild. bun already runs the TypeScript. Oxlint at 0.063 s with 311 warnings is a different check from `mdx-lint`. It is not ranked as a replacement.

## Agent loop: `ci-local` and a verified-result cache

Phantom agents already have `npm run gate`, which plans vitest related tests plus the smoke set. The smoke set always includes the tier-1 authority closure test. A core edit still cannot shrink the merge suite: `fullChangeReason` treats `src/core/` as a full qualification, and `activationEnabled` is false, so CI does not inherit a reduced set.

Proposed follow-up, one medium pull request in phantom, after this note:

- A thin CLI handler and the logic in `src/core/`, named `ci-local`. The local mode runs the same planner as `scripts/gate.mjs`.
- An `--impacted` mode is that local planner. It is feedback. It is not the merge command.
- A stamp directory keyed by a hash of every gate input: the sorted canonical changed-file paths and their bytes, the selected base ref and merge-base SHA, `scripts/gate.mjs`, `scripts/gate-smoke.json`, the lockfile, the tsconfig and vitest config, and the toolchain version. A change to any of these inputs produces a new key, so it invalidates the stamp. The hash compare measured here was 0.019 s for one file. A hit prints the previous green result and exits 0. A miss runs the real gate and writes the stamp only when that run exits 0. A red run is recorded as red so the next call does not report green.
- CI jobs keep calling `npm run test:ci`, `npm run lint`, and `npm run build`. They do not read the stamp.
- A second, smaller pull request can expose the same command as an MCP tool next to `ashlr_impact` in `src/core/mcp-native.ts`. Until that exists, an agent can run the CLI.

The same stamp shape fits the Rust repos, with the cargo fingerprint and the affected filterset as the command being cached. phantom-secrets and locus already compute that filterset in CI. The local win is running `cargo check` immediately and caching a green nextest only when the fingerprint matches. A leaf crate still runs reverse-deps before merge, because a package-only green run missed dependents in the measurements above (secrets reverse-deps 90.493 s versus package 6.901 s).

## Surveyed and not timed

| Idea | Why it was not timed | What the sources say |
| --- | --- | --- |
| wild linker | not installed | Cargo book lists it with mold. mold tied rust-lld on the locus workspace build, so a second linker is unlikely to move these crates. [wild](https://github.com/davidlattimore/wild) |
| sccache | not installed | Caches artifacts for crates that did not change. The crate you just edited still compiles. The nextest benchmark page mentions build caches so that test time becomes a larger share of the total. [mozilla/sccache](https://github.com/mozilla/sccache) |
| `split-debuginfo` and `debug = "line-tables-only"` | not changed | Cargo book recommends less debug info for faster codegen and linking. Worth a later measurement on the locus long-lived target, where one crate took 6.564 s. No speedup is claimed here. |
| bacon, cargo-watch | not installed | They rerun a command when files change. They do not shorten that command. [bacon](https://github.com/Canop/bacon), [cargo-watch](https://github.com/watchexec/cargo-watch) |
| turborepo, nx | not installed | Phantom is one package. ashlr-stack already uses bun workspaces. A task graph helps when outputs are cached. The only cache timed here is the 0.019 s hash compare. [turborepo](https://github.com/vercel/turborepo), [nx](https://github.com/nrwl/nx) |
| tsserver, vitest watch, a pre-forked test runner | not left running as a daemon | The warm incremental tsc result is the closest measurement. Lexicon's related run (25.408 s) versus one file (1.153 s) is mostly extra tests and the graph walk, which a warm process can avoid recomputing only if it runs the same tests. |
| coverage-based test impact | not built | Phantom already selects tests by import graph. On the median core file that selected 1036 backend files. A coverage map can be tighter and can miss a test that never imports the file. The gate smoke set exists for that reason. Building one is a later experiment, and it does not replace CI. |

## Tool sources

| Tool | Source |
| --- | --- |
| TypeScript 7 / typescript-go | https://github.com/microsoft/typescript-go |
| TypeScript 7 announcement | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ |
| Oxlint / Oxc | https://github.com/oxc-project/oxc |
| Oxlint benchmarks | https://oxc.rs/docs/guide/benchmarks |
| Oxlint bench repo | https://github.com/oxc-project/bench-javascript-linter |
| Biome | https://github.com/biomejs/biome |
| esbuild | https://github.com/evanw/esbuild |
| Rolldown | https://github.com/rolldown/rolldown |
| SWC | https://github.com/swc-project/swc |
| Vitest | https://github.com/vitest-dev/vitest |
| bun | https://github.com/oven-sh/bun |
| cargo-nextest | https://github.com/nextest-rs/nextest |
| nextest benchmarks | https://nexte.st/docs/benchmarks/ |
| mold | https://github.com/rui314/mold |
| wild | https://github.com/davidlattimore/wild |
| Cranelift backend | https://github.com/rust-lang/rustc_codegen_cranelift |
| Cargo build performance | https://doc.rust-lang.org/cargo/guide/build-performance.html |
| sccache | https://github.com/mozilla/sccache |
| bacon | https://github.com/Canop/bacon |
| cargo-watch | https://github.com/watchexec/cargo-watch |
| turborepo | https://github.com/vercel/turborepo |
| nx | https://github.com/nrwl/nx |
