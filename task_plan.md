# RQ-VIEW-2-REACH
- [x] Inspect shared glance and channel adapters.
- [x] Require paired identity before channel reads, commands, callbacks or replies.
- [x] Update authenticated fixtures and add refusal regressions.
- [x] Run static checks, touched tests and docs; write BRIDGE_NOTES.md.

Errors: global Phantom install EPERM; installed CLI rejects wire status.

Verification: changed-file gate and docs pass. HTTP/Unix-socket checks fail with host EPERM; full lint has 53 existing errors; native types pass. Standard backend/web compiler checks passed; final limitations and counts are in BRIDGE_NOTES.md.
