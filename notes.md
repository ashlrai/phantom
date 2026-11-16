# Rebase scheduler findings

- Initial worktree is clean.
- Scheduler: scripts/queuegen.mjs calls src/core/drive/queuegen.ts; shared coverage comes from src/cli/fleet-rebase-plan.ts and src/core/fleet/rebase-plan.ts.
- Existing tests already cover head changes and retries; there is no interprocess serialization. Coverage is read before execution and active and failed rows for the same id can disagree across queue sources.
- Plan: serialize the scheduler cycle before reading evidence; reconcile history only from complete successful open-PR reads; exercise simultaneous processes, restart after interrupted state save, and failure retries.
- Implemented with existing process-owned local-store lock; no lock age expiry, native owner checks preserved. This host denies ps, so competing processes may report unavailable rather than verified contention; both refuse writes.
- Affected tests: 104 passed; authority checks: 10 passed; full typecheck, docs and changed verification passed. Terminal reconciliation removes emission history; it does not terminate running workers.
- No provided live claim or open PR explicitly covers RQ-REBASEDEDUPQ8.
- No companion MCP tools called; no credentials required for local implementation.
