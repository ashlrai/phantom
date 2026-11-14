# PR #4235 failure-path evidence

Compared retained original `80f1d451949b26685cafa3ffa973d3933901634d` with current base `155ebde0f9848316fc7fc74428cbccf805b7e9c6`. The executable evidence is `test/intent-failure-preservation-10sra1.test.ts`, using only synthetic roots and directives.

| Case | Original evidence | Current observation |
| --- | --- | --- |
| Invalid JSON, invalid ledger structure, or existing file over 2 MiB | Original `src/core/intent/store.ts` `readLedger` rejects each; original `ledger.ts` `listIntents`, `getIntent`, `addIntent`, and `updateIntent` call it before returning or writing. Original `test/intent-ledger.test.ts` does not exercise these failures. | All four operations reject and retain exact fixture bytes. An explicit fixture repair is needed before retrieval and a subsequent successful update. |
| Invalid update after a valid field was changed in memory | Original `ledger.ts` `updateIntent` validates fields before `writeLedger`; the original test covers a refused secret-shaped add followed by retrieval, not this update. | A blank owner after a valid title change rejects, preserves exact bytes, and permits a later successful update retaining the original title. |
| Summary of unreadable state | Original `ledger.ts` `intentSummary` catches failures and returns `present: false` with zero counts. | Summary instead marks source unavailable and counts unknown; its numeric fields remain zero placeholders, not observed completion. This is an added safety distinction. |

The current `writeLedger` validates the full schema before writing; the original writer checked the schema tag. The original and current readers both call schema validation, whose implementation has evolved. Existing `intent-ledger-read-integrity-09spm1` covers nested schema failures and unavailable summary; `intent-edit-preservation-09spy1` covers CLI refusals and an RQ limit. This test exercises the recovered public operations and byte preservation together. It does not establish equivalence for every invalid record, concurrent access, I/O failure, import, release replay, or the entire PR. No production behavior was changed and no real ledger was examined.
