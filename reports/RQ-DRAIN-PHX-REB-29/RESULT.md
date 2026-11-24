# RQ-DRAIN-PHX-REB-29 outcome

Reviewed in requested order on 2026-11-24. Local base:
`fcf4a25e16e337b5e147a3a6795e90de432b1d3e`.

All six PRs remain open with their supplied heads. No branch was committed,
pushed, rebased, merged remotely, or published. No new PR was opened.
The final no-commit/no-push instruction limits this pass to uncommitted work.

GitHub comment and close requests for #6398 both returned HTTP 403
(Resource not accessible by integration). The existing gh connection could not
read its configuration because macOS returned Operation not permitted.
No credential workaround was attempted. Comments below are drafts, not sent.

The requested external handoff directory also returned Operation not permitted.
This file is the worktree fallback for RESULT.md.

## Per-PR outcome

The check column records hosted checks on each unchanged PR head, not checks
on a new merge candidate. Names map to Merge Gate / secret-shape (Secret-shape
scan) / clean-tree (Check generated files). All three names and controls remain
unchanged. No PR was closed, so the closed-replacement column is empty.

| PR | Action | New head SHA | Hosted check status | Replacement URL if closed |
| --- | --- | --- | --- | --- |
| [#6398](https://github.com/ashlrai/phantom/pull/6398) | blocked | None; unchanged `8e46d69ffdacc89dbf58abebe8c89f6b1af51348` | Merge Gate FAIL; secret-shape PASS; clean-tree PASS | - |
| [#6388](https://github.com/ashlrai/phantom/pull/6388) | blocked | None; unchanged `35fa0f9879536e202ddba1f8bf80b2b7fa46366f` | Merge Gate PASS; secret-shape PASS; clean-tree PASS; conflicts remain | - |
| [#6354](https://github.com/ashlrai/phantom/pull/6354) | blocked | None; unchanged `ef4ff684a0159fcab2c4b7e3473b12a04fd5b4d9` | Merge Gate FAIL; secret-shape PASS; clean-tree PASS | - |
| [#6323](https://github.com/ashlrai/phantom/pull/6323) | blocked | None; unchanged `f9f9aa61357b6914659ceb290d8c512e3f04e2da` | Merge Gate FAIL; secret-shape PASS; clean-tree PASS; Secret scan FAIL | - |
| [#6306](https://github.com/ashlrai/phantom/pull/6306) | blocked | None; unchanged `0e72202d1efa16675ced1ea12378c368a1ba9456` | Merge Gate FAIL; secret-shape PASS; clean-tree PASS; Secret scan FAIL | - |
| [#6002](https://github.com/ashlrai/phantom/pull/6002) | blocked | None; unchanged `24c8c0653b2bc47fa5673079a42bde084301e8ef` | Merge Gate FAIL; secret-shape PASS; clean-tree PASS; Secret scan FAIL | - |

## Findings and prepared actions

1. **#6398: close as superseded once PR writes are available.**
   [#6992](https://github.com/ashlrai/phantom/pull/6992), merged at
   `8cbc67576f6db5e86d14bce82c0bfa77098d34f1`, contains the full model test.
   `git diff -w --exit-code` between the source and master passes for its
   sole changed file. The add/add conflict is blank-line whitespace.
   Draft: Superseded by https://github.com/ashlrai/phantom/pull/6992, which
   merged the same claim-notices model tests; the remaining differences are whitespace.

2. **#6388: keep open.**
   Its 51-file payload is not fully superseded. Action classes, router gateway,
   release coordination, and shard sizing overlap merged #6380, #6381, #6382,
   and #6384. Newer updater PRs #6983 and #8596 do not carry every original
   hardening detail. The macOS daemon-install restoration remains absent:
   current `test/daemon-cli-help-safety.test.ts` explicitly requires denial.
   Restoring the old behavior would conflict with the task's guard-preservation
   rule. No authority files, tests, closure entries, or CODEOWNERS were changed.
   Draft: Blocked: this PR's macOS daemon-install restoration conflicts with
   the current authority-denial guard, which this task forbids weakening; no
   branch update was published.

3. **#6354: retain the three missing document canary scans.**
   [#6916](https://github.com/ashlrai/phantom/pull/6916) merged the package
   allowlist entries, but not the scans of CLI-AGENT-READINESS.md, lanes.md,
   and REPO-OWNERS.md. The one-line uncommitted test change carries these scans
   while preserving master's expanded allowlist. Existing squash auto-merge
   remains enabled. Its head repository is upstream, so the specified existing
   branch cannot be pushed to directly under the fork-only rule.
   Draft: Blocked: three document canary scans remain unique and are prepared
   locally; the no-push instruction and fork-only restriction prevent updating
   this upstream-owned branch.

4. **#6323: close as superseded once PR writes are available.**
   [#8170](https://github.com/ashlrai/phantom/pull/8170), merged at
   `19ee7a3331029f7befbd56faff738267f1ddbfd5`, carries C482 byte-for-byte
   and C404 with the same assertions and an equivalent constructed marker.
   The doctor prerequisite already landed in #6593. Old closure additions
   subsequently evolved through #6864; restoring them would regress master.
   Draft: Superseded by https://github.com/ashlrai/phantom/pull/8170, which
   preserves the C404 and C482 suites; the doctor prerequisite already landed
   in #6593 and master's later authority closure must remain intact.

5. **#6306: keep the two residual CLI fixture fields.**
   [#6667](https://github.com/ashlrai/phantom/pull/6667) explicitly supersedes
   the original C477 suite and merged it, but did not preserve the two
   secret-shaped field names in the CLI fixture. #8170 covers those fields
   through the underlying reader. Conservatively retain the original CLI
   coverage too: the modified fixture file exactly matches #6306.
   Existing doctor and authority evolution remain unchanged.
   Draft: Blocked: #6667 merged the C477 suite, but two original CLI fixture
   fields remain unique and are prepared locally; no branch update was published.

6. **#6002: close as superseded once PR writes are available.**
   [#8170](https://github.com/ashlrai/phantom/pull/8170) carries the remaining
   C404 behavior. The other original suite already exists on master; doctor
   and closure history are the same as #6323.
   Draft: Superseded by https://github.com/ashlrai/phantom/pull/8170, which
   preserves the C404 suite; the other carried behavior is already on master.

These local test edits are preservation material for the existing PRs.
Do not publish them as another duplicate PR.

## Local verification

- Scoped verifier PASS: 10 authority tests, changed-file ESLint, backend
  typecheck, quarantine ledger, conflict-marker check, and both I/O guards.
  Existing unchanged-file real-I/O warnings were reported.
- Documentation check PASS: zero errors.
- Secret-shape scan PASS: `0 allowed=0`.
- Model test PASS: 7/7.
- Initial backend run: 27 passed, 2 failed, plus one collection failure.
  Failures reported missing compiled dist files; a full build was started.
- Post-build retry PASS: M454 7/7, doctor 4/4, daemon guards 54/54.
- Final distinct test total: 104 passed, zero remaining test failures across
  11 suites, including 10 authority tests and 7 console model tests.
- Full build FAIL after backend and console compilation: release dependency
  inventory rejected the npm pack file report. Its source and guards are
  unchanged by this pass. No full-build success is claimed.
- Read-only pack diagnosis: shared worktree dependency links produced package
  entries containing parent-directory traversal. The inventory correctly
  rejects those nonportable paths. Do not loosen the inventory guard; a release
  checkout needs a self-contained dependency installation before qualification.
- Independent review PASS: source PR residual changes preserved exactly;
  no security assertions weakened.
