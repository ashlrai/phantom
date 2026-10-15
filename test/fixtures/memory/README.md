# Synthetic memory corpus v1

`corpus-v1.json` is CC0-1.0 authored synthetic test data. It contains exactly 72 assigned cases (12 behavior families, six variants each), protocol `phantom-memory-offline-v1`, seed `20261014`. The frozen JSON bytes and hashes in run receipts define the reproducible history. Synthetic command labels use seeded variation; they are not real commands observed in user histories. No account, private project, credentials or provider conversation was used.

Gold status, selected event IDs, cited source IDs, source text and required exclusion reasons are literal fixture expectations. They were authored independently of the memory selector. The harness withholds gold from both evaluated arms, compares cited payloads directly with the selected literal fixture event, and independently parses emitted JSON evidence lines. Intentionally malformed snapshots/queries are assigned refusal cases, not invalid corpus metadata.

`knownAt` and valid-time are distinct. Current reviewed deletion cannot resurrect historical source evidence. Withdrawal cases preserve append-only prior approvals, exercise newer unlinked revocation, and refuse concurrent approval/withdrawal at equal revision. The fixture claim `reviewed` does not attest a real review, and synthetic source digests do not authenticate external sources.

The small semantic corpus is separate from the deterministic LCG-generated 128/1024-event performance histories. Neither evaluates a model, coding task, provider, runtime store, HTTP path, live runtime cache or deployment. See `docs/MEMORY-EVALUATION.md` for exact limits and reporting qualifications.
