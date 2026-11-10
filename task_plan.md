# Task plan: Grok Bot routine offload

- [x] Inspect existing fleet surfaces and protected paths.
- [x] Implement file-backed drive stub, metrics and Mac job definitions.
- [x] Run fixture tests, typecheck, lint and docs checks; record qualification limits.
- [x] Write BRIDGE_NOTES.md with results and net LOC.

Status: implementation complete, full repository qualification unverified. No commit, push or publication is authorized.

Errors encountered: first fixture assertion counted transitions instead of unique jobs (corrected 5 to 4). Initial typecheck and lint could not start due to incomplete node_modules; reinstalling lockfile dependencies.

Fleet-watch: 13 timeouts repeated in isolation; a focused test against the untouched HEAD fleet implementation reproduced the same timeout. Temporary diagnostic files removed.

Parallel full typecheck/lint produced no further output for about ten minutes; interrupted both (exit 130) and restarted sequentially to reduce resource contention.

Sequential full lint also interrupted after more than five minutes without further output. Changed-file ESLint, strict core typecheck, both lint guards, docs and 54 focused tests passed.
