# Impact reward v1

`phm metrics impact --json` reads local evidence and emits the single reward
contract `phantom-impact/v1`. It makes no network requests or model calls, writes
no state, and cannot dispatch, authorize, merge, release, or publish work.

```sh
phm metrics impact --json --jobs jobs.jsonl --queue graph.json --overrides impact-labels.json
```

All three paths are local files. `--queue` and `--overrides` are optional. The
default job source is `$ASHLR_HOME/metrics/jobs.jsonl`, or
`~/.ashlr/metrics/jobs.jsonl`. An absent default source reports `complete: false`
and `totalReward: null`. An explicit missing file, malformed row, conflicting
snapshot, unresolved reference, or unsupported schema fails with exit code 1.
Invalid command arguments exit 2. An existing empty ledger is a complete empty
dataset. Completeness describes parsing the supplied files, not fleet coverage.

## One reward contract

The pure implementation is [impact.ts](../src/core/metrics/impact.ts). For each
merged PR, gross impact is the weighted sum below, multiplied by ambition.
Dimensions are bounded to 0..1. Missing evidence earns no credit; it does not
prove that a capability or cost was absent.

| Dimension | Weight | Evidence without an override |
| --- | ---: | --- |
| User-facing capability | 30 | Exact `impact:capability` label or queue tag |
| Autonomy gained | 25 | `impact:autonomy` |
| Unblocking | 20 | `min(1, dependentJobs / 5 + criticalPathDepth / 5)` |
| Fleet-loop improvement | 20 | `impact:fleet-loop` for routing, speed or self-improvement |
| Production reach | 15 | `impact:released` or `impact:published`; merge alone gives no reach credit |
| Repository breadth | 10 | `min(1, max(0, repoCount - 1) / 4)` |

Ambition is `1 + 2 * scope + 2 * risk + novelty`, bounded to 1..6:

- `scope = min(1, (additions + deletions) / 1000 + uniqueFiles / 20)`.
- `risk` is 1 for `risk:tier-1`, 0.5 for `risk:tier-2`, and 0 otherwise.
- `novelty` is 1 for `impact:novel`, otherwise 0.

Labels and tags are exact tokens, case insensitive. The highest stated risk
tier wins unless overridden. Diff size alone creates no impact. Saturation
limits rewards for padding. Reward is gross impact minus penalties minus
`tokens / 1_000_000`. This token conversion is a fixed reward-unit calibration,
not a dollar estimate. Missing tokens deduct zero, not a claim of zero usage.

Penalties are:

- Trivial merged work: 8, when explicitly labeled `impact:trivial` or when
  known additions plus deletions are at most 10, at most one file is present,
  and the weighted impact is zero.
- Empty work: 25. Applies to an explicit `empty` job or a merged PR with known
  zero additions, zero deletions and an explicitly empty file list. Empty work
  receives no gross impact and no additional trivial penalty.
- Unfixed revert: cancels all gross impact, then subtracts 25. A fix-forward
  merge must occur after the most recent recorded revert to restore credit.
- Churn: 2 per file rewritten by another merge in the same repository during
  the preceding 48 hours, capped at 20. The boundary is inclusive. Equal merge
  timestamps are ordered by canonical PR ID. This is a file-overlap proxy, not
  a semantic judgment that every repeated edit was wasteful.

Failed attempts receive zero gross impact, no failure, trivial, churn or revert
penalty, and pay only their recorded token cost. Failed attempts with ambition
at least 3 count as exploration. Pending work earns no impact and contributes
no observation to template statistics. Reporting an attempted job as `empty`
is a separate negative outcome from an ambitious failed attempt.

The acceptance suite checks a large landed Tier-1 change against ten trivial
merges, failed bold exploration against empty work, and maximum-impact unfixed
reverts remaining negative. Weight, threshold, penalty, or exploration formula
changes require a new reward version and corresponding tests.

## Job and PR import contract

The source contract is `phantom-impact-source/v1`. Use one JSON object per line.
Every job requires `id`, `repo`, and `status`; `schemaVersion`, if present, is 1.
Supported statuses are `merged`, `failed`, `empty`, `pending`, and `done`.
`done` without merge metadata is pending, not landed impact.

```json
{"schemaVersion":1,"id":"RQ-EXAMPLE","repo":"ashlrai/phantom","template":"capability","status":"merged","tokens":120000,"tags":["impact:autonomy"],"pr":{"number":42,"mergedAt":"2026-10-26T10:00:00Z","additions":600,"deletions":150,"files":[{"path":"src/feature.ts"}],"labels":[{"name":"impact:capability"},{"name":"risk:tier-1"}]}}
```

