# Implementation findings

## RQ-REBASE-PHANTOM-915

- Existing PR: https://github.com/ashlrai/phantom/pull/915; head feat/custody-wrap-receipt at 8fee7a9c15f31a116331e4fc7dd942189d428ad0.
- Latest head CI run 42776494378: Merge Gate failed because Quick typecheck hit TS2322 in custody-capture.ts:48. The every() type predicate narrowed the array to wrapped records before an unwrapped assignment. Secret-shape scan passed.
- Changed every(wrapped) to !some(unwrapped), preserving bounded storage and first-unwrapped retention without narrowing the array.
- Applied the exact existing feature diff (155ebde0f9848316fc7fc74428cbccf805b7e9c6 to PR head) cleanly to fetched master afc979fd840de55c64233b1262f18a46c1c1d5bf. This is an uncommitted handoff, not a remotely updated PR.
- Added a regression for first-unwrapped retention across the record cap and assigned the subprocess suite to real-io.
- GitHub connector reads work; gh CLI cannot read its local config. No companion tools invoked directly.
- Final task RULES prohibit commits/pushes; clarification pending. No remote update or enqueue attempted.
- Dependencies repaired using npm run install:worktree (pnpm 10.28.2, both healing steps passed).
- Full typecheck and changed-file verifier pass. Authority regen adds two existing role routing roots, 41 existing closure paths, 31 existing test owners; only additions, plus the custody feature's own closure and test owner entries. Full authority/security rerun: 13/13 passed.
- Corrected the feature test's child_process mock to stub Phantom discovery only; touch now executes and the new suite passes 9/9.
- Existing custody-unwrapped-fleet and custody-no-phantom-toml-copy tests cannot create temporary .env files (EPERM); no test or security policy weakened.
- Full expanded run: 320 passed, 6 daemon failures. Both master archive and candidate diagnostics: five of those six pass in isolation; E5e reproduces (positive PID reuse requires forbidden ps inspection). Full lint's three errors are in unchanged leader reply tests, all no-control-regex. No timeout, test or protection was weakened.

Historical findings follow.

No drive command, driver daemon, metrics command, restock implementation or publish.sh exists in this checkout. Use an explicit versioned local file contract until the driver lands. Reuse fleet CLI dispatch and fleet digest aggregation. Keep transport responsibility with Masbot. Protected paths were inspected read-only.
