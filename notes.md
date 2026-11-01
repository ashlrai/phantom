# Investigation notes

- Initial branch: codex-bridge/RQ-GRAPH-ROUTE-B at a6f3c323; clean worktree.
- Entire resume: no checkpoint found for this branch.
- Node: v22.22.3.
- .github/CODEOWNERS explicitly protects backpressure.ts, router.ts, dispatch-router.ts and tick-hooks-live.ts. User also forbids Tier-1 edits; requested narrow exception before editing them.
- quota.ts rolling-window reservations are separate durable authority and must remain intact.
- No relevant prior implementation found in the quick memory lookup.
- toolsUsed: [] (no Phantom companion tools required).
- Explore agent confirmed that account seat IDs (codex-cmp) differ from shared engine lanes (codex). DispatchRouterContext has no active-per-seat count; live dispatch reserves selected-batch turns by lane only.
- A quota-only helper would not affect production routing. Complete enforcement needs protected router/live-hook integration and concurrency reservation lifecycle, while leaving rate-limit reservations intact.
- Recommended semantics if authorized: validate floor/ceiling safe integers; refill eligible seats below their floor first; exclude ceiling-full seats using active plus planned reservations. Floors never override grants, readiness, quotas, backpressure, or resource limits.
- Baseline selected backpressure/router tests: 2 files, 89 tests passed. The combined filter silently ignores absent pool-floor.test.ts, so ran the exact acceptance selector separately; it fails with no test files found.
- Initial node_modules had corrupt/missing TypeScript and ESLint files. `HOME=$(mktemp -d) npm ci --ignore-scripts --no-audit --no-fund` completed successfully (395 packages); source/package/lockfile unchanged.
- After repair, typecheck (backend and web) passed; lint passed with 0 errors and 206 existing warnings, including both custom lint guards. Documentation checks passed (225 local links, 124 source links, no errors). Final baseline: 140 unique tests passed, no test failures; missing acceptance file remains unmet.

# Reset window findings
- Reuse readResourceLedger; subscriptionUsage's publishing path is unnecessary for this read-only view. Reuse its percentage type.
- Credit balances lack percent denominator/expiry evidence; do not invent projections.
- Initial lint and test attempts encountered incomplete installed dependencies; repairing with npm ci --ignore-scripts.
- Final acceptance: 14/14 passed; targeted ESLint, docs and CLI help passed. Full lint/typecheck stopped after prolonged silence under host load above 100; see BRIDGE_NOTES.md.
