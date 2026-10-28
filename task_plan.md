# RQ-BACKLOG-GEN plan

Goal: ship an offline, deterministic READY backlog planner with bounded source
snapshots, an explicit seven-repo allowlist and data-only JSON Lines output.

- [x] Inspect repository, recent history, Entire context and protected paths.
- [x] Explore existing backlog patterns independently.
- [x] Implement strict snapshot/queue contracts, refill, deduplication and audit.
- [x] Integrate `backlog plan`, document its bridge contract and add tests.
- [x] Independently review; run typecheck, lint, docs and touched tests with temporary HOME.
- [x] Write BRIDGE_NOTES.md with results and net LOC; leave changes uncommitted.

Decisions: no router schema or seven-repo allowlist exists here. Use JSON Lines
and separately supplied configuration; do not infer authority from queue/source
text. Refill below 3x slots toward 5x. Bridge applies output after rechecking the
queue snapshot. Existing protected scanners remain unchanged; accept their
findings as bounded source snapshots, alongside VISION checklists and issues.

Errors: Entire resume found no checkpoint for this fresh branch. Initial file
discovery found no vision/store.ts, portfolio/vision-scanner.ts or cloud/backlog-sync.ts;
the actual source modules were located instead.
Initial new-test run exposed incorrect table parameterization (fixed). The existing
backlog source-filter test hit its default 5s cold-import timeout twice; rerunning
with the supported 60s cap. Focused lint flagged control-character regex syntax;
replaced with equivalent character-code validation. Process inspection was denied
by the sandbox; no escalation needed.

Status: full typecheck, docs, full/focused lint, 62 touched tests, 9 boundary tests
and actual CLI smoke passed. Independent review found duplicate
READY capacity inflation, permissive VISION fence closure and BOM decoding/hash
issues; all fixed with regression coverage. BRIDGE_NOTES.md records the evidence.
