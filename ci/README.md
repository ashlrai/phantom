# Affected map audit

Run `node scripts/audit-affected-map.mjs` from any directory to list source modules with no directly importing test and tests with no direct source import. The command exits nonzero when either list contains a path absent from `ci/affected-map.json`. The optional first argument selects a different tree for auditing.

The audit scans JavaScript and TypeScript modules under `src/` and test or spec files under `src/` and `test/`. It recognizes literal relative imports, exports, `require`, and dynamic imports, including `.js` specifiers that resolve to TypeScript. It does not follow transitive imports, path aliases, computed imports, subprocesses, or filesystem-based tests. Consequently, a gap is a review signal, not proof that a file is untested. The audit is advisory and does not select tests for CI.

When reviewing an intentional new gap, update the corresponding sorted array in the baseline with the path and explain the reason in the change. Remove entries when gaps disappear. Never regenerate the baseline blindly to silence failures.
