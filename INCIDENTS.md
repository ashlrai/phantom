# Incidents

## 2026-11-06 — RQ-GUARDIANHEALTHQ8: guardian inspection blocked

Guardian health is unknown. No runtime failure or recovery has been verified.

The requested `bin/main-guardian.py`, `supervisor/status-main-guardian.md`,
and `guardian/guardian.log` are absent from this worktree. Inspection of those
paths under `/Users/masonwyatt/.ashlr-runs` returned `Operation not permitted`.
No Locus tools are exposed in this session; `locus whoami --json` reports an
expired session. No credentials were read or changed.

No host files were edited, no service was restarted, and no backup was possible
because the source files could not be read. Both incident and bridge documents
were absent before creation. No guardian regression test was added: the runtime
failure has not been diagnosed. Existing switch tests do not establish daemon health.

Recovery handoff: resume with host read access and a valid, operator-established
Locus session. Inspect the three requested files and service registration, back
up files before any edit, diagnose the failure, add and run its regression test,
then verify a fresh status and an error-free guardian cycle. Respect existing
Security pin requirements for any protected runtime file. Do not infer that a
missing worktree file means the host service is unloaded.
