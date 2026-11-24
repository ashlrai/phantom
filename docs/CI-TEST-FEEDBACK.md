# CI test feedback and failure-first ordering

The stateless processor in `.github/scripts/ci-test-feedback.mjs` replays module-result
metadata and produces a complete ordering of the caller's collected tests. It retains
the original objects and project slots. It does not select tests or reuse results.

Each event binds a source revision, run, attempt, job, role, original log digest and
module occurrence. A filtered second execution is another occurrence. Identical
redeliveries deduplicate; conflicting observations refuse the whole replay. Missing,
skipped and unknown results stay distinct from passes. A final incomplete JSONL record
is corruption. `encodeFeedback` and `decodeFeedback` define the replay format; they do
not themselves provide durable storage or authenticate a GitHub log.

An external collector must retain the original logs and verify their digests before
projecting events. Keep raw errors, titles, fixture values and private content out of
the metadata. Append events to the collector's existing durable storage, then rebuild
snapshots statelessly. Do not introduce an independent source of release authority.

The existing Vitest sequencer accepts an optional JSON snapshot:

```json
{"schema":"phantom-ci-test-feedback-snapshot/v1","events":[]}
```

Set `ASHLR_TEST_CI_FAILURE_FIRST=1`, `ASHLR_TEST_CI_FEEDBACK_SNAPSHOT` to its canonical
file path, and `ASHLR_TEST_CI_FEEDBACK_ROLE` to the exact historical job role. No new
dependency or service is required. The existing bounded descriptor reader validates
the snapshot file. Missing or invalid metadata preserves the normal sequencer order.
The default remains unchanged until a caller enables the option. Shard membership,
project groups, worker caps, deadlines and the isolated runner's final ledger task
remain owned by their existing code.

Vitest already orders locally cached failures first. Those locally known result
slots retain their default positions; historical feedback only orders slots without
local results, which are common on fresh hosted runners.

Within each project's existing slots, historically failed modules run first, ordered
by their measured median elapsed time where known; unobserved or skipped-only modules
follow, then observed passing modules. Equal priorities preserve caller order. A
historical failure can already have been repaired. A matching path is not proof of
unchanged dependencies, runtime, hardware or current performance. History affects
only priority and never supplies a current pass, quarantine or acceptance decision.

Measure actual time to first actionable failure, full-run wall time, complete module
coverage, rerun rate and revert/incident rate before widening usage. Do not sum
overlapping module spans and call that CPU time. A replayed ordering is a scenario,
not a measured CI speedup. Keep a full default-order comparison and retain failures.

This applies the listener/selector separation described in [Anthropic's test-impact
analysis report](https://claude.com/resources/articles/agentic-coding-is-straining-ci-heres-how-we-scaled-test-impact-analysis-at-anthropic).
Its distributed storage architecture is not required for this local metadata step.
Future test omission needs independently established dependency coverage; this
component changes no omission or release policy.

## Duration-weighted partition hints

The same sequencer can balance Mac partitions by historical duration. Like
failure-first ordering, it is a maintainer option; contributors never need it.

Duration-weighted Mac partition calibration is disabled by default. An explicit
`ASHLR_TEST_CI_WEIGHTED_PARTITION=1` plus `ASHLR_TEST_CI_WEIGHTED_HINTS` pointing
to a local `phantom-partition-hints/v1` JSON file enables the sequencer for
general shards in a clean checkout at its committed source revision. The original
sharder handles absent, invalid or incompatible
hints; isolated acceptance always ignores these settings. No timing file is
downloaded or supplied by default. Hints must retain their original successful
run, source, runtime/config digest and observation time. Reporter spans are
historical costs, not CPU measurements or promised wall time. New files remain
included; hints cannot replace complete fresh tests or release qualification.
To convert an independently accepted original capture into advisory hints, run:

```sh
node .github/scripts/ci-report-weight-hints.mjs CONVERSION-REQUEST.json > timing-hints.json
```

The request uses schema `phantom-original-report-conversion/v1`: absolute
`root` and `bundle` paths, exact `source` (`revision`, `tree`), original `run`
(`id`, `attempt`), `manifestSha256`, `qualificationSha256`, and
`githubSnapshot` (`path`, `sha256`). The pinned snapshot uses
`phantom-recorded-github-api/v1`, with a canonical `observedAt` timestamp and
an endpoint-keyed `responses` object containing the previously accepted
original run, all required jobs, commits and six artifact records. It makes no
network requests and executes no code from the capture. Saved JSON is not
authenticated by this command and grants no release admission; obtain and
accept the original evidence through the existing qualification workflow.

Conversion requires the complete successful original run/attempt and raw
case inventory, and hashes calibration inputs from that exact clean source.
Older captures lacking those inputs refuse instead of acquiring the current
configuration digest. Output retains historical reporter spans, module hashes,
original observation time and report provenance. Unknown runner image and
hardware remain unknown. Source/transitive changes are not proof of fresh
timings; review compatibility diagnostics before any explicit local experiment.
No hint file is checked in, downloaded, or activated by this conversion.
