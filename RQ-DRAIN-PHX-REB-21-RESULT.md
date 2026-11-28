# RQ-DRAIN-PHX-REB-21 outcomes

Inspected 2026-11-24 against master `587bb0ec9e9211c1d32d8ae1b693e313cc663c15`.
No commits, pushes, publications, merges, PR closures or comments were made.
Master verification: 121 tests passed, zero failed; typecheck, docs and
verify-changed passed. Full lint failed on 16 pre-existing errors and
265 warnings; the standalone real-I/O membership guard also found baseline drift.

| PR | Action | New head SHA | Check status | Replacement URL |
| --- | --- | --- | --- | --- |
| #7168 | closed-superseded (pre-existing; skipped) | c9a6b9dca6dbec4e4237d262fba8cea32ff1ab5a (unchanged) | Not run; already closed | https://github.com/ashlrai/phantom/pull/7229 |
| #7167 | blocked (superseded; closure unavailable) | 2caf2f608665a459e5f17687d7733a15ba53c187 (unchanged) | Master: backend tests pass; typecheck pass | https://github.com/ashlrai/phantom/pull/8290 |
| #7162 | blocked (superseded; closure unavailable) | f555450fdc34274bcb0a11d0c13665140f529670 (unchanged) | Master: affected web tests pass; typecheck pass | https://github.com/ashlrai/phantom/pull/7201 |
| #7160 | blocked (superseded; closure unavailable) | e5ff7ababa6357b974781b734044e24e35d05777 (unchanged) | Master: affected web tests pass; typecheck pass | https://github.com/ashlrai/phantom/pull/7179 |
| #7155 | blocked (superseded; closure unavailable) | 8e86777039b861bd35859d036bfc76697249bfab (unchanged) | Master: backend tests pass; typecheck pass | https://github.com/ashlrai/phantom/pull/7172 |
| #7151 | blocked (superseded; closure unavailable) | becbf58cb3d51ac1f84c7e2625e9535db41de440 (unchanged) | Master: affected web tests pass; typecheck pass | https://github.com/ashlrai/phantom/pull/7656 |

## Evidence and blockers

- #7168 was closed before this job. Its existing closure comment names #7229.
- The other five PRs are open and match the requested head prefixes. All five
  replacement PRs were independently verified as merged, with their merge
  commits present in master's history.
- #7167's parser regression is already carried in `test/leader-board-batch.test.ts`,
  explicitly naming #7167. #8290 preserves its batch and unknown-head behavior
  with stricter malformed-token rejection. The tick hook already exists in
  `src/core/vision/leader.ts`; stale header prose is not unique runtime behavior.
- #7162's PoolsCard implementation, bar test and CSS exactly match #7201's
  merge snapshot. #7160's pane registration matches #7179; its implementation
  was extended there with routing and owner-message support.
- #7155's API module, route registration and CLI completion changes match
  #7172; that replacement extends the reader with owner messages and tests.
- #7151's board model, model tests, navigation tests and dock-store changes
  match #7656; that replacement adds live readings to the same navigation.
- Normal `git merge-tree --write-tree origin/master <head>` returns conflicts
  for all five after history deepening. Supersession is established by the
  newer merged changes, not by claiming an identical merged tree.
- The GitHub connector exposes reads only. Normal `gh` cannot read its config;
  a fresh temporary `GH_CONFIG_DIR` has no authentication. No credentials were
  read, copied or provisioned. Closure and blocker comments remain unsent.
- The requested external handoff directory refused creation with an operating
  system permission error. This worktree copy is the fallback; the existing
  root `RESULT.md` belongs to another job and is preserved unchanged.

## Prepared closure comments (not sent)

| PR | Comment |
| --- | --- |
| #7167 | Superseded by https://github.com/ashlrai/phantom/pull/8290, already merged with the batch-rebase counting behavior and regression coverage. |
| #7162 | Superseded by https://github.com/ashlrai/phantom/pull/7201, already merged with the same pool capacity bars and tests. |
| #7160 | Superseded by https://github.com/ashlrai/phantom/pull/7179, already merged with the Conversations pane and additional routing support. |
| #7155 | Superseded by https://github.com/ashlrai/phantom/pull/7172, already merged with session threads, the API, CLI and tests. |
| #7151 | Superseded by https://github.com/ashlrai/phantom/pull/7656, already merged with resource board navigation and live readings. |
