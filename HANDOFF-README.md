# RQ-CMP-DESKTOP-LANE-1 handoff

Intended location: `~/.ashlr-runs/handoff/RQ-CMP-DESKTOP-LANE-1/README.md`. That path refused writes (EPERM) from this session, so the copy lives here. Move it there when the path is writable.

Worktree: `/Users/masonwyatt/Projects/ashlrai/wt/RQ-CMP-DESKTOP-LANE-1` (branch `codex-bridge/RQ-CMP-DESKTOP-LANE-1`, base `master`).
Full report: `BRIDGE_NOTES.md` at the worktree root.

## State

- Code and tests are complete in the worktree and uncommitted. Nothing was pushed, tagged or published.
- Files: `src/core/verse/codex-desktop-lane.ts` (new), `test/codex-desktop-lane.test.ts` (new), `src/core/verse/desktop-adapters.ts` (export `readTree`).
- Verified: 25 new tests and 18 existing desktop-adapter tests pass; 12 related verse suites (251 tests) pass; tsgo, eslint on changed files, `verify-changed`, and `check:docs` pass.
- Net LOC: +497 (no deletions).
- Not verified: a live run against the Codex Desktop app. It needs the operator's computer-use grant for Codex and the Verse MCP computer tools on this Mac.

## What the lane does

1. Measures host load and memory. Refuses if load per core is 1.5x or more, or free memory is below 15%. Unknown readings are refused.
2. Refuses any worktree under `~/.codex*`, `~/.ashlr` or `~/.ashlr-runs`, or that is not an existing directory.
3. Submits the task to the Codex Desktop app through the existing gated `computer_*` adapter, with a prompt that bounds the work to the worktree.
4. Collects the result, then reads the worktree's branch, dirty-file count and open PR through git and gh.
5. Reads CMP usage from the visible Codex window only, and returns unknown unless the text matches.

## Pinned items (need a Security package; not changed here)

- **dispatchd lane registration.** A `codex-desktop` lane in `contrib/mac/dispatchd.py` (installed via `contrib/mac/install.sh`) is pinned and Security-reviewed. Not in this change. The lane is currently a library call with no queued-job entry point.
- **Live computer tool channel.** Connecting `runCodexDesktopLaneTask` to the real `computer_*` ToolCall needs the operator's grant on this Mac. The MACCU TCC helper and loopback auth are pinned and were not touched.
- **Usage reader in `usage-signal`.** Wiring the CMP reading into `fleet.json` through an operator reader executable is outside this change. The built-in status reader for codex-cmp reads a `--codex-home`, which is a forbidden path, so it must not be used for this pool.

No patch was generated, because no pinned file was modified.

## Open questions for Mason

1. Approve commit, push and PR for the worktree change.
2. Confirm the Codex Desktop grant on this Mac so a live run can verify the bundle id `com.openai.codex` and the window's usage text, both marked unverified.
3. Decide whether the CMP reading should feed the RQ-RESOURCE-LIVE-1 owner or `usage-signal` directly.

## Constraints kept

- No read, copy or reference of `~/.codex*`, the keychain, app internal databases or any credential.
- One task per Codex app at a time, plus the CPU and memory gate.
