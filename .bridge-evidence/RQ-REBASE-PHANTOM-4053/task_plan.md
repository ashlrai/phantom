# Task plan: RQ-REBASE-PHANTOM-4053

Goal: update existing PR #4053 against master, fix Merge Gate, and enqueue if permitted.

- [x] Read repository guidance and query PR state.
- [x] Inspect original changes, current master, and Merge Gate evidence.
- [x] Prepare bounded local repair: test calls real fleet entry instead of core dispatcher without loaders.
- [x] Verify bounded repair and write BRIDGE_NOTES.md with explicit remaining limitations.

Constraints: user explicitly prohibits commits, pushes, tags and publication; all work stays uncommitted. No new PR. No auth/config changes or bypasses.

Errors: global Phantom installation failed EPERM; gh PR read failed EPERM reading its config; phm wire status returned 1 (unavailable client config). Existing phm 3.30.24 and connected GitHub reads are available.

Additional errors: shallow merge analysis cannot establish ancestry; deepening fetch failed because a shared shallow.lock exists (left untouched). Explicit-original-parent advisory merge reports 31 conflict paths. Baseline selected tests: 37 passed / 1 failed; failed suite imports core dispatcher instead of executable entry. verify-changed reports eslint unavailable and is waiting on shared typecheck capacity.

Status: local handoff finished; requested rebase/enqueue remains BLOCKED. Seven feature/dispatcher suites pass (74 tests); boundary suite has 1 pass / 2 failures. Authority drift passes (10 tests). Lint cannot load ESLint; typecheck timed out at 60 seconds. Full reconciliation exceeds 15-file work-tier scope; remote actions remain prohibited and gh unavailable.
