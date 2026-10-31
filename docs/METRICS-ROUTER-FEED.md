# Local router metrics feed

```sh
phm metrics ingest --jobs ./jobs.jsonl --status ./status.json --json
```

The command reads two explicit local files and prints JSON to stdout. It never
contacts a provider, GitHub, a URL or a model, writes a store, discovers a home
directory, or dispatches work. `--json` is optional because output is always
JSON. Exit 0 means a valid report or help; exit 2 means bad arguments or refused
input. Input errors produce a controlled diagnostic on stderr, without raw
records or paths. No dependencies or credentials are added.

## Input schema version 1

This is a new, explicit interchange schema. It does not guess the shape of an
unrelated daemon `status.json` or import arbitrary queue logs. Producers must
export the following snapshots. Each UTF-8 JSONL record describes one job:

```json
{"schemaVersion":1,"id":"RQ-example","lane":"codex-cmp","tier":"frontier","outcome":"running","tokens":120,"startedAt":"2026-10-25T10:00:00.000Z"}
```

| Field | Contract |
| --- | --- |
| `schemaVersion` | Required, exactly `1` on every job row. |
| `id`, `lane`, `tier` | Required, 1 to 128 ASCII letters, digits, dots, underscores or hyphens; first character must be a letter or digit. Lane is the queue pool identifier. Tier labels are preserved, not mapped to engines. |
| `outcome` | Optional: `queued`, `running`, `merged`, `empty`, `failed` or `cancelled`. Absent, queued and running jobs are incomplete. |
| `tokens` | Optional nonnegative safe integer: cumulative total tokens consumed by this job, across attempts. An absent measurement is unknown. |
| `startedAt`, `mergedAt` | Optional canonical UTC ISO timestamps, including milliseconds and `Z`. Time to merge is measured from job start. |
| `pr` | Required for merged jobs: `owner/repository#number`, positive number without leading zeros. Case-insensitive identity. No URL is fetched. |
| `reverted` | Optional boolean, a recorded observation. Absence means revert status is unknown. |
| `impact` | Optional finite nonnegative number, at most `Number.MAX_SAFE_INTEGER`. A producer-supplied score in a common unit across lanes and tiers. No impact score is invented from lines changed. |

`mergedAt`, `reverted` and `impact` require a merged outcome in the combined
snapshot. Each job ID occurs once in the JSONL snapshot. Each merged PR occurs
once across all jobs, preventing double reward. Blank lines are ignored.
Unknown fields are ignored and never copied to the output. Missing fields must
be omitted, not set to `null`. Empty jobs need an explicit `empty` outcome;
missing PR evidence is not proof that a job was empty.

The status file is an explicit overlay on those exact JSONL bytes:

```json
{
  "schemaVersion": 1,
  "jobsSha256": "<lowercase SHA-256 of the exact jobs.jsonl bytes>",
  "jobs": [
    {
      "id": "RQ-example",
      "outcome": "merged",
      "tokens": 800,
      "pr": "ashlrai/example#1",
      "mergedAt": "2026-10-25T12:00:00.000Z",
      "reverted": false,
      "impact": 4
    }
  ]
}
```

Status entries replace supplied measurement fields, never add token totals to
the job's previous total. Omitted fields retain their job value. An empty
`jobs` array is valid. Status IDs must be distinct and already present in the
JSONL file. Lane, tier, PR identity, a terminal outcome, and a recorded revert
cannot be contradicted by an overlay. Hash mismatch refuses a mixed snapshot;
publish a new matching pair after changing the JSONL bytes. These hashes bind
content, not producer identity or authenticity.

