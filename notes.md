# Identity findings
Roster v1 already persists stable ids, domain, lane/model allowlists and memory.
Orchestration receipts bind job/lane to specialist with assignedAt.
Identity metadata must be optional to preserve old roster snapshots.
Measured outcomes must ignore manually maintained roster statistics.
Peer mapping is descriptive only and must never enter peer authentication.

Implemented optional metadata and immutable configuration using existing roster lock/persistence.
Evidence projection counts distinct job/lane pairs only with unambiguous admitted journal attribution; unknown rates are null. Legacy counters excluded.
Final focused suites: 29/29 passing. Lint, backend/web typechecks, docs, whitespace pass.
Unchanged HEAD archive reproduces four resource-live files absent from Tier-1 closure snapshot (feed, reset-rule, store, types); no authority regeneration performed (Mason-only snapshot and open #6436 scope).
