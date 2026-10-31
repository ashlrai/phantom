# Local model tuning data and evaluation

`phm tune` currently provides offline preparation and an evaluation decision.
Training, frontier review execution, lane promotion/rollback, weekly routines,
and the ideation service are **not implemented** by this command. No real
adapter has been trained or promoted as part of this change.

## Prepare

```sh
npm run dev -- tune prepare reviewed-samples.jsonl new-dataset /path/to/scrub.pl
```

The operator supplies a trusted, local `scrub.pl` accepting UTF-8 on stdin and
`--check`, with exit zero only for clean content. Output and diagnostics are
suppressed. A hit, timeout, or execution failure drops the sample. The existing
Phantom private-text scrubber also rejects hits, without redacting and retaining
them. Scanner code must come from the operator, never a model-generated sample.

Each JSONL record follows `TuneSample` in `src/core/tune/dataset.ts`: `jobId`,
`task`, `mergedDiff`, a forty-character `mergeSha`, ISO `mergedAt`, optional
`rejectedLocalDiff`, and `review` containing `model` (`codex` or `claude`),
`verdict: "approve"`, `critique`, and `contentHash`. Use exported `sampleHash`
to bind the review to exactly those input fields. Importers must independently
verify that the diff is merged and the review came from a frontier reviewer;
the JSON review fields are assertions, not authenticated receipts. This command
accepts curated exports, not raw router transition events or GitHub URLs.

Preparation requires five clean unique task groups. The newest twenty percent
are test data, the preceding twenty percent validation data, and the remainder
training data. Duplicate IDs and identical trimmed task specs are excluded.
Preference pairs come only from training groups. Output is an exclusively
created directory (0700), with JSONL files and a count/hash manifest (0600).
A failed write may leave a partial directory: use a new directory on retry.
No source text is printed. Inputs are limited to 8 MiB and 10,000 records.
Review content hashes are metadata, not training text, and are omitted from
scrub input; every text field that enters the dataset is checked.

MLX chat-message training format follows the
[upstream LoRA guide](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md).
Preference output is a curation artifact, not an SFT training file.

## Assess paired evidence

```sh
npm run dev -- tune evaluate paired-report.json
```

The input contains `baseline`, `candidate`, and `heldoutIds`. Both observation
arrays must cover the same five or more unique held-out task hashes. Each row
has `taskId`, boolean `passed` and `mergeGatePassed`, positive `latencyMs`, and
positive `tokensPerSecond`. Use at least 25 accepted samples to obtain five
test groups from preparation. Evaluation exits 0 for `eligible-for-review`,
1 for rejection or invalid evidence, and 2 for usage errors. Eligibility requires
strictly higher pass rate and no worse merge-gate rate, mean latency or mean
throughput. It does not authenticate measurements, prove independence from
training, or authorize deployment. Keep the measurement report alongside the
adapter digest and independently verified held-out manifest before review.

## Live acceptance still required

A complete tuning loop needs verified fleet/PR ingestion, authenticated frontier
curation, detached MLX training with a memory admission/yield protocol, measured
held-out runs, oMLX adapter loading, durable promotion ledger and rollback,
a weekly routine, and a loopback text-only ideation resource. Live lane changes
must use the existing owner-reviewed router and registry interfaces. Mock or
synthetic measurements cannot satisfy the real fleet training acceptance.
