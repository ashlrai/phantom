# Worker evidence audit

From a Phantom source checkout matching the installed version, run on the host
where the workers run:

```sh
npx tsx examples/upgrade/worker-evidence-audit.ts
```

Use `npx tsx examples/upgrade/worker-evidence-audit.ts --help` for usage.
This requires an existing local `tsx` installation; it does not install Phantom.
The command reads one process snapshot, then the existing fleet job detail for
up to 100 distinct live job IDs, with at most two detail reads in flight. The
`omittedJobs` count signals that the snapshot exceeded the limit. It changes no
worker state and performs no retries or kills.

The `worker-evidence-audit.v1` JSON report includes the live observation time,
per-job detail observation time, PID, lane, tier, detail model, detail state,
source health, and comparisons. A live wrapper implies `running`; the detail
state is independently inferred from files. Lane and tier are compared between
readers. The process reader has no model, so model comparison is always
`unknown`; a model shown is detail evidence, not independently corroborated.
The detail reader prefers the launch lane over the metadata lane, so this audit
cannot detect disagreement between those two detail sources.
Missing or unsafe model values are unknown. Source fields marked `missing` or
`degraded` are evidence gaps, not proof that a worker is absent. The job
reader may read its normal bounded log and metadata sources, but the audit never
outputs log contents, prompts, paths, or thrown error details.

These observations are sequential, not atomic. A worker can finish or its
files can change between reads; a disagreement is a reason to investigate,
not proof of a desktop defect. A healthy empty snapshot cannot verify a worker.
`base` and `publish` may normally be missing for a running worker. Healthy
launch, meta, and log sources, a present safe model, matching lane and tier,
and a running detail state are required for a verified row. Any degraded
source makes the evidence insufficient. Unsafe or unrepresentable fields are
reported as unknown. Reader failures retain other rows with a static error.

Exit codes (failure/mismatch takes precedence over insufficient evidence):

- `0`: all observed jobs meet the verification criteria.
- `1`: a mismatch or reader failure occurred.
- `2`: invalid arguments.
- `3`: insufficient evidence, including no workers or omitted jobs.

The audit observes launch wrappers recognized by the public process reader; it
cannot discover workers that reader does not recognize or independently prove
what model a process is using. Output may contain job IDs and process IDs.
