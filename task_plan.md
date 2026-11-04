# RQ-VIEW-2-REACH
- [x] Inspect shared glance and channel adapters.
- [x] Require paired identity before channel reads, commands, callbacks or replies.
- [x] Update authenticated fixtures and add refusal regressions.
- [x] Run static checks, touched tests and docs; write BRIDGE_NOTES.md.

Errors: global Phantom install EPERM; installed CLI rejects wire status.

Verification: changed-file gate and docs pass. HTTP/Unix-socket checks fail with host EPERM; full lint has 53 existing errors; native types pass. Standard backend/web compiler checks passed; final limitations and counts are in BRIDGE_NOTES.md.

# RQ-APP-CD-2

- [x] Read Phantom gateway instructions and inspect process ownership.
- [x] Identify blockers to a session-preserving app restart.
- [x] Add an explicit, fail-closed restart entrypoint and ownership audit.
- [x] Finish static checks: typecheck passed; full lint failed on unchanged real-I/O membership; affected tests and docs passed.
- [x] Record commands, results, net LOC and remaining work in BRIDGE_NOTES.md.

The requested swap is not implemented: the native app owns both the Verse
process tree and computer-use worker threads. Do not represent a refusal as a
successful restart or a synthetic process test as a native update test.
