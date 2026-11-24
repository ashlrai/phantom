# RQ-DRAIN-PHX-REB-08 outcomes

All six PRs were checked in the requested order and rechecked before handoff. All remain open at their supplied heads. No new head SHA exists. No PR was closed, commented on, published or merged. The final instruction prohibits commits and pushes. GitHub CLI configuration is inaccessible; an empty temporary GH_CONFIG_DIR has no authentication. Available connected GitHub tools support reads only.

The requested external handoff directory could not be created (EPERM). This repository-local file is the fallback. `blocked` records actual completion state, including closures that could not be executed; it does not mean the prepared changes introduced failures.

| PR | Action | New head SHA | Check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [7955](https://github.com/ashlrai/phantom/pull/7955) | blocked | None; unchanged `a5744b0a280a49c0dbd0b377542842d1fa69305f` | Superseded by merged #8032; closure unavailable | Not closed |
| [7954](https://github.com/ashlrai/phantom/pull/7954) | blocked | None; unchanged `2168252d1c14324104903c603472f1426784277d` | Superseded by merged #8025; closure unavailable | Not closed |
| [7940](https://github.com/ashlrai/phantom/pull/7940) | blocked | None; unchanged `b5c9b84423f96ab5e7863f2465902768edc671a2` | Original intent present on master; open #8478 documents preservation; closure unavailable | Not closed |
| [7928](https://github.com/ashlrai/phantom/pull/7928) | blocked | None; unchanged `90fe2e4637f67373a37cc6a796c599e74f471cc4` | Local changelog/docs preparation: 20 tests passed; typecheck/docs/verifier passed; publication prohibited | Not closed |
| [7916](https://github.com/ashlrai/phantom/pull/7916) | blocked | None; unchanged `5e062f16bec7cedb80d76a9b7c6631f980af3708` | CI guidance present on master, including merged #8263; closure unavailable | Not closed |
| [7890](https://github.com/ashlrai/phantom/pull/7890) | blocked | None; unchanged `3836c81005e43facfc5a03def0a256f42621339e` | 85 tests passed, 1 inherited failure; typecheck, changed lint and verifier passed; publication prohibited | Not closed |

## Supersession evidence and proposed comments

- #7955: merged [#8032](https://github.com/ashlrai/phantom/pull/8032) explicitly preserves saved limits, environment precedence, authenticated strict config mutation, reset, Settings UI and shared live-line limits. Current master contains these implementations; its consolidated tests replace the older backend test file. Proposed comment: `Superseded by https://github.com/ashlrai/phantom/pull/8032, which preserves the build-stale settings behavior on master.`
- #7954: merged [#8025](https://github.com/ashlrai/phantom/pull/8025) preserves opt-in fetch, refFreshness, CLI/docs and tests, fixes the help syntax error, and strengthens refspec/fallback handling. Current master contains them. Proposed comment: `Superseded by https://github.com/ashlrai/phantom/pull/8025, which preserves and fixes the doctor-build fetch behavior on master.`
- #7940: current CONTRIBUTING describes the fast PR/queue gate and scheduled full suites; tidy already imports requireBuiltDist and uses the newer explicit-root API. Open [#8478](https://github.com/ashlrai/phantom/pull/8478) documents each preserved hunk and adds dedicated coverage. Proposed comment: `Superseded by https://github.com/ashlrai/phantom/pull/8478; the original CI documentation and shared tidy preflight are already preserved on master.`
- #7916: all three changed documents retain the required/local-check distinction, fast PR gate and scheduled full suites. Merged [#8263](https://github.com/ashlrai/phantom/pull/8263) preserves and tests this documentation family. Proposed comment: `Superseded by https://github.com/ashlrai/phantom/pull/8263; all three guides already retain the fast PR gate and scheduled full-suite guidance.`

## Local preparations

Both candidates remain unstaged and uncommitted on master `d5b049f0bcbe6a2ba04aa0d52b4c9309411622e5`. These are local integrations, not completed merges into the original PR branches. Creating an independent git worktree was refused with EPERM, so separate review patches are saved under `.ashlr-gate/handoff/RQ-DRAIN-PHX-REB-08/`:

- `pr7928.patch`: 42-line unique changelog section plus regenerated current version references. Current generated CLI references already contain the source commands. Never restore the old version pins.
- `pr7890.patch`: original merge-base duplicate-name behavior and tests, retaining master's newer verifier grammar buckets, authority checks, conditional compiler selection and comparison fallback. Documentation describes scoped versus strict checking. No baseline, closure allowlist, CODEOWNERS, authority source or security guard was changed.

Do not publish these two independent patches as a combined replacement. Publication and merge-queue admission still require the existing authorized publisher and original branches, with fresh head checks.

## Verification and blockers

- Focused documentation tests: 20 passed, 0 failed.
- Focused checker/gate/verifier tests: 85 passed, 1 failed. The unchanged repository-wide strict duplicate-name assertion fails. An archived HEAD test tree with HEAD's checker also exits 1, confirming inherited duplicate-name debt. All nine new merge-base regression cases pass. No assertion or baseline was weakened.
- Authority checks invoked by verify-changed: 10 passed, 0 failed.
- Final backend/web typecheck, changed-file ESLint, documentation check, docs-sync, git diff --check and changed verifier: passed. Diff-scoped duplicate scan reports no new duplicate full names.
- Full lint: 16 errors and 265 warnings, all errors in untouched files. Its chained lane checks do not run after ESLint failure; the changed verifier separately passed both lane checks, with warnings for inherited real-I/O membership gaps.
- Hosted Merge Gate, secret-shape and clean-tree were not rerun on a new head because none was created. Required checks and merge-queue rules remain unchanged.

## Final accounting

- #7928 review patch: 4 files, +45 / -3, net +42 LOC.
- #7890 review patch: 9 files, +342 / -53, net +289 LOC.

Reports add 92 lines. Total reviewable source and reports: +479 / -56, net +423 LOC across 15 files. Patches are ignored review artifacts and are not counted twice. All changes are unstaged and uncommitted.
