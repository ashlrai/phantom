# RQ-REBASE-PH-13 — per-PR triage dispositions

Batch: bridge PRs 3465, 3461, 3448, 3447, 3443, 3430 against master 2fabe0e20.
Method: `gh pr view`/`git fetch refs/pull/N/head` per PR, merge-base diff vs
master content comparison; residual work ported into this worktree (see
BRIDGE_NOTES.md for the rework summary and verification).

| PR | Disposition | Evidence |
|----|-------------|----------|
| 3465 (RQ-AGL-CKPT-1) | REWORKED | Checkpoint feature absent on master; ported in this worktree (12 files, +818). |
| 3461 (RQ-APIPOOLOBJQ8) | SUPERSEDED | `src/cli/fleet-api-pools.ts` object-pool path and `test/fleet-api-pools-object.test.ts` already on master; master↔PR delta is one unused `type Report` alias and one duplicate fixture line. |
| 3448 (RQ-PARK-AUTOUNPARK-1) | REWORKED | `queue_autounpark.py`, `parked.tsv`, `phm queue parked/unpark`, adaptive merge-cap admission absent on master; ported (master's diagnostics/legacy PARKED-DEP flow preserved). |
| 3447 (RQ-REPORANK-1) | SUPERSEDED | `repo-rank.ts`, `repos-rank.ts`, `REPO-RANK.md`, test, `ranked_records` in restock.py, AGENTS.md/llms.txt/index.ts wiring — all identical or newer on master. |
| 3443 (RQ-AUTOMATIONS-IMPORT-1) | SUPERSEDED | `automations/import.ts`, `automations-import.test.ts`, `automations.ts`, VERSE.md import section, AGENTS.md, llms.txt — identical or newer on master. |
| 3430 (RQ-FIXUP-CI-ONBOARD-1) | SUPERSEDED | PR's doctor/mcp-native refactor (`prewarmDoctor`, parallel prefetch, `NativeToolResult`/`TOOL_TRUNCATION_MARK` in `knowledge/index.ts`, lazy pool-CLI import) present on master in evolved form; residual master↔PR diff is strictly master-newer (extra MCP tools, `checkLocus` probe injection, plugin prewarm). |

4 of 6 PRs can be closed as superseded once the corresponding merged
siblings are confirmed; 3465 and 3448 land via this worktree's rework.
