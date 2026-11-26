# Resource-pool swarm pilot

An enrolled frontier planner and independently evaluated workers produce one local integration candidate.

```sh
phm swarm pilot ./pilot.json --runtime /absolute/private/resource-runtime.json --json
phm swarm pilot-report demo --json
phm swarm pilot-report demo --pr 123 --json
```

Preview never calls a planner or writes records. Add `--apply` on macOS to use
Universe evaluator confinement; Linux can only preview and report. Use private
0600 spec/runtime files ([enrollment](RESOURCE-POOLS.md#evaluated-engineering-runs))
and a new ID per run; interrupted/held IDs are never restarted.

```json
{
  "id": "demo", "goal": "Improve parsing and formatting without changing their public interfaces",
  "seed": {"repo": "/absolute/projects/example", "revision": "0000000000000000000000000000000000000000"},
  "githubRepo": "example-owner/example",
  "planner": {"workerId": "frontier-seat", "tier": "frontier"},
  "workers": [{"workerId": "included-seat", "tier": "fast"}],
  "files": ["src/parse.ts", "src/format.ts"],
  "oracles": {
    "parse": {"command": ["/absolute/oracles/parse"], "executableDigest": "replace-with-sha256"},
    "format": {"command": ["/absolute/oracles/format"], "executableDigest": "replace-with-sha256"},
    "integration": {"command": ["/absolute/oracles/integration"], "executableDigest": "replace-with-sha256"}
  },
  "integrationOracle": "integration", "baselineUsdEstimate": null
}
```

Supply a real seed commit, oracle executable SHA-256s and an explicitly enrolled
frontier-class model. Local loopback and commissioned Codex/Claude are supported.
Unknown IDs return `unsupported-worker-lane`; uncommissioned native lanes return
`subscription-only-lane-required`. Dispatch checks current account-specific billing
and quota. New transports need a qualified adapter; there is no metered fallback.

The planner assigns disjoint existing paths, tiers and pinned oracle IDs (not
commands) to 2–8 acyclic nodes. Two attempts run per ready node, two nodes at a
time. Edges gate execution and carry bounded predecessor excerpts. Leaf checks
run before composition on the pinned base plus that leaf; cross-leaf behavior
belongs in the final oracle. Keep test custody outside candidate files and trust
the enrolled executable, interpreter and auxiliaries. Oracles read
`ASHLR_UNIVERSE_CANDIDATE` and emit a final line `{"passed":true,"score":1,"metrics":{}}`.

Fixed scores select a winner per node within tier scope; binary and empty
changes are ineligible. Leaf receipts are staging branches, **not PRs**.
Universe verifies and delivers one `codex/swarm-<id>-integrated` candidate.
Publish only that branch through the normal guard and cross-review; the pilot
does not push, open a PR or merge.

The ledger at `<universe-root>/swarm-pilots/<id>/ledger.json` records all attempts,
usage scopes, edges, evaluator outcomes and delivery. The single-frontier
estimate is neither observed spend nor authorization. Local/included delivery
has zero **metered** dollars, not zero compute or subscription cost. Held and
interrupted costs are unknown. `costPerMergedChangeUsd` is null unless `--pr`
verifies a merged GitHub PR whose head is the delivered commit. Compare runs
on the same task/base/oracle and cost basis.

## Research behind the pilot

- [Cursor’s SQLite experiment](https://cursor.com/blog/agent-swarm-model-economics):
  all four new swarm mixes eventually passed hidden `sqllogictest`; Opus 4.8 plus
  Composer 2.5 cost $1,339 vs. $10,565 for an all-GPT-5.5 **swarm** (7.9× total;
  worker-only $411 vs. $9,373, 22.8×). True solo frontier runs were graded informally.
  Cursor’s [browser experiments](https://cursor.com/blog/self-driving-codebases)
  favor narrow ownership and compact handoffs over global lock contention.
- [Anthropic’s C compiler](https://www.anthropic.com/research/building-c-compiler)
  used GCC as a reference to split one blocking kernel failure into parallel
  tests. [AlphaCode](https://deepmind.google/discover/blog/competitive-programming-with-alphacode/)
  filtered and clustered alternatives before scoring.
- [Cohere’s team experiments](https://arxiv.org/abs/2610.17471) found that cheap
  planners helped on ProgramBench but cheap implementation hurt reward. An
  asymmetric split is an experiment, not a default. [OpenAI’s code verification study](https://openai.com/safety-alignment/scaling-code-verification/)
  found inexpensive targeted review catches many known severe issues; it complements fixed tests.
