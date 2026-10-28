# queue.v1 contract fixtures

A queue.v1 module has since landed in `src/core/queue/` (schema, markdown
importer/exporter, store) behind `phm queue add|claim|done|block|list|import|
export`. It implements a seven-status job store; the restock contract and the
LAND/SPLIT-PARENT statuses below remain part of the unmerged
RQ-PHANTOM-DRIVER-1-QUEUE upstream API.

router-queue.md is a synthetic, inert fixture of the eight requested status
shapes. It is not represented as an authoritative copy of an unavailable live
file. Its PR numbers, worker, and branch are illustrative. Do not execute its
entries. Replace or reconcile these lines against the upstream fixture when
the owning module and its documented grammar land.

router-queue-import.md is the seven-status import fixture for the landed
queue.v1 markdown importer; test/queue.test.ts round-trips it byte-for-byte.

The runnable tests check fixture coverage and preservation-sensitive content.
The three explicitly skipped cases record the unavailable production contracts:

1. Import every line with all schema fields intact, including LAND BASE_OVERRIDE.
2. Export the imported document byte for byte, including comments, blank lines,
   unknown fields, ordering, and freeform notes. Also check semantic stability
   after reimport and the module's documented newline behavior.
3. Exercise every documented restock skip rule independently, plus an eligible
   READY control and mixed eligible/ineligible input. Cover all seven other
   statuses and BASE_OVERRIDE according to the owning contract. Do not infer
   eligibility from these fixture labels alone.

Bind those cases to the real exported API and enumerate its skip reasons when
RQ-PHANTOM-DRIVER-1-QUEUE merges. No replacement parser, guessed API, or invented
restock policy is used to claim production coverage in the meantime.
