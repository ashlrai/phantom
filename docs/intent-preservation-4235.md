# PR #4235 intent preservation evidence

Comparison baseline: requested original SHA `26cf8dc07f254d21d374b6e87dcba69196fd43a3`; current master `f13762baf9f9d21fb0c6838040e1a8bab407828c`. The requested SHA resolves to a desktop rustls pin commit and has neither `src/core/intent/ledger.ts` nor `src/cli/intent.ts`. The fetched PR head resolves to `80f1d451949b26685cafa3ffa973d3933901634d`, a different SHA. Consequently the original operations cannot be independently verified against the specified baseline; the operation names below are identified by current source comments and the stated recovery scope, not by an inspection of that original. Preservation of the full PR is **unproven**.

| Original operation or capability | Current path and export | Executable coverage | Assessment |
| --- | --- | --- | --- |
| Import and deduplicate directives | [importIntentFiles](../src/core/intent/import.ts), [sameDirective](../src/core/intent/schema.ts) | [roundtrip](../test/intent-preservation-roundtrip-09sps1.test.ts) | Preserved for the exercised repeated input, including provenance; broader equivalence unknown. |
| Associate merged PR | [linkMergedPull](../src/core/intent/evidence.ts), [cmdFleetIntentEvidence](../src/cli/fleet-intent-evidence.ts) | roundtrip | Preserved for named RQs and terminal status; caller-supplied evidence does not verify a merge. |
| Record shipped release | [markShipped](../src/core/intent/evidence.ts), [noteShippedRelease](../src/core/intent/release.ts), [cmdFleetIntentEvidence](../src/cli/fleet-intent-evidence.ts) | roundtrip | Persisted for the named RQ and independently read back; evidence does not prove publication. |
| Read and summarize | [cmdFleetIntentRead](../src/cli/fleet-intent-read.ts), [readFleetIntent](../src/mcp/fleet-intent-read.ts), [intentSummary](../src/core/intent/summary.ts) | roundtrip | Current CLI, MCP reader and summary exercised; original interface equivalence unknown. |
| Stale/superseded closure | [sweepStale](../src/core/intent/sweep.ts) | [sweep tests](../test/intent-sweep-reconcile-09spd1.test.ts) | Intentional difference: the stated original automatically closed superseded work; current sweep recommends supersession and does not close it. Original behavior remains unverified at the supplied SHA. |
| CRUD, world integration, merge-snapshot caller and remaining original operations | Pending recovery; exact original comparison unavailable | None claimed here | Unknown until present on master and independently compared. |

This matrix records bounded source and test evidence. It is not evidence of installed or shipped UI, and is not authority to close #4235.
