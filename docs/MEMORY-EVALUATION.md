# Offline memory evaluations

Phantom has a source-only synthetic evaluation for the pure memory foundation. It checks retrieval and evidence contracts, with no model calls, private history, application state, providers, native sessions or deployment. A passing result does not establish coding success, autonomous learning, production readiness or universal prompt-injection resistance.

The versioned corpus is `test/fixtures/memory/corpus-v1.json`, protocol `phantom-memory-offline-v1`, seed `20261014`, released as CC0-1.0 synthetic authored data. It assigns 72 cases: six variants in each of twelve behaviors. Every case carries literal expected event IDs, source IDs, source text, status and required exclusion reasons. The selector never receives these expected outcomes. The corpus contains no real conversations or customer facts.

| Behavior | What the variants check |
| --- | --- |
| Temporal | Current replacement, historical valid-time, exclusive expiry, future validity, and explicit knowledge cutoff |
| Delayed import | Old source evidence recorded after a reviewed correction cannot win by import time |
| Conflicts | Incompatible overlapping approved claims cannot silently select a winner |
| Project scope | Similar names, prefixes and case variants do not establish project equivalence |
| Owner and audience | Both exact owner identity and explicit audience admission are required |
| Review and authority | Proposed/disputed evidence is excluded; reviewed withdrawal retires old revisions without fallback; equal-revision approval/withdrawal conflicts are preserved; invented authority or review states are refused; quoted instructions remain data |
| Malformed | Missing fields, invalid IDs/digests/version/revision and broken Unicode cause explicit refusal |
| Tombstones | Admitted deletion invalidates descendants and prevents historical resurrection; foreign or proposed deletion cannot widen scope |
| Lineage | Missing, cyclic, transitive, foreign, unreviewed and expired ancestry blocks derived claims |
| Replay and concurrency | Identical replay, order independence, duplicate IDs, concurrent revisions and explicit supersession remain distinguishable |
| UTF8 and budgets | Whole multilingual facts, citations and framing count toward byte limits; omission reasons are explicit |
| No result and refusal | Empty or irrelevant eligible evidence differs from unknown, unavailable, incomplete and invalid requests |

Valid-time (`current` or `asOf`) and knowledge-time (`knownAt`) are separate. A null knowledge cutoff uses the supplied snapshot's committed watermark. Current admitted tombstones intentionally prevent deleted content from returning through either historical axis. These tests operate on supplied records and claimed review/scope identities. They do not attest who reviewed a fact, authenticate its source, or connect to a runtime store.

The governed arm calls `buildMemoryContextPack`. The comparison arm is a **synthetic flat latest-record diagnostic**. Both receive identical complete history and query bytes, with fresh detached inputs for every call and equal whole-pack byte/fact limits. Both use the same closed schema, shared-pattern screening and exact scope admission. The diagnostic chooses the latest recorded approved value in each slot and intentionally omits temporal validity, contradiction, lineage and relevance governance. This comparison demonstrates the specified fixture contracts; it is not evidence against a tuned static-memory system or a measurement of model quality.

The harness records every assigned case in each arm. Correctness failures and runner exceptions remain in the denominator; exceptions are fixed `runner-error` unknowns, without raw error output. Warm-output changes, wrong citations, forbidden evidence, incomplete expected text, inconsistent receipts, authority claims and framing-budget errors are failures. Unknown source status can be the correct contract outcome; it is distinct from a runner exception. No model judges the output.

Clone the source repository and use its existing development dependencies. The source-only runner uses the repository's installed `tsx`; it never installs dependencies, builds an application or calls a model automatically. It reads only the bundled synthetic corpus and fixed source files, and does not accept a user export path. This command is not included in the npm product package initially.

```sh
npm run --silent eval:memory -- --json
```

The silent npm invocation keeps npm banners out of the JSON stream. The runner exits zero only when all 72 governed cases pass, one when governed cases fail or have runner exceptions, and two for unsupported arguments, missing source/dependencies or observed source drift. It executes source modules, captures the Git SHA/tree/dirty state and exact relevant source/corpus hashes before and after the run, and refuses a changed observation. This is source observation, not signed provenance or an installed-build attestation.

Run the offline regression suite from the checkout:

```sh
npm run test:ci -- --maxWorkers=1 --fileParallelism=false test/memory-foundation.test.ts test/memory-evaluation.test.ts test/memory-evaluation-performance.test.ts test/memory-evaluation-cli.test.ts
```

The pure harness accepts bounded corpus JSON through `runMemoryEvaluation` in `src/core/local-eval/memory-evaluation.ts`. The corpus cap is 1MiB, exactly 72 assigned cases, at most eight events per case, depth 32 and 100000 JSON nodes. It validates six unique variants per family and refuses malformed corpus metadata before invoking either arm. It accepts explicit caller-observed source SHA, tree, dirty state and working-source digest; it does not discover or attest installed bytes. Reports include canonical corpus hash, seed, access policy, per-case evidence, failure/unknown totals, declared environment and timing distributions. Callers must capture an exact source-file hash manifest beside a saved run receipt.

`profileMemoryKernel` in `src/core/local-eval/memory-performance.ts` separately generates bounded histories with a documented integer LCG, fixed UTC time and exact corpus hashes. Profiles declare their event count, seed, complete framing bytes, selected/omitted counts and output digest. The default profile uses 1024 events, a 6KiB evidence-text budget, at most 64 selected facts and ten repeated calls. The tests additionally exercise 128 events. Generation is limited to 4096 events and profiling to 30 repeats; no runtime history is read or written.

