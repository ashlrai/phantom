# fleet.lanes.v1 fixture — RQ-PHANTOM-ENG-CONSOLE

A captured router queue directory for `phm fleet lanes --queue-dir <abs>` and
`getFleetLaneSnapshot({ queueDir })`. Synthetic and inert — ids, pools,
timestamps and balances are illustrative, not a live queue copy.

`queue/` holds one of every input the projection reads:

- `ready.tsv` — header-form queue export (READY, LAND rows with `at`).
- `queue.v1.json` — DRIVER-1 queue document (READY / CLAIMED / PR-OPEN / DONE).
- `jobs.jsonl` — transition ledger: two in-window merges (`codex-cmp` LAND,
  and one resolved to `local-omlx` through the queue's job→pool map), one
  out-of-window LAND, one FAILED non-merge.
- `usage-readings.log` — journal rows for `grok-ultra` (observed) and
  `terra@cmp` (pctUsed null → unknown credit).
- `budgets/` — pool-budget ledger batch (devin ACUs, codex-cmp weekly+credits).

Window anchor used by the suite: `now = 2026-10-28T02:00:00Z`
(merge cutoff `2026-10-28T01:00:00Z`).

Expected lanes (at the anchor): devin depth 2 / live 1 / merges 1 per hour /
`12.5 ACU`; codex-cmp depth 1 / live 1 / merges 1 per hour /
`64% weekly · 3 credits`; local-omlx live 1 / merges 1 per hour / capacity
unknown; grok-ultra depth 1 / usage-journal `64% window`; `terra@cmp` lane
present with unknown credit.
