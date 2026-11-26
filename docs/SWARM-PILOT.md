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
frontier-class model. Commissioned Codex/Claude and inventoried local workers
are supported. Unknown IDs return `unsupported-worker-lane`; uncommissioned
native lanes return `subscription-only-lane-required`. Dispatch checks current
account-specific billing and quota. There is no metered fallback.

For local workers, set `localModelConfigPath` in the private runtime and enroll
every selected local worker there; otherwise the pilot holds with
`local-model-readiness-required`. Use the existing pool digest and either
`{"workerId":"ollama","modelDigest":"sha256:<inventory-digest>"}` or
`{"workerId":"lm-studio","runtime":"lm-studio"}`. Their `local-chat` bindings
must use numeric loopback, for example `http://127.0.0.1:11434/v1` or
`http://[::1]:1234/v1`. Admission checks the exact model from the pool:
Ollama checks the pinned content digest in `/api/tags`; LM Studio checks the
exact ID in `/v1/models`, which does not attest a content digest. Neither probe
loads a model, generates output, or follows redirects.

The fleet IDs `agy-neon`, `devin-flash`, and `glm-lite` can return advisory
transport evidence alongside `unsupported-worker-lane`. Antigravity uses the
reported five-hour window or an observed individual-quota 429 with a reset;
Devin requires the existing producer/admission verdict (a logged-out or
unverified CLI stays unknown); GLM reads the fleet's own Z.ai usage window.
Even fresh evidence is not authorization: all three show
`bridge-not-commissioned`. A Security-reviewed bridge into the existing Mac
launchers and same-account billing gate is needed before any dispatch. The
pilot does not change launcher flags, add these providers to pool admission,
or call a remote model to probe readiness.

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

## One-Mac recipe

Use a Mac with a pre-enrolled, commissioned frontier worker and one enrolled
loopback model. From this checkout select their worker IDs and the private
runtime. Use a disposable GitHub repo with separately seeded swarm and control
base branches: both must start at the same fixture commit, otherwise a second
merge would test a different task. Run one arm at a time.

```sh
umask 077
runtime=/absolute/private/resource-runtime.json
repo=YOUR-OWNER/YOUR-DISPOSABLE-REPO
frontier=frontier-seat
local_worker=ollama
work=$(mktemp -d)
phm universe resources check --resource-runtime "$runtime" --json > "$work/pool.json"
pool_id=$(jq -er '.poolId' "$work/pool.json")
pool_digest=$(jq -er '.poolDigest' "$work/pool.json")
node test/fixtures/swarm-pilot-mac.mjs "$work" "$repo" "$frontier" "$local_worker" "$pool_id" "$pool_digest"
phm swarm pilot "$work/swarm.json" --runtime "$runtime" --root "$work/store" --json
phm swarm pilot "$work/swarm.json" --runtime "$runtime" --root "$work/store" --apply --json > "$work/swarm-result.json"
phm universe init --manifest "$work/frontier.json" --root "$work/store" --json
phm universe run mac-frontier --resource-runtime "$runtime" --root "$work/store" --json > "$work/frontier-result.json"
trial=$(jq -er '.trials[] | select(.selected) | .id' "$work/frontier-result.json")
phm universe deliver mac-frontier --trial "$trial" --root "$work/store" \
  --branch codex/swarm-mac-frontier-control --json > "$work/frontier-delivery.json"
```

The fixture creates three independently checkable config edits and pins their
leaf oracles plus a full integration oracle outside the seed repository. The
frontier arm is a single resource-pool attempt with all three files and the same
integration oracle, not a second swarm. Preserve both JSON results and their
token/time usage separately. If either arm is held or fails, retain the evidence
but do not publish or assign a merged-change cost.

Publish the verified heads separately through the normal gated workflow to
their corresponding bases and record each merged PR number. Then run:

```sh
phm swarm pilot-report mac-swarm --root "$work/store" --pr "$SWARM_PR" --json
gh pr view "$FRONTIER_PR" --repo "$repo" --json state,headRefOid,mergedAt,mergeCommit |
  jq -e --arg head "$(jq -er .commit "$work/frontier-delivery.json")" \
    'select(.state == "MERGED" and .headRefOid == $head and .mergedAt and .mergeCommit.oid)'
```

Record one merged change per matching receipt. Compare metered dollars, tokens,
and elapsed time on the same basis. For these enrolled subscription/local arms,
metered spend is zero after verified completion, not fully loaded cost. If
measuring allocated subscription or local compute cost, record those inputs
separately and divide each arm's measured cost by its own verified merge count;
before a matching receipt the metric is unmeasured, not zero.

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
