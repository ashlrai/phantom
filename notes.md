# Queue consolidation sources

Local source commits: #978 287a0811; #991 e12923bd; #992 b1f89fea (fork/codex-bridge/RQ-PH-QUEUE-REPORT-CLI); #1018 1135e8c3. Remote heads remain unverified.

Event measurements use seconds, station reports use hours, controller rates account for slots. Preserve these distinct contracts. Replay remains opt-in with an injected decoder and transport.

Verified source-tree equivalence: controller changes match local fork commit 33ad6ac8; spool replay matches ac551ac4 including its fixup; event metrics match bc5a5167. No duplicate patch needs applying. Controller event fields now inherit QueueEvent.

Focused final validation: 6 modules and 126 tests passed, including CLI registry drift and two new cross-module cases.
