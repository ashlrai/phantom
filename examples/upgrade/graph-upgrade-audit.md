# Graph upgrade audit

From the Phantom repository root, with dependencies already installed, run:

```sh
npx tsx examples/upgrade/graph-upgrade-audit.ts --node 'task:example'
npx tsx examples/upgrade/graph-upgrade-audit.ts --help
```

Supply the exact saved node ID. The audit uses the installed checkout's public graph loader and neighborhood reader, with both directions and a 500-node bound. It reads the loader's normal local inventory; it does not build an index or change graph data. Except for help, stdout contains one versioned JSON object and a newline. It reports availability, whether the root was found, counts of reachable `task` and `output` nodes (including the root), loader completeness, source states, and neighborhood truncation. Counts are observations within the bounded neighborhood, not global totals. Issue codes and related-node counts are retained, up to 128 issues; messages, IDs, source paths, graph records and other private values are omitted. `issuesTruncated` reports the output limit. Unknown metadata is `null`.

`evidenceComplete` requires the loader to report completeness, both sources loaded, and an explicitly empty issue list. A missing or partial source, unknown metadata, or neighborhood truncation prevents verification. A complete inventory may still have no task coverage: the current loader seeds fleet, repo, lane, seat and hold records, not task or output records. Consequently, an absent task ID cannot be disproved by this inventory; it returns insufficient evidence. A found task or output record can be counted if a future reader supplies it. This audits the reader in this checkout, not a separate running application.

Exit codes:

- `0`: the root was found with complete evidence and an untruncated neighborhood; also used for help.
- `1`: a fleet-kind ID was absent from complete evidence, or the reader failed; errors are static.
- `2`: invalid arguments or ID; no graph read occurs.
- `3`: unavailable, incomplete, unknown or truncated evidence, including an absent ID outside the current fleet inventory's supported kinds.

A `not_found` result means a supported fleet-kind ID is absent from complete evidence. For `insufficient_evidence`, `rootFound: false` only means the ID was not observed; it does not establish that the node is missing. An unavailable graph has `rootFound: null`.
