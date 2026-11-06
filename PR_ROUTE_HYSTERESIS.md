Proposed title: Hold dispatcher pool decisions and bound route churn

Pool changes arriving through ready.tsv now respect a persisted 60-minute
residency, with early movement only for explicit authentication failure or zero
quota. Launch receipts permanently lock the pool. Two accepted changes in six
hours exhaust the move budget, including during hard-down incidents; blocked
proposals emit ROUTE_HOLD. Invalid history stops the tick without resetting it.

Adds read-only `phm route explain --json` telemetry, offline incident-count replay,
dispatcher integration coverage and operator/agent documentation.

Security handoff: review security-route-hysteresis.diff and its candidate hash in
BRIDGE_NOTES.md. No live file or security pin was changed. The live auto-route
writer and last-hour event ledger were inaccessible, so production replay and
confirmation that the live writer passes through this boundary remain outstanding.

This is a local PR draft only. Per task instructions no commit, push or remote PR
was created. Validation and exact commands are recorded in BRIDGE_NOTES.md.
