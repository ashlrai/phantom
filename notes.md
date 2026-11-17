# Identity findings

## RQ-FLAT-MESH-1 audit
- Desktop roster hook has no publisher; observe/read merges only Devin, Cursor and Grok.
- CLI identity registration records runtime timestamps, not current job claims.
- iMessage task/loop state has no bus presence publisher; task views contain result tokens, so select fields explicitly.
- Group presence uses a legacy kind with no current task; work feed already has no local role gate.
- Peer inbox checks authenticate sessions and protect recipient mail; shared metadata reads can be added independently.
- v2 has no provider for Instinct or several CLI lanes: keep provider null instead of inventing one.
- All new modules remain outside Tier-1; verify-changed's authority drift checks pass.
- Full lint has 9 existing errors in 3 untouched .github files; changed-file lint is clean.

Roster v1 already persists stable ids, domain, lane/model allowlists and memory.
Orchestration receipts bind job/lane to specialist with assignedAt.
Identity metadata must be optional to preserve old roster snapshots.
Measured outcomes must ignore manually maintained roster statistics.
Peer mapping is descriptive only and must never enter peer authentication.

Implemented optional metadata and immutable configuration using existing roster lock/persistence.
Evidence projection counts distinct job/lane pairs only with unambiguous admitted journal attribution; unknown rates are null. Legacy counters excluded.
Final focused suites: 29/29 passing. Lint, backend/web typechecks, docs, whitespace pass.
Unchanged HEAD archive reproduces four resource-live files absent from Tier-1 closure snapshot (feed, reset-rule, store, types); no authority regeneration performed (Mason-only snapshot and open #6436 scope).

# Findings: RQ-TIERYIELDN16AQ8

- `contrib/mac/dispatchd.py` contains `waste_boost`; investigate its evidence and status path before introducing another policy.
- No supplied live claim or PR names this tier-yield task.
- Changes stay in this worktree. Security review/re-pin is needed before any live dispatcher installation.
- Reused the market's model/tier and included-cost contract; upgrade happens only after lane admission, with no lane change.
- Four focused tests pass, including seven isolated dispatcher scenarios. Status exposes nullable pace and typed upgrade receipts.
- Partial delivery gap: no causal tier-yield optimizer or live acceptance evidence; the supplied measured rollup motivates the explicit behind-pace policy.
