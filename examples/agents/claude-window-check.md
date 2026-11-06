# Claude window check

From the repository root:

```sh
npx tsx examples/agents/claude-window-check.ts
npx tsx examples/agents/claude-window-check.ts --runs-dir /path/to/runs --samples 3 --interval-ms 5000
```

This read-only workflow composes the public resource ledger and runs projections; it makes no provider calls and does not change holds or budgets. It reports every ledger or runs lane named `claude` or beginning `claude-`, plus `claude` and `claude-api` as unknown when absent. Output is JSON lines, one report per sample. The default is one sample; `--samples` accepts 1–10 and `--interval-ms` accepts 1000–60000 only with at least two samples (default 5000). SIGINT and SIGTERM stop waiting and return 130. Help and errors are JSON too.

Each lane has the public window (`weekly`, `credits`, `none`, or `null` if absent or unrecognized), observed `usedPct`, `creditsRemaining`, `resetAt`, `source`, `held`, `heldReason`, `holdKind`, and `violation`. Null means unknown, not zero or available capacity. `holdKind` is `authentication` when a matched held reason explicitly indicates authentication; otherwise it is `unknown`. It never classifies a hold as quota exhaustion. A reason is associated with the ledger only when both readers have matching timestamps, running/target values, and held state; `join` is `matched`, `mismatched`, or `unknown`. The runs reader can omit lanes it does not recognize, so their reason may remain unknown. Separate observation timestamps and source-health fields are included; a matching join does not guarantee freshness. Missing or degraded sources do not establish availability.

A violation is an explicit five-hour window in a Claude ledger row, not text found in a message or hold reason. `violationCount` covers all observed lanes, even when output is capped at 100 rows; `lanesOmitted` records truncation. The workflow does not inspect non-public status fields or infer the provenance of a generic reset timestamp. Exit code 0 means the reads completed without a violation, including missing/degraded sources; 1 means a violation or unexpected read failure; 2 means invalid arguments; 130 means interrupted. Read errors do not expose source contents.
