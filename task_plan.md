# RQ-ADAPTER-NEUTRAL-1

## Goal
Route OS-1 surface/model selections through transport adapters, preserve existing execution gates, and leave a tested uncommitted handoff.

## Phases
- [x] Inspect repository instructions, existing OS-1 registry and dispatch paths.
- [x] Define dispatch contract and adapters, wire the command planner.
- [x] Add regression coverage and document remaining provider branches.
- [x] Run checks and write BRIDGE_NOTES.md with exact results and net LOC.

## Decisions
- No commits, pushes, external messages or live installs.
- Use temporary HOME for tests and preflight to avoid protected account directories.
- Keep provider protocol details inside adapters and keep execution authority downstream.

## Errors encountered
- Global npm installation refused with EPERM. Retrying under a temporary prefix.
- Host queue ready.tsv access refused by filesystem policy. Host lease cannot be inspected here; do not claim a verified lease.
- Installed CLI MCP list timed out at 15 seconds with isolated HOME.
- Temporary-prefix install completed with Phantom 3.30.33. Its docs, MCP list and wire status commands passed with isolated HOME.
- Initial typecheck failed because tsgo is absent; initial lint failed because ESLint lib/cli.js is absent. Sanctioned worktree dependency repair is running.
- Worktree install and donor healing succeeded. First repaired typecheck found adapter return-type inference; fixed with an explicit adapter table type.
- First test run: 182 passed, 7 failed. Six failures used cached module exports while adapters were moved into the existing engine registry; rerun the current source. Existing engine watchdog test failed because its descendant did not start within the fixture deadline.
- `phm claim acquire RQ-ADAPTER-NEUTRAL-1 --lane codex-personal --repo ashlrai/phantom --json` returned unavailable. The host lease is not verified.
- verify-changed: Tier-1 closure passed, CODEOWNERS failed because the new test needs its generated owner entry. Use the dedicated CODEOWNERS generator; authority:regen would also rewrite the Mason-only closure snapshot and is not used.
- Current-source serial rerun: new adapter, registry and engine modules pass so far, including the watchdog case.
- Current-source focused run completed: 189 tests passed. Backend/web typechecks and docs/generated checks passed. Final verify-changed passed after CODEOWNERS generation and repairing shared shallow ancestry.
- Extra native suites: 69 passed, 32 failed. Native setup hits diskutil timeouts; nested sandbox-exec is refused by the host. Do not weaken identity or confinement gates to pass.
- Additional authority/CLI/boundary run: 17 passed, 2 failed. The four apps modules already occur in HEAD's closure snapshot, so this is existing boundary debt outside this adapter task.
- Full lint enumerated the old adapter module before relocation and failed ENOENT after removal. Rerunning with the final source layout; changed-file lint passed.

## Status
Handoff complete. Source checks pass; broader native/baseline failures and full-lint errors outside the diff are recorded in BRIDGE_NOTES.md. All changes remain uncommitted.
