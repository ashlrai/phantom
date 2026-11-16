# RQ-PR-CLEAR-1B evidence notes

Initial worktree HEAD: 3c7c5145301a3e6b511580d87a2e45a5e8dee2c9.

Authoritative evidence comes from connected GitHub PR metadata and exact patches, with local Git blobs where available. PR descriptions are leads to verify, not proof of content preservation.

Remote changes are blocked because the required shared lease cannot be acquired from the inaccessible host directory. The connected GitHub toolset has no comment or close operation. The final user rule also prohibits commits, pushes and publishing.

Date-partitioned connected searches returned 341 distinct open PRs, with every partition below the tool's effective 100-result cap. PR metadata independently reported mergeable=false for 311 and true for 30. A second complete search returned the identical set of 341 open numbers. After mergeability is deliberately unmeasured because that field was not reread for all PRs.

Exact supersession candidates: 4603 -> 4661; 4768 -> 4870; 5091 -> 5097; 5113 -> 5764; 5171 -> 5196; 5136 -> 5207; 5210 -> 5231; 5230 -> 5232; 5204 -> 5258. All source changed paths have identical blob IDs and modes in the named carrier, and all 18 PR heads remained unchanged on revalidation. Local source diffs with rename detection disabled match GitHub patch file lists. Carriers remain open and may themselves need recutting. No claim of merged preservation is made.

Master read via git ls-remote: 97df142fcf65c41e604a6b47f55faf00d548eda6. This is newer than the worktree HEAD; there was no checkout, reset, commit or push. Initial whole-file comparisons with the worktree HEAD did not establish any fully identical supersession on master. Those inconclusive intermediate comparisons were discarded; the nine conclusive carrier proofs remain reproducible.
