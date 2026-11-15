# Retained PR #4235: stale sweep evidence

Inspected current [sweep](https://github.com/ashlrai/phantom/blob/3261d5ffc0f82e1fa4e340f2c7f0586a7729c596/src/core/intent/sweep.ts) and [schema](https://github.com/ashlrai/phantom/blob/3261d5ffc0f82e1fa4e340f2c7f0586a7729c596/src/core/intent/schema.ts), at `3261d5ffc0f82e1fa4e340f2c7f0586a7729c596`; compared the retained [original sweep](https://github.com/ashlrai/phantom/blob/80f1d451949b26685cafa3ffa973d3933901634d/src/core/intent/ledger.ts#L526-L607) and its [test](https://github.com/ashlrai/phantom/blob/80f1d451949b26685cafa3ffa973d3933901634d/test/intent-ledger.test.ts#L95-L109), at `80f1d451949b26685cafa3ffa973d3933901634d`. Assertions below refer to `preserves directive evidence across threshold, preview and repeated stale intervals` in the [integration test](../test/intent-sweep-preservation-09sqr1.test.ts).

| Original transition | Current persisted transition | Named assertion / assessment |
| --- | --- | --- |
| Stale in-progress, or proposed/queued/unknown with RQ or pull context, requeues | Status becomes queued; next stale interval recommends supersession | Case table and persisted rows; preserved requeue behavior, with advisory follow-up |
| No context or previous requeue proposes supersession, setting closure proposal | Recommendation is sweep evidence; closure proposal remains unchanged | Bare and requeued cases, evidence and proposal assertions; intentional policy difference |
| Existing supersession proposal closes as superseded | Recommendation repeats without changing status or proposal | Proposal case across both intervals; intentional policy difference, never stale closure |
| Merged awaits verification initially, then may propose or close | Merged continues awaiting verification | Merged case with prior sweep and proposal; intentional policy difference |
| Terminal records excluded; staleness requires elapsed time strictly greater than threshold | Terminal records unchanged; equality does not sweep | Terminal equality and threshold assertions; preserved |
| Preview reports recommendations without applying | Preview leaves ledger bytes unchanged; apply rows match persisted status | Preview bytes and applied row assertions; preserved |

The test also checks unrelated records, provenance, prior evidence, and the explicit no-dispatch note through repeated applies. Evidence retention at the schema's maximum evidence limit is not established by this test. This matrix covers stale sweep transitions only; it does not establish full preservation of PR #4235.
