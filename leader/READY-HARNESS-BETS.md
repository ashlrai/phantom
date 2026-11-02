# READY harness bets

Prepared 2026-10-31 against `origin/master` at
`0a5fa2cfd4aaea75cf799598e1f8f1e279418782`. Research and handoff only;
none of these bets is implemented. Source IDs refer to [the digest](INSPIRATION.md).
READY means a bounded implementation contract, not permission to activate a
runtime. All listed implementation and NEW test paths were checked against the
fetched CODEOWNERS and are unprotected; recheck before starting each future PR.
Each estimate includes implementation plus new regression tests, below 400 lines.
Keep existing protected suites read-only; use the hermetic test runner.

## B1 — READY: abstain when retrieval has no evidence

- Evidence: S1, S3, S6; inspected `retrieve`, `buildPrompt`, `ask` in knowledge/ask.ts.
- Implementation: `src/core/knowledge/ask.ts`.
- NEW tests: `test/harness-abstention-31k.test.ts`.
- Change: discard zero/nonfinite keyword scores; if no usable hits remain, return a deterministic insufficient-evidence answer and empty sources before synthesis. Keep existing response shape and local/cloud consent semantics.
- Acceptance: empty index, unrelated keyword query and invalid scores make zero synthesis calls and return no citations; a positive lexical match still answers with repo/file/line evidence. Mock model/embedding seams; use temporary synthetic index fixtures, no network.
- Dependencies: none; land before B3 to define the no-evidence branch.
- Size: 180 lines maximum target, one concern: evidence-free synthesis.
- Benefit: desktop users see uncertainty instead of plausible unsupported answers; agents stop propagating irrelevant citations. Measure zero unsupported citations on a fixed unrelated-query fixture set.
- Verification: `npm run test:ci -- test/harness-abstention-31k.test.ts test/m32.knowledge-progress.test.ts`; typecheck, lint, check:docs.

## B2 — READY: validate persisted citation coordinates

- Evidence: S2, S3, S7; inspected `readChunksFile` and `isKnowledgeChunk` in knowledge/index.ts.
- Implementation: `src/core/knowledge/index.ts`.
- NEW tests: `test/harness-chunk-admission-31k.test.ts`.
- Change: require finite positive integer start/end lines with end >= start and nonempty repo/file labels; optional vectors must be nonempty finite-number arrays, otherwise omit the vector while retaining a valid lexical chunk. Do not resolve file paths, scan sources, or change scrubbing.
- Acceptance: negative/fractional/reversed coordinates and empty labels are excluded; malformed vectors fall back to keyword retrieval; valid legacy chunks without vectors remain readable; mixed JSONL retains valid neighbors. Use temporary files and synthetic strings.
- Dependencies: none; B3 should consume only admitted vectors.
- Size: 200 lines maximum target, one concern: persisted chunk admission.
- Benefit: desktop citations have usable coordinates; agents avoid NaN ranking and malformed evidence. Measure complete rejection of the adversarial coordinate fixture set with all valid legacy fixtures retained.
- Verification: `npm run test:ci -- test/harness-chunk-admission-31k.test.ts test/knowledge-memory.test.ts test/m32.knowledge-progress.test.ts`; typecheck, lint, check:docs.

## B3 — READY: fuse ranks instead of incomparable scores

- Evidence: S1, S3; local mixed cosine/keyword sorting is the motivating observation, not a vendor-endorsed ranking algorithm.
- Implementation: `src/core/knowledge/ask.ts`.
- NEW tests: `test/harness-rank-fusion-31k.test.ts`.
- Change: independently rank finite positive cosine matches and positive keyword matches, combine reciprocal ranks with fixed k=60, dedupe by repo/file/start/end, tie-break by that tuple, then apply existing TOP_K/context caps. Keep per-hit method attribution accurate; no new dependencies or embeddings service. Positive similarity is a candidate signal, not proof of relevance.
- Acceptance: high raw lexical magnitude cannot dominate solely by scale; overlapping matches occur once; input permutation does not alter ties; unavailable embeddings preserve keyword-only behavior; unrelated keyword-only queries still abstain. Mock embeddings and use fixed synthetic chunks.
- Dependencies: B1 and B2; separate PR after both, since B1 shares the same file.
- Size: 280 lines maximum target, one concern: retrieval ordering.
- Benefit: desktop answers and agent handoffs favor corroborated evidence without inflating context. Measure reciprocal-rank on a small labeled synthetic set versus existing raw-score sort; require no keyword-only regression and record results rather than promising a universal gain.
- Verification: `npm run test:ci -- test/harness-rank-fusion-31k.test.ts test/harness-abstention-31k.test.ts test/harness-chunk-admission-31k.test.ts`; typecheck, lint, check:docs.

## B4 — READY: observe thread delivery failures safely

- Evidence: S2, S4, S5, S7; inspected `createFleetThreadBus`, which already counts handler failures and unlogged hops.
- Implementation: `src/core/fleet/event-bus.ts`.
- NEW tests: `test/harness-bus-diagnostics-31k.test.ts`.
- Change: add an optional synchronous `onDeliveryFailure` observer to FleetThreadBusOptions, receiving only allowlisted message ID, recipient ID and enum stage (`handler` or `hop-log`). Guard observer throws. Do not pass message bodies, exception text, config, or inferred receipt status.
- Acceptance: handler rejection and log failure each emit one matching stage; a throwing observer leaves delivery totals and next-recipient behavior unchanged; TTL-expired and left recipients produce no false failures; disabled bus produces no callbacks. Fake clock/log sink, no persistent output.
- Dependencies: none; existing best-effort semantics remain, with no retries, replay or authority change.
- Size: 200 lines maximum target, one concern: failure diagnostics.
- Benefit: existing desktop/agent consumers can distinguish delivery failure from missing hop logging without exposing content; UI wiring is a later concern. Measure exact observer cardinality against deterministic failure fixtures.
- Verification: `npm run test:ci -- test/harness-bus-diagnostics-31k.test.ts test/m241.event-bus.test.ts`; typecheck, lint, check:docs. Existing event-bus test is protected: execute only.

## B5 — READY: explain deferred dispatch assignments

- Evidence: S1, S5–S7; inspected planner capacity, candidate and parent-tier filters.
- Implementation: `src/core/fabric/concurrent-dispatch.ts`.
- NEW tests: `test/harness-dispatch-reasons-31k.test.ts`.
- Change: add optional bounded reason metadata to DispatchPlan for each unassigned input position: `capacity`, `candidate-filter`, or `parent-tier`. Record the reason at the existing decision branch; preserve unassigned WorkItems and all assignments. Use input position so duplicate item IDs do not collide; never include task text or backend credentials.
- Acceptance: fixtures cover all-zero slots, candidate rejection, required editing backend and parent-tier exhaustion; every unassigned position has exactly one reason; assignments match the pre-change planner on the same fixtures, including builtin fallback. Inject candidate/tier resolvers; no real backend calls.
- Dependencies: none; no changes to slots, routing authority, billing, host admission or kill checks. Precedence when multiple blockers apply: parent-tier restriction, then candidate-filter if no allowed candidate exists, otherwise capacity; evaluate existing filters once and reuse results.
- Size: 260 lines maximum target, one concern: explain planner deferral.
- Benefit: desktop and agent clients can explain why work waits without recommending unsafe capacity overrides; UI wiring deferred. Measure full reason coverage and identical assignment outputs across the synthetic matrix.
- Verification: `npm run test:ci -- test/harness-dispatch-reasons-31k.test.ts test/m255.concurrent-dispatch.test.ts`; typecheck, lint, check:docs.
