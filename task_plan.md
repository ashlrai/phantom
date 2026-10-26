# Task plan

- [x] Inspect command registration and protected telemetry APIs.
- [x] Implement read-only top panel and versioned JSON.
- [x] Add fixture snapshots and JSON contract coverage.
- [x] Run focused tests, typecheck, lint and docs checks; write bridge notes.

Constraints: no protected path edits, new credentials, publication, commits or pushes.

Validation issue: pre-existing node_modules had corrupt TypeScript and missing ESLint files. Restoring with npm ci --ignore-scripts before rerunning checks. Initial Vitest stalled and was interrupted.

Final status: complete. Focused tests 5 passed, 0 failed; 3 saved snapshots verified. Typecheck (backend and web), lint, docs and whitespace checks passed.
