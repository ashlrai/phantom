RQ-FLEET-BUNDLE-ROSTER-1 result

Implemented M2 portable bundles, multi-owner roster and unconditional deny-only grants. Changes remain uncommitted. PR URL: not created, as required by the final task instruction.

All seven conditions have named regression coverage:
- M2-1: fleet-grants-m2.test.ts, 9 passed.
- M2-2: fleet-m2-identity.test.ts, 8 passed.
- M2-3 and M2-6: fleet-bundle-m2.test.ts, 76 passed combined with canonical-format coverage; actual macOS immutable fixture passed.
- M2-4: agent-roster-m2.test.ts, 6 passed.
- M2-5: fleet-m2-teammate-origin.test.ts, 7 passed; no sends.
- M2-7: fleet-m2-stub-boundary.test.ts, 2 passed.
- Bundle CLI acceptance: fleet-m2-bundle-cli.test.ts, 7 passed.

New suites: 115 passed, 0 failed. Existing affected regressions passed. Backend/web typecheck and documentation checks passed. Changed-file lint passed. Verification's one changed-file failure (real-I/O membership) was corrected and that check passed on a targeted rerun.

Remaining limitations:
- Full npm run lint: 16 errors and 265 warnings in unchanged files.
- Hosted CI/Merge Gate, PR creation and release were not run.
- OS permissions denied the requested external handoff directory. This worktree file is the fallback result.

BRIDGE_NOTES.md contains exact commands, per-condition coverage, authority metadata changes and diff counts.
