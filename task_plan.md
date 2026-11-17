# Merge queue latency and recovery

- [x] Inspect Phantom guidance and existing queue integration.
- [x] Add measured state latency and guarded auto-merge recovery within 200 changed implementation/test/doc lines.
- [x] Run touched tests, typecheck, lint, verify-changed and docs checks.
- [x] Review diff and write BRIDGE_NOTES.md; leave changes uncommitted.

Errors: global Phantom install and Codex gateway wiring denied by host EPERM.
Locus session expired; live PR overlap lookup unavailable. Supplied fleet view
contains no matching claim or PR. Existing Phantom 3.30.31 remains usable.

Status: complete; 79 tests pass, typecheck/docs/verify-changed pass.
Full lint has 9 existing errors in untouched .github files (see BRIDGE_NOTES.md).
Initial missing dependencies repaired with install:worktree; test formatting fixed.
