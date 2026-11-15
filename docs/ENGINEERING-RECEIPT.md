# Engineering receipt

Opt-in (`PHANTOM_RECEIPTS=1`, default off). `phm engineering-receipt --events <file.jsonl> [--claims <file>] [--task <text>] [--json]`
builds a receipt that separates **Evidence** from **Claims**.

Evidence is derived only from recorded tool events (JSONL lines of
`{"type":"task"|"edit"|"command", ...}`; commands carry `command`, `exitCode`
and optional `output`). Model text is never parsed for facts. It is only
compared against the evidence. Output is never stored: counts are parsed from
it (vitest/jest, pytest, cargo), then it is dropped.

Evidence covers the commit SHA, typecheck and build results, test counts
(passed/failed/skipped) per suite, integration runs, whether a deploy was
attempted and its target (`not attempted` otherwise), and the verification
scope (`local`, `ci` after `gh run`/`gh pr checks`, `staging`/`prod` after a
smoke command following a deploy to that target).

Claims come one per line from `--claims`. A claim with no supporting evidence,
or whose only evidence predates the last edit, is flagged `UNVERIFIED`. An edit
with no later test, typecheck or build is flagged `no-check-after-edit`.
Every string is passed through the secret scrubber and command lines are
capped at 300 characters.
