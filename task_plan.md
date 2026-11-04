# RQ-VIEW-2-REACH
- [x] Inspect shared glance and channel adapters.
- [x] Require paired identity before channel reads, commands, callbacks or replies.
- [x] Update authenticated fixtures and add refusal regressions.
- [x] Run static checks, touched tests and docs; write BRIDGE_NOTES.md.

Errors: global Phantom install EPERM; installed CLI rejects wire status.

Verification: changed-file gate and docs pass. HTTP/Unix-socket checks fail with host EPERM; full lint has 53 existing errors; native types pass. Standard backend/web compiler checks passed; final limitations and counts are in BRIDGE_NOTES.md.

## RQ-PARK-AUTOUNPARK-1

# Task Plan: RQ-PARK-AUTOUNPARK-1

- [x] Inspect Phantom guidance and existing restock behavior.
- [x] Implement parked queue admission and read-only CLI.
- [x] Add offline regression coverage and docs.
- [x] Run required verification and write BRIDGE_NOTES.md.

Keep all changes uncommitted. Do not touch dispatchd.py or live queue files.

Errors: global npm install denied by filesystem permissions; installed phm rejects wire status.

Verification: 13 new queue tests and 44 existing Python tests pass. Changed-file gate and docs pass. Standard backend/web typecheck passes. Full lint has 2 errors in unchanged files; see BRIDGE_NOTES.md. Initial real-I/O membership failure fixed by registering the new suite in the required lane; first Python invocation needed PYTHONPATH=contrib/mac.
