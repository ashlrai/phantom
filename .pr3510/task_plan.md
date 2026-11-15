# PR #3510 update

- [x] Inspect PR state and Phantom gateway documentation.
- [x] Fetch current master (306ef16aa58543eb15daaa02719ee2141b3e1fe0) and compare the existing patch.
- [x] Port only changes not already landed; retain all fourteen newer stages.
- [x] Run changed-file verification, docs checks and affected tests; record failures without weakening gates.
- [x] Write BRIDGE_NOTES.md with commands, counts and limitations.

Final instruction prohibits commits, pushes, tags and publication. Leave a local uncommitted update.
Errors: global npm install and gh config failed EPERM; wire status exit 1; shallow histories have no local common ancestor. Fetch succeeded. Root planning files were already tracked; restored them and moved this job's planning files here.

Verification: docs passed; new COS tests 10/10 passed. verify-changed stopped on authority drift: CODEOWNERS scan timed out at its existing 30s limit, and runtime closure grew by 12 modules. Snapshot regeneration is Mason-only per AGENTS.md; no regeneration or gate relaxation. Run explicit lint/typecheck because verify-changed stopped before reaching them. Focused suites still running.

Final: all verification completed. CODEOWNERS rerun and full backend/web typecheck passed. Focused runs: 186 passed, 3 failed; authority closure remains failed. Full lint: three errors in two unchanged test files and 273 warnings; changed files have zero ESLint errors. Real-I/O guard fails on 16 unchanged tests; console-I/O guard passes. Local candidate and handoff are ready for review, while remote update/green Merge Gate/enqueue remain incomplete under the stated constraints.
