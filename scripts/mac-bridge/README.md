# Per-job memory accounting

Run a source checkout job with:

```sh
npx tsx scripts/mac-bridge/account-job.ts ~/.ashlr/jobs.jsonl JOB_ID POOL -- command args
```

Use the proposal ID as `JOB_ID` to correlate authenticated realized merge impact
in the fleet scorecard. Use the same ID for only one execution; duplicate records
make the scorecard memory section unknown rather than double counting impact.
Set the output path to `$ASHLR_HOME/jobs.jsonl` when using a custom Phantom home.
The wrapper preserves the child's exit status and writes a version 1 record on
close. It does not capture commands, environments, or tokens. SIGKILL cannot
write a completion record.

RSS is sampled once per second for the root PID and its current descendants.
Peaks are observed peaks, so brief spikes between samples can be missed. Shared
pages can appear in more than one process's RSS. Averages are time weighted over
consecutive successful sample intervals, using the preceding value. Gaps and
time outside those intervals are not extrapolated. `observedMs` makes that
coverage visible; zero coverage has a null average. GB-hours use decimal GB
(1,000,000,000 bytes). The scorecard ratio describes the recorded cohort and
observed intervals, not a claim of exhaustive machine cost or all fleet work.

Linux swap is the sum of descendant `VmSwap` values. macOS lacks that field in
`ps`, so swap is null there. Neither host swap nor virtual address space is
attributed to a job. Detached or reparented processes are outside this sampler's
current tree. This is operational telemetry, not a billing meter.

`memory_admission.py` exposes `required_memory_bytes(path, pool, fallback)` for
the #1014 admission controller. It reads matching pool history when present and
returns at least the existing fallback, using the maximum observed RSS plus
swap peaks. Missing, legacy, and malformed rows do not lower that fallback.
Keep the controller's existing host pressure and safety checks. The #1014
controller itself is not present in this checkout, so this helper does not
replace or activate an admission policy.

The fleet scorecard exposes `memory.impactPerGbHour`: authenticated realized
merges whose proposal IDs match recorded job IDs, divided by sampled RSS
GB-hours across all recorded jobs in the completion window. Failed jobs still
contribute to the denominator. Missing history, malformed records, duplicate
job IDs and jobs with zero measured duration produce unknown values. This
telemetry cannot establish merge credit.

Verification:

```sh
HOME=$(mktemp -d) npx vitest run test/job-memory-accounting.test.ts test/m356.scorecard.test.ts
HOME=$(mktemp -d) python3 -B -m unittest discover -s scripts/mac-bridge -p 'test_*.py'
```