Both files are bounded to 16 MiB and 100,000 job entries. Readers require
owner-controlled regular files and directories using the existing stable-file
reader. Symlink inputs, unsafe permissions, files changing during a read,
missing files, malformed/truncated JSON, invalid dates, numeric overflow and
contradictory merge evidence refuse the entire report. Replacement characters
(literal U+FFFD as well as invalid UTF-8 decoded to U+FFFD) are refused so the
digests identify the exact accepted bytes. URI and network-share syntax are
rejected. Filesystem paths on OS-mounted volumes follow the OS mount policy;
the command does not resolve or access network services itself.

## Rollup definitions

Output includes `overall`, sorted `lanes`, sorted `tiers`, and sorted
`laneTiers` groups. Sorting is ASCII deterministic. Source SHA-256 values are
included; no current timestamp, path, job ID or PR is copied into output.
Identical input bytes produce identical output bytes. Reordering records
changes source digests but not the rollup values.

Completed jobs are merged, empty, failed or cancelled. Incomplete jobs remain
visible in `jobs` and `incompleteJobs`, but their partial tokens and outcomes
are excluded from every completed-job metric.

| Metric | Definition |
| --- | --- |
| `mergeRate` | Merged PR count / completed jobs. |
| `emptyJobRate` | Explicitly empty jobs / completed jobs. |
| `tokensPerMergedPR` | All completed-job tokens / merged PRs, including failed, cancelled, empty and reverted work. |
| `timeToMergeMs` | Mean of merged time minus job start, in milliseconds. |
| `revertRate` | Reverted PRs / merged PRs. Reverted merges still count as merges. |
| `mergedImpactPerToken` | Retained merged impact / all completed-job tokens. Reverted PRs contribute zero retained impact. |

An empty denominator returns `null`. Zero known tokens returns `null` for
impact per token, never infinity. If any completed job lacks tokens, both
cost-based metrics are `null`. If any merged PR lacks either timestamp,
`timeToMergeMs` is `null`. If any merged PR lacks revert status, `revertRate`
and retained-impact efficiency are `null`. Every non-reverted merge needs an
impact score for efficiency to be known. A reverted merge's retained impact
is known zero even without a score. With positive known cost and no merges,
efficiency is known zero.

Counts expose coverage: `tokenSamples`, `timeToMergeSamples`, `revertSamples`
and `impactSamples`. `knownTokens` is only the known subtotal and must not be
treated as a complete cost when `tokenSamples < completedJobs`. Rates are
fractions, not percentages. No pseudo-counts, confidence interval or
statistical significance claim is added.

## Router integration boundary

`priors` exposes the objective `mergedImpactPerToken` with completed, merged
and empty counts per lane and tier. `laneTiers` provides joint evidence when
lane and tier observations are correlated. Consumers can use these counts for
bandit priors and known efficiency as an LP objective coefficient, after their
own evidence admission and exploration policy. Null evidence is an unknown
arm, not a zero-reward arm. Compare scores only when impact units match.

This checkout has no queue bandit/LP consumer. The predecessor
RQ-PACE-GROK-BURN at local commit `60975653` also exports advisory pacing only;
its protected routers do not consume pacing yet. Existing operational routers
are Tier-1 protected and existing learned routing requires authenticated
learning authority. Accordingly this feed declares `basis: local-observations`
and `operationalSteering: false`. It does not alter live lane or tier choice.

The remaining authorized router integration must apply existing eligibility,
budget and Grok pacing constraints before optimizing efficiency. In
particular, a high observed Grok score cannot lift a throttle or enlarge the
predecessor's `boxAgentTurnMultiplier` of `0.5` when throttled. Do not use these
local file hashes as learning authority, disable an admission gate, or treat
this command as evidence that the live router is connected.

## Verification

The fixtures in `test/fixtures/router-metrics/` include a status-completed job,
empty and failed jobs, incomplete jobs, a reverted merge and unknown costs.
`test/metrics-ingest.test.ts` checks exact arithmetic, coverage, ordering,
malformed evidence, duplicate credit, path refusal, UTF-8, read-only behavior
and CLI exits. Run tests with a temporary HOME as required by the repository.
