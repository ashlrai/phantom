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

The harness records every assigned case in each arm. Correctness failures and runner exceptions remain in the denominator; exceptions are fixed `runner-error` unknowns, without raw error output. Warm-output changes, wrong citations, forbidden evidence, incomplete expected text, inconsistent receipts, packs whose receipt, stop reasons or text identify an event outside the admitted scope, authority claims and framing-budget errors are failures. Unknown source status can be the correct contract outcome; it is distinct from a runner exception. No model judges the output.

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
npm run --silent bench:memory -- --check           # regression gate: exit 1 below any floor
```

CI runs `--check` on one Linux job. It fails when the governed arm drops below the floors in `src/core/local-eval/memory-benchmark-floors.ts`, which hold the current numbers: cases passed per dimension and per retrieval set (paraphrase recall and unanswerable-left-empty alike), no forbidden text, no out-of-scope receipt IDs, every contested slot mentioned, and no pack over its byte or fact budget. Case counts must match too, so a set cannot be shrunk to pass. Raise a floor in the change that raises the measurement.

It has 500 cases and 509 steps in six dimensions:

| Dimension | Cases | What it measures |
| --- | --- | --- |
| Retrieval | 262 | Find one of 20 facts in a 26-event history with a top-3 budget. Each fact is asked three ways in the authored catalog: sharing exact words (lexical), sharing only word stems (inflected), and sharing no content word (paraphrase). Four more sets of 40 paraphrases (held-out, unseen, fresh and second fresh) were written by separate agents that saw only the facts. The first two come with six questions no fact answers; the last two with twelve, at least eight of them deliberately close to the stored topics. Six authored queries also have no answer. Unanswerable queries should return an empty pack. |
| Contradiction | 8 | No silent winner between contested claims, unrelated facts still served, and non-conflicts (agreement, unreviewed, expired or foreign rivals) not mistaken for conflicts. |
| Temporal | 10 | A four-revision chain queried at each interval, at exact boundaries, with a knowledge cutoff, a future correction, a late import and a backdated correction. |
| Withdrawal | 8 | Retirement without fallback, history before it, re-approval, future and unreviewed withdrawals, and isolation from other facts. |
| Agent writes | 204 | Questions over histories written the way independent agents write memory: near-duplicates under different keys, newer facts that contradict older ones without superseding them, facts whose cited code later changed, weakly cited claims next to cited ones, writes that carry a credential or private path, and cited lines that are only reformatted. Four sets (two of 32 scenarios, two of 24) were written by separate agents; credentials appear as placeholders that expand to fake values of the real shapes. A step passes when it serves one fact from each group that answers the question, with no wrong or stale fact, no second copy of the same fact, and a notice when the question needs one. |
| Task | 8 | Multi-step scripted sessions (fix CI, ship a release, onboard, migrate a database, audit, cross-project work, tight budget, paraphrase). A task passes only when every step's pack has every required fact and no forbidden one. No model executes the task. |

Each step passes when the expected status matches, every required fact text appears in the model-facing pack text, no forbidden text (stale, withdrawn, contested, deleted or foreign) appears, and the budget holds. The report also gives recall, rank-1 rate and mean reciprocal rank, extraneous facts per step, whether a contested slot is mentioned in the pack text, the payload ratio (required fact bytes over pack bytes) and the number of out-of-scope event IDs in receipts. A case whose expected outcome depends on an open owner decision is reported under `pendingDecisions` and left out of the scores; none is pending now.

Baseline at `285f7d9d` (PR #725 head), source checkout:

| Arm | Cases passed | Forbidden leaks | Retrieval lexical / inflected / paraphrase / absent | Tasks | Conflicts mentioned | Payload ratio |
| --- | --- | --- | --- | --- | --- | --- |
| Governed | 58/99 | 0 | 19/20, 8/20, 1/20, 1/6 | 4/8 | 0/4 | 3.9% |
| Flat latest-record diagnostic | 22/99 | 12 | 3/20, 3/20, 3/20, 0/6 | 0/8 | 0/4 | 7.3% |
| Governed, after the ranking, view-header and conflict-line changes, on #744 | 77/100 | 0 | 20/20, 20/20, 1/20, 3/6 | 7/8 | 4/4 | 4.8% |

Governed memory passes every contradiction, temporal and withdrawal case and never leaks forbidden text. At `285f7d9d` its weak points were ranking (word forms and stopwords), filler on unanswerable queries, pack size (about 600 bytes of framing per 55-byte fact, so two facts do not fit a 1 KiB budget) and contested slots that silently disappear from the pack. Receipts exposed 437 out-of-scope event IDs across the run at `285f7d9d`; on #744, which drops out-of-scope exclusions from receipts, they expose none, and the audience-mismatch withdrawal now retires the fact as #744 decided.

The follow-up change ignores function words, folds simple English suffixes, breaks ties by term rarity, states the query view once on the evidence tag instead of in every fact, and adds a line naming any contested slot the query touches. It fixes word-form retrieval and every conflict mention, and keeps the 72-case corpus at 72/72. What remains: paraphrase retrieval (no synonyms), three unanswerable queries that still match an incidental word (`friday`, `use`, `name`), and the tight-budget task. Each fact still carries about 440 bytes of citation and validity JSON, mostly its full source reference, because the conformance judge requires the complete citation in the text. Citing the source by ID and digest, with the quote only when it differs from the fact, is the next size lever and needs that contract changed.

The authored catalog's queries were written by the same author as the ranking changes, so they are not independent. The held-out set was written by a separate agent but was read while the vocabulary was being written, so it is not clean either. The unseen set was written by another agent after `src/core/memory/vocabulary.ts` was frozen (sha256 `c60cc212...`) and was never read before scoring; it is the honest measure of paraphrase retrieval. Payload ratio is a byte measure, not a tokenizer count.

### Paraphrases and citation size

The next change adds a fixed vocabulary of 31 engineering synonym groups (`compile` for build, `ship` for release or deploy, `credentials` for secrets, and so on). It also makes pack-text citations references: each source appears as its ID and digest, with the quote only when the quote differs from the fact text. The full source records, with locator and observation time, stay on `items[].sourceRefs`. The conformance judge now accepts either full citations or references that match the fixture's IDs and digests exactly.

On the #746 head, scored with the same 192 cases:

| Governed | Before | After |
| --- | --- | --- |
| Cases passed | 89/192 | 164/192 |
| Authored paraphrase | 1/20 | 18/20 |
| Held-out paraphrase (read while writing the vocabulary) | 0/40 | 34/40 |
| Unseen paraphrase (written after the vocabulary froze) | 0/40 | 27/40 |
| Unanswerable: authored / held-out / unseen | 3/6, 6/6, 6/6 | 3/6, 4/6, 5/6 |
| Tasks (steps) | 7/8 (15/17) | 7/8 (16/17) |
| Forbidden leaks | 0 | 0 |
| 72-case conformance corpus | 72/72 | 72/72 |

A fact now takes about 350 bytes of pack text, down from about 440, so the two-fact step fits in 1 KiB. The three-fact step in 1.25 KiB still misses by a few dozen bytes. The vocabulary costs some precision: three separately written unanswerable questions now match a fact through a synonym (for example "who signs off on expense reimbursements" reaches the release approver), and packs carry about one extra fact per retrieval step.

### Abstention and the three-fact budget

The next round tried to win back the unanswerable questions without losing paraphrase recall. The rule chosen on the authored, held-out and unseen sets was: drop a fact reached only through one vocabulary synonym that three or more eligible facts share. Before measuring, it was fixed that the rule would ship only if a set written afterwards by another agent (fresh) showed a net gain. It did not, and a second fresh set agreed, so the rule is not shipped:

| Governed, top-3 | No rule (shipped) | Synonym abstention |
| --- | --- | --- |
| Held-out paraphrase / unanswerable | 34/40, 4/6 | 32/40, 5/6 |
| Unseen paraphrase / unanswerable | 27/40, 5/6 | 26/40, 6/6 |
| Fresh paraphrase / unanswerable | 25/40, 2/12 | 24/40, 2/12 |
| Second fresh paraphrase / unanswerable | 27/40, 1/12 | 26/40, 2/12 |
| Extraneous facts per retrieval step | 1.41 | 1.15 |

The fresh sets show the real limit: a question about database backups shares `database` with the database facts as strongly as a real paraphrase does, and no word-level threshold tried (synonym-only matches, share of uncovered query words, match ratio) separates the two without giving up more answers than it saves. Empty packs for near-topic questions need a meaning signal this deterministic ranker does not have.

The same round fits the three-fact step in 1.25 KiB. A fact leaves out `observedAt` when it equals `validFrom` and `validUntil` when it is null, under a default stated once on the boundary tag, and the conformance judge checks that every emitted fact restores to the fixture's time fields. A typical fact drops from about 350 to about 300 bytes; the three-fact step takes 1,176 of 1,280 bytes and all eight tasks pass (17/17 steps). The 72-case corpus stays 72/72 with no forbidden leaks.

### A meaning signal for near-topic questions

The protocol was set before measuring: tune thresholds on the authored sets and set A only, then ship an off-by-default flag only if sets B, C and D each gain. Phantom's existing embedding path is local Ollama. No Ollama model was reachable from the measuring environment, so the test used Model2Vec static vectors (potion-base-8M and potion-base-32M, MIT), which are deterministic table lookups. Three uses were tried:
- Gating the lexical pack by cosine.
- Ranking by cosine alone.
- A union of the two.

None beat the lexical ranker even on the tuning sets. Static vectors separate answerable from unanswerable questions only weakly (AUC about 0.65), so nothing ships. A real signal needs a contextual encoder through the local Ollama path (for example `all-minilm` or `bge-small`). It would pass the pack precomputed similarities, so the pack stays pure, and CI would read committed vectors keyed by model digest. The same protocol would then be rerun.

### Facts written by agents

Autonomous agents hurt memory most on the write side. Two separate agents each wrote 32 scenarios of agent-authored writes for fictional services, 8 for each hazard. Every write is approved, the worst case where nobody reviews agent writes. The fixes in `pack.ts` were chosen while reading the first set (tuning). The second set (validation) was scored only after they were frozen; the one change made after that kept its numbers identical and only made the same-citation rule stricter (it now also requires a shared topic stem).

| Governed, questions passed | Tuning: before | Tuning: after | Validation: before | Validation: after |
| --- | --- | --- | --- | --- |
| Near-duplicates | 1/10 | 5/10 | 6/16 | 8/16 |
| Silent contradictions | 0/8 | 1/8 | 1/10 | 2/10 |
| Stale code | 4/14 | 10/14 | 8/14 | 11/14 |
| Weak evidence | 1/16 | 13/16 | 3/15 | 12/15 |
| All | 6/48 | 29/48 | 18/55 | 33/55 |
| Questions served a wrong or stale fact | 24 | 4 | 22 | 9 |
| Duplicate facts served | 16 | 4 | 15 | 8 |

Three rules do the work, all after ranking:
- Checkable evidence (`file:`, `commit:` or `command-output:` locators with a real quote) ranks first and withholds unverified claims it outscores.
- Restatements of a selected fact are withheld as duplicates.
- Facts whose cited source the caller reports as changed are withheld, with a notice line.

What remains:
- **Cross-key contradictions.** A newer fact under different keys that contradicts an older one is still served next to it in 8 of 18 questions. A value-disagreement detector was tried on the tuning set and gained at most one question, so it was not shipped. Evidence links (below) later took this on.
- **Over-cautious source checks.** A cited line that changes in a way that leaves the fact true still withholds the fact (2 tuning and 2 validation answers lost). The check compares quotes, not meaning.
- **Screening refusals.** Six histories held a write that trips content screening, for example "authorization request header" or a local database URL, and the pack refused the whole snapshot. That is fixed below. One question still trips screening ("access token") and is refused, because a query is screened as a whole.

#### Credential-bearing writes and cosmetic edits

The same separate agent wrote two more sets, 24 scenarios each: 12 where one agent's write carries a credential or private path (in the fact or only in its quoted source) next to clean writes by others, and 12 where cited lines change. Some changes are only reformatting or comment edits, and some really change the fact. Both fixes were frozen on the first set (W3, "kestrel") before the second (W4, "quarry") was scored.

| Governed, questions passed | W3 tuning: before | W3 tuning: after | W4 validation: before | W4 validation: after |
| --- | --- | --- | --- | --- |
| Credential-bearing writes | 3/28 | 25/28 | 2/26 | 22/26 |
| Cosmetic edits | 17/23 | 20/23 | 15/24 | 19/24 |
| Any case holding a screened write or query (all hazards) | 3/32 | 26/32 | 2/29 | 24/29 |

- **Per-write screening.** A write that fails screening is withheld alone instead of refusing the snapshot. No credential-bearing write was served before or after, and no pack in the benchmark contains screened content.
- **Formatting-tolerant source check.** `memorySourceQuotePresent` replaces the exact substring check, so whitespace and trailing-comment edits no longer withhold a true fact, and real changes still do.
- The flat diagnostic passes 3/28, 2/23, 2/26 and 6/24 on the same questions.

Still open: a fact whose cited comment is reworded with the same meaning is withheld, and a quote-only comment edit that only drops a period still counts as a change. The three W3 credential misses are false alarms in the shared screening patterns: the clean answers ("minted with `kestrelctl token mint --role admin`", "The Slack bot token is read from SLACK_BOT_TOKEN") are withheld because `token` followed by a word reads as a token value. The other W3 miss is a duplicate. W4's misses were not inspected, to keep it unseen for later rounds. Earlier W1 questions that were refused whole now serve: one of them shows a cross-key contradiction that the refusal used to hide.

`--check` holds these numbers. It fails on fewer passes in either set, more questions served a wrong or stale fact (ceilings: 5 tuning, 9 validation), more duplicates (5, 10), or any credential-bearing write served. Every other dimension must still leak nothing.

### Cross-key evidence links

A later commit diff, a commit message naming the old quote's identifier or file, or a re-read of the same line now retires the older fact (`source-changed`), whatever keys either was written under.

| Silent contradictions | Before | After |
|---|---|---|
| Tuning (W1) | 1/8 | 4/8 |
| W2 validation (seen while building the commit-message rule) | 2/10 | 3/10 |
| W5, 16 fresh histories by a separate agent, scored once after the rules were frozen | 3/16 | 7/16 |

Steps serving a stale or wrong fact fell from 14 to 10 on the old sets and from 11 to 7 on W5, and no case regressed. W5 joins the validation set (516 cases). What remains is not connected by evidence: stale docs that repeat an old value, and an agent reading the wrong file. A notice for unverified claims that disagree with a cited fact was tried and dropped: 10 of its 11 notices on the tuning side were spurious.
