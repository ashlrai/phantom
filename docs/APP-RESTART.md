# App restart and session ownership

Zero-downtime app restart is **not implemented** in this build. The command
below reports why it is held and exits 1. It leaves the app, sessions, jobs,
bundles and authority state untouched.

```sh
phm app restart --json
```

Example result:

```json
{
  "schema": "phantom-app-restart/v1",
  "state": "held",
  "restarted": false,
  "reason": "runtime-ownership-migration-required",
  "blockers": [
    "verse-sidecar-owned-by-ui",
    "interactive-sessions-and-ptys-owned-by-sidecar",
    "computer-use-workers-owned-by-ui",
    "durable-ui-checkpoint-and-reattach-not-implemented"
  ]
}
```

Exit 0 is help, exit 1 is the held restart, and exit 2 is invalid usage.
Unknown flags, bundle paths and update URLs are rejected. The result describes
this implementation's capability, not a live census of the machine.

## Ownership audit

| Resource | Current owner | Consequence of native app exit |
| --- | --- | --- |
| Mac queue jobs and lanes | `contrib/mac/dispatchd.py`, independent subprocess sessions | Not owned by native UI; this alone does not establish live job survival |
| Verse HTTP server | Native shell's `CommandChild` in `desktop/src-tauri/src/main.rs` | `reap_sidecar` terminates its tree |
| Interactive turns | `src/core/verse/session-engine.ts` in Verse | Children, stream readers and cancellation handles depend on Verse |
| Terminal PTYs | `src/core/verse/terminal.ts` in Verse | PTY handles, input, resize and replay buffers depend on Verse |
| Computer use | Worker, monitor and timeout threads in `desktop/src-tauri/src/computer.rs` | Workers die with native process; requests travel through its webview |
| UI tabs and scroll | Webview state and existing browser persistence | No fsynced, acknowledged restart checkpoint covering all requested state |

`desktop/src-tauri/src/sidecar_guard.rs` also kills the recorded sidecar on
signals and reclaims it after a crash. Merely omitting the normal quit handler
cannot establish an independent runtime. The launchd broker foundations in
`desktop/src-tauri/src/native_launchd_broker.rs` explicitly have no production
listener or launch authority and cannot be used as a running service.

The existing signed paired updater in `src/core/desktop/qualified-update.ts`
requires Stop/drain and fresh admission. The installer in
`scripts/local-app-transaction.mjs` stages and verifies a bundle, archives the
previous bundle, and uses exclusive renames. Those two renames are not an
atomic bundle exchange. On smoke failure, a live replacement can hold rollback;
the original is preserved but not automatically restored while the replacement
is running. This does not satisfy the requested smoke-failure behavior.

## Work needed before enabling restart

1. Move Verse supervision to an independent helper using an installed runtime
   outside the replaceable app bundle. Preserve authenticated connection
   custody and process identity; never put tokens in logs or restart receipts.
2. Keep interactive turn and PTY managers in that helper. Reconnect by stable
   session/tab IDs and stream sequence, retaining input, resize and cancel
   controls. Do not recreate a process from a stored transcript.
3. Move computer-use execution behind a helper boundary while retaining consent,
   takeover, TCC, loopback authentication and kill controls. Complete the required
   Security GATES review for protected helper changes.
4. Fence new UI-only actions, wait for current actions to settle with a deadline,
   then write and fsync a versioned UI checkpoint (tabs, selection and scroll).
   Resume UI admission if checkpointing or preparation fails.
5. Have an independent update coordinator perform the verified bundle exchange
   and smoke launch. Stop a failed candidate, restore the previous bundle and
   relaunch it without interrupting the helper runtime. Retain existing signer,
   inventory, ownership and update admission checks.
6. Restore the checkpoint and confirm attachment through the runtime connection.
   A successful `open` or HTTP 200 does not establish attachment.

## Acceptance test still required

On macOS, start three real interactive sessions with continuous output. Record
their stable IDs and OS identities (PID plus start time). Update the app and
verify all three identities survive, output progresses, input and cancellation
still work, and the relaunched UI reports all three as attached with tabs,
selection and scroll restored. Repeat with a failed smoke launch and verify
the old bundle is active. Cover a busy UI-only action, checkpoint failure,
coordinator interruption and simultaneous restart requests.

That test has not been run and is not replaced by unit tests of the held CLI.