PR fields accept GitHub-style `labels: [{name}]` and `files: [{path}]`, or arrays
of strings. A PR number must be a positive safe integer. A non-null `mergedAt`
must be a valid UTC ISO timestamp with optional millisecond precision. A
`merged` status requires this metadata. For unmerged attempts, additions,
deletions, files and labels may instead be supplied at job level. Token and
diff counts must be nonnegative safe integers. `template` and `tags` are optional.

Canonical identities are `repo#number` for PRs and `repo:job-id` otherwise.
Identical snapshots count once; conflicting snapshots of the same identity
are rejected. Reconcile attempt history and aggregate known attempt tokens
upstream into one observation per PR before import. The command does not infer
which conflicting row is authoritative or count repeated PR rows as successes.

On a merged PR, `pr.reverts` and `pr.fixedForwardFor` refer to another canonical
PR identity in the supplied dataset. Targets must be distinct, earlier merged
PRs in the same repository. A fix earlier than a subsequent revert cannot
erase the later penalty. Both the original PR and the follow-up PR retain
their own observations, costs and churn evidence.

Sources are advisory imported metadata, not authenticated GitHub evidence.
Release labels, manual labels and graph edges must be prepared by the caller
from its evidence. The import never replaces the fleet's existing independent
merge-credit and admission checks. It reads no credentials and grants no
authority. Each file is limited to 16 MiB and the ledger to 20,000 rows; the
reader rejects non-regular files and does not silently truncate data.

## Queue and graph signals

`--queue` accepts an array of nodes or `{ "schemaVersion": 1, "nodes": [...] }`.
It uses the existing mission graph's `key`, `repo`, and `dependsOn` vocabulary;
`id` is also accepted for a queue key. A node's key matches the original job ID.
`tags` can supply the same exact impact labels as PR metadata.

```json
{"schemaVersion":1,"nodes":[{"key":"RQ-EXAMPLE","repo":"ashlrai/phantom","tags":["impact:fleet-loop"]},{"key":"RQ-FOLLOWUP","repo":"ashlrai/stack","dependsOn":["RQ-EXAMPLE"]}]}
```

Unblocking counts unique transitive dependents. Critical-path position is the
longest downstream dependency path, in edges. Breadth counts the job repository
plus distinct repositories of those dependents. A diamond graph counts its
shared descendant once. Cycles, duplicate keys, dangling edges and mismatched
job repositories fail. Bounds are 2,000 nodes and 128 dependencies per node.
Jobs absent from the graph receive no graph-derived credit. No priority or
critical-path claim is guessed from a title.

## Manual labels

`--overrides` accepts a versioned JSON object keyed by canonical identity:

```json
{"schemaVersion":1,"overrides":{"ashlrai/phantom#42":{"capability":0.8,"autonomy":1,"unblocking":0.5,"fleetLoop":1,"productionReach":0,"repoBreadth":0.25,"novelty":1,"riskTier":1,"trivial":false}}}
```

Every field is optional. Numeric dimensions must be finite and within 0..1;
`riskTier` is 1, 2 or 3 and `trivial` is boolean. Explicit zero overrides a label.
Unknown fields and unknown target IDs fail. Overrides cannot mark a PR merged,
clear a revert, change token costs or remove churn evidence.

## Shared consumers and router-feed boundary

`scoreImpact` is the sole observed reward function. `rankImpactTemplates` groups
those observations by template and adds deterministic UCB-style exploration:

```text
bonus = 20 * (1 + (maxTemplateAmbition - 1) / 5)
        * sqrt(2 * ln(totalTemplateObservations + 2) / max(1, templateAttempts))
rank = meanObservedReward + bonus
```

Cold starts are finite. Bold templates get a larger bonus; failed exploration
remains a real attempted observation. Sorting breaks ties by template name.
The bonus is reported separately and never added to observed reward totals.

- [The bandit adapter](../src/core/fabric/optimizer.ts) returns advisory ranking
  and a recommended template from that shared function.
- [The JEV adapter](../src/core/decide/impact.ts) returns the same per-job rewards
  ordered by observed impact, without calling a model.
- [Automation triage](../src/core/decide/triage.ts) accepts optional
  `impactHistory` and `impactOverrides` in its context. Shared template ranks
  order matching playbooks and supply versioned reward and exploration evidence
  to the existing JEV question and cache key. This adds no model calls. Absent or
  invalid history preserves existing ordering; work and lane controls remain
  intact.

The JSON report exposes `outcomes`, `templates`, `bandit`, and `jev` with the
same version. This change provides the offline contract and real triage hook;
automatic router ledger collection and supplying history to production callers
belong to RQ-METRICS-ROUTER-FEED. No background consumer is activated here.
