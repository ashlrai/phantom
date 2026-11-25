# Unwired Fleet Modules

Modules in `src/core/fleet` that have **no non-test importer**. Paths below are
relative to `src/core/fleet/`.

This list is verified, not aspirational:
`test/unwired-modules-doc-31.test.ts` rebuilds the import graph on every run and
fails when this table and the tree disagree — wire a module and its row must
leave this page in the same change, and a new module nothing imports must be
added here. "Unwired" means no file outside `test/` imports the module; it does
not mean dead code. Every entry is a tested building block kept for a caller
that has not been connected yet. Read the module header before wiring or
deleting it, and keep its tests green either way.

| Module | Purpose |
|--------|---------|
| `bus-adapters/codex.ts` | Transport-independent Codex bus worker: drains an admitted inbox and returns replies; no credential discovery or auth-file I/O. Follows the same host contract as the wired `bus-adapters/devin.ts`. |
| `bus-adapters/grok.ts` | One admitted inbox message to a Grok text-only turn to an atomic outbox reply; confers no dispatch or merge authority. |
| `bus-transport-external.ts` | Adapter shape that turns an `ExternalAgentClient` into a `BusTransport` with boundary `external`, for agent services off this machine. |
| `bus-transport-file.ts` | The local bus inbox (`<root>/bus-inbox`) as a `BusTransport`: sends are inbox posts, polls are cursor pages, dead letters post back to the same inbox. Local only; bodies are untrusted. |
| `conflict-resolve.ts` | Mechanical merge-conflict resolution: classifies each conflicted path and resolves only the provably-mechanical ones (union for append-only files, regenerate for lockfiles and generated docs); anything else stays a real conflict for a resolution lane. |
| `fleet-board-read.ts` | Compatibility re-export of the Fleet Board reader (`FLEET_BOARD_SCHEMA`, `readFleetBoard`, `fleetBoardDigest`, …); the canonical reader and wire contract live in `leader-journal.ts` so validation and read bounds stay shared. Only tests still import the shim. |
| `forum/mcp.ts` | One MCP call for the fleet forum (`forumToolIsRead`, `handleForumTool`): read ops stay available when the kill switch is on, writes are refused by the native-tool gate. |
| `goal-drift-ideas.ts` | Pure: turns a goal that is falling off track into one Idea from caller-supplied bound metrics and the ideas still open; unknown data never produces an idea. |
| `kept-landed.ts` | Read-only `fleet.kept-landed.v1` report: which kept worktrees already landed, with evidence (`post-image`, `patch-id`, `none`, `unknown`), change sizes and byte totals. |
| `lane-route-eligibility.ts` | Pure: picks which queue lane may take the next job from a lane-targets snapshot and usage windows, with a plain reason for every lane it skipped. Never writes slots, changes a target or touches billing. |
| `merge-bisect.ts` | Pure, probe-injected bisect planners for the merge pipeline: decides which revisions or subsets to probe; the caller runs the probes. |
| `merge-plan-rework.ts` | Rework edges and superseded-PR proposals for the merge plan: reads `RQ-FIX-`, `RQ-RECUT-`, `RQ-REBASE-BATCH-` titles and body markers across open PRs, with bounded secret-scrubbed text. |
| `nodes-dispatch.ts` | The `phm nodes dispatch` decision: probe gates (reachable, CLI installed, signed in) then one adapter start. The default adapter is plan-only, so every answer is a dry run with the reason until a remote runner is connected. |
| `pick-grader.ts` | Grades each ranker pick 24h and 7d after it was made against the signals it realized (merged, used, stars, installs), nudges the ranker's feature weights toward what happened, and renders pick accuracy for the daily line. |
| `process-vitals.ts` | Process-vitals IO seam: ps-based owner and process sampling behind an injectable interface (home, uid, clock, run, read, signal). |
| `status-grade.ts` | Pure grader for the status-reply contract: a reply may say RECEIVED, ASSIGNED, RUNNING, BLOCKED or VERIFIED only when structured evidence proves it; every grade carries an as-of timestamp and the evidence source. |
