# RQ-BACKLOG-GEN findings

- Existing CLI: src/cli/backlog.ts, already dispatched by src/cli/index.ts.
- Existing scoring leaf: src/core/portfolio/scoring.ts.
- Portfolio scanners and backlog are in the Tier-1 closure; do not add imports
  from those into new planning code or change their behavior.
- No router-queue.md, RQ supervisor, seven-repo allowlist or VISION.md schema
  exists in this checkout. NORTH-STAR.md is narrative, not actionable tasks.
- New command is offline and read-only. Source snapshots must be collected by
  the bridge through its existing enrolled discovery; it owns freshness,
  credentials, recurring invocation, queue writes and concurrency.
- Merge review, exact-head checks, credential custody, merge limits, PAUSE and
  kill switches remain separate supervisor requirements; this planner grants
  no execution or merge authority.
- Avoid protected test-name stems (especially router) and protected imports.
- Companion tools used: none.