First-call and repeated timings use `performance.now` around the pure validation, selection and framing kernel. They are in-process observations. A first call is not a fresh-process cold-start measurement, and repeated calls are not verified cache hits. Quantiles identify the finite sample count; a ten-sample p95 is a small diagnostic distribution. No HTTP responsiveness, concurrency, disk latency, provider time-to-first-token, fleet SLO or 10000-record target is inferred. Source construction, model task utility, paid cost and long-running application behavior remain unevaluated.

The CLI also reports a separate raw-versus-prepared paired profile, protocol `phantom-memory-prepared-paired-profile-v1`. Preparation validates, detaches and recursively freezes a snapshot once; the module records only its own returned instances in a private WeakSet. Reusing that exact module-owned object skips repeated snapshot validation/copying. Arbitrary caller-frozen objects cannot register themselves. Each query still revalidates its own fields and recomputes scope, knowledge-time, valid-time, lineage, conflicts, withdrawals, tombstones, ranking and whole-pack budgets. There is no saved retrieval result or runtime cache, and no store/adapter is activated.

Paired profiles report one-time preparation cost separately. Both arms receive the same complete seeded 128/1024-event history and query, with ten calls per arm. Pair order alternates raw-first and prepared-first, retaining every sample without a selective warmup. Every result must have an identical full pack/receipt digest, framing bytes and selected/omitted counts. Tests also compare all 72 semantic outcomes for raw and module-prepared snapshots. The raw profile remains a separate protocol. Historical receipts retain their original source/configuration; timing variation is reported rather than erased. Preparation reuse is an in-process optimization, not a production latency guarantee, privacy admission, signed artifact or execution permission.

The current foundation screens known credential and generic home-path shapes using shared refusal patterns. That screening is not a complete privacy guarantee. Evidence remains quoted data with `authority: false`; integration, user review, execution authority, hosted CI, package provenance, publication and installed acceptance are separate gates. The larger retrieval benchmark, paired multi-session coding pilot and active-recall experiments described in the research plan remain proposed and unexecuted.

## Quality benchmark

The 72-case corpus checks that each governance rule holds. It does not measure how useful a pack is: most of its queries are empty, every case has at most eight events, and nothing ranks. The quality benchmark, protocol `phantom-memory-benchmark-v2`, measures that separately. It is generated in code from an authored CC0-1.0 catalog (`src/core/local-eval/memory-benchmark-catalog.ts`), so it adds no corpus file and does not change the protected v1 gold.

```sh
npm run --silent bench:memory -- --json            # summaries plus failing case IDs
npm run --silent bench:memory -- --json --cases    # every step's measurements
```

It has 100 cases and 109 steps in five dimensions:

| Dimension | Cases | What it measures |
| --- | --- | --- |
| Retrieval | 66 | Find one of 20 facts in a 26-event history with a top-3 budget. Each fact is asked three ways: sharing exact words (lexical), sharing only word stems (inflected), and sharing no content word (paraphrase). Six more queries have no answer and should return an empty pack. |
| Contradiction | 8 | No silent winner between contested claims, unrelated facts still served, and non-conflicts (agreement, unreviewed, expired or foreign rivals) not mistaken for conflicts. |
| Temporal | 10 | A four-revision chain queried at each interval, at exact boundaries, with a knowledge cutoff, a future correction, a late import and a backdated correction. |
| Withdrawal | 8 | Retirement without fallback, history before it, re-approval, future and unreviewed withdrawals, and isolation from other facts. |
| Task | 8 | Multi-step scripted sessions (fix CI, ship a release, onboard, migrate a database, audit, cross-project work, tight budget, paraphrase). A task passes only when every step's pack has every required fact and no forbidden one. No model executes the task. |

Each step passes when the expected status matches, every required fact text appears in the model-facing pack text, no forbidden text (stale, withdrawn, contested, deleted or foreign) appears, and the budget holds. The report also gives recall, rank-1 rate and mean reciprocal rank, extraneous facts per step, whether a contested slot is mentioned in the pack text, the payload ratio (required fact bytes over pack bytes) and the number of out-of-scope event IDs in receipts. The audience-mismatch withdrawal case depends on an open owner decision, so it is reported under `pendingDecisions` and left out of the scores.

Baseline at `285f7d9d` (PR #725 head), source checkout:

| Arm | Cases passed | Forbidden leaks | Retrieval lexical / inflected / paraphrase / absent | Tasks | Conflicts mentioned | Payload ratio |
| --- | --- | --- | --- | --- | --- | --- |
| Governed | 58/99 | 0 | 19/20, 8/20, 1/20, 1/6 | 4/8 | 0/4 | 3.9% |
| Flat latest-record diagnostic | 22/99 | 12 | 3/20, 3/20, 3/20, 0/6 | 0/8 | 0/4 | 7.3% |

Governed memory passes every contradiction, temporal and withdrawal case and never leaks forbidden text. Its weak points are ranking (word forms and stopwords), filler on unanswerable queries, pack size (about 600 bytes of framing per 55-byte fact, so two facts do not fit a 1 KiB budget) and contested slots that silently disappear from the pack. Receipts expose 437 out-of-scope event IDs across the run, which is the open receipt-scope question on PR #725.

The catalog, queries and expected outcomes were written by the same author as any later ranking change, so they are not an independent held-out set. Paraphrase retrieval needs synonyms or semantics that this benchmark does not supply. Payload ratio is a byte measure, not a tokenizer count.
