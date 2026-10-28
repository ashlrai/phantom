# RQ-QUEUE: CI runner queue observations

## RQ-BRIDGE-CI status — 2026-10-26

Live verification is **RECHECK_REQUIRED**. Locus MCP `locus_verify_session`,
`locus_list_bindings`, and `locus_safe_next`, and CLI `locus verify session --json`
all returned `Operation not permitted (os error 1)` in this session. No direct
GitHub credential fallback was used. No reruns were submitted.

| Repository | PRs | Surviving runs green | Only-cancelled reruns | Vercel not required |
|---|---|---|---|---|
| ashlrai/phantom | #940–#949 | RECHECK_REQUIRED | RECHECK_REQUIRED | RECHECK_REQUIRED |
| ashlrai/lexicon | #224–#226 | RECHECK_REQUIRED | RECHECK_REQUIRED | RECHECK_REQUIRED |
| ashlrai/ashlr-md | #194–#195 | RECHECK_REQUIRED | RECHECK_REQUIRED | RECHECK_REQUIRED |

| Runner label | Started-job delay | Queued-job age | Execution duration |
|---|---|---|---|
| macos-15 | unknown — no live capture | unknown | unknown |
| Other labels | unknown — no live capture | unknown | unknown |

The supplied Masbot diagnosis (draft-then-ready created two runs and concurrency
cancelled one) is task context, not independently verified evidence. A cancelled
run with no steps is not a failed test or a zero-second queue sample.

## Generate the measurements

The offline [reporter](scripts/ci-queue-report.mjs) accepts complete GitHub Actions
job pages captured through an authorized Locus session. It neither accesses
credentials nor invokes GitHub, changes workflows, or reruns jobs.

Save one JSON envelope per repository/run/attempt. Each `pages` entry is an
unmodified jobs-list response containing `total_count` and `jobs`. Collect every
page for that **specific attempt**, not a mixture of latest/all attempts. Record
`observedAt` at collection time; do not substitute report-generation time for a
historical capture. Use UTC timestamps with seconds or three millisecond digits.

```json
{
  "repository": "ashlrai/phantom",
  "runId": 123,
  "runAttempt": 1,
  "observedAt": "2026-10-26T03:20:00Z",
  "pages": [{ "total_count": 0, "jobs": [] }]
}
```

The zero-job example describes the format only; it is not a live receipt.
Real job rows retain `id`, `run_id`, `run_attempt`, `labels`, `runner_id`,
`status`, `conclusion`, `created_at`, `started_at`, `completed_at`, and `steps`.
Execution evidence requires an assigned runner and a started, non-skipped step
within the job's start/completion/observation interval. Missing evidence stays
unknown. Explicit empty-step cancellations and skipped jobs have separate counts.

```sh
node scripts/ci-queue-report.mjs capture-phantom.json capture-lexicon.json
node scripts/ci-queue-report.mjs --json capture-phantom.json
```

The command writes its report to stdout. Retain this status record and append
the resulting observation table to the canonical RQ-QUEUE when its location is
known. Do not overwrite this file with shell redirection before validation.

- Per-label delay p50/p95/max measures `started_at - created_at` for jobs with
  execution evidence. Percentiles use nearest rank, in milliseconds in JSON and
  seconds in Markdown. Completed execution duration is reported separately.
- Queued, waiting, pending, and requested jobs contribute age at `observedAt`
  separately. These are censored observations, not completed delays.
- Scheduling delay can include dependency, concurrency, and approval waits;
  these data alone do not isolate runner-capacity contention.
- Jobs with multiple labels appear in each label row. `totalJobs` counts unique
  captured jobs; summing label rows overcounts. Missing labels have an explicit
  unknown row. Distinct attempts are retained, never silently replaced.
- Missing pages, inconsistent counts, duplicate IDs/captures, and mixed attempts
  fail the entire command (exit 1, no partial report). Invalid CLI usage exits 2.
  Empty complete captures yield no labels, not invented zero-delay measurements.
- Capture identity and timing do not prove the latest attempt, the current PR
  head, green checks, or the workflow's critical path.

## Finish live acceptance after Locus recovery

1. Restore the existing authorized Locus session through its operator recovery
   path; verify session health. Agents must not create pins or bypass identity
   controls. Use Phantom Secrets `phantom exec --` for any required credentials;
   do not read or print raw secrets.
2. For all 15 PRs above, record current head SHA, base branch, draft/state, and
   workflow run ID, attempt, event, head SHA, status, conclusion, and URL.
   Paginate fully. Check pull-request merge-SHA association where applicable;
   runs on an old head do not qualify a newer head. Group replacement runs by
   PR, workflow, and source revision, not just workflow name.
3. Let a surviving queued/in-progress run finish. Rerun only a current-revision
   workflow whose relevant attempts were all cancelled and which has no active
   or successful replacement. Refresh immediately before rerunning to avoid
   racing a newly scheduled replacement. Do not automatically rerun genuine
   failures or superseded revisions. Record submitted attempt IDs and wait for
   terminal results; submitting a rerun is not green acceptance.
4. For each PR base, inspect both legacy required status checks and effective
   active repository/organization rulesets, including required deployments or
   workflows. A check named `Vercel` or the message `Authorization required to
   deploy` does not itself establish whether it blocks merging. Record the
   enforced contexts and rule evidence for all three repositories. Missing
   permission or incomplete rule evidence stays RECHECK_REQUIRED.
5. Capture complete run-attempt job pages and generate the per-label report.
   Compare delay and execution duration across the same cohorts; inspect job
   dependency order to establish whether macos-15 is actually the long pole.

## Security workflow handoff

At local source `0410aee2`, the `mac-general` condition in
[ci.yml](.github/workflows/ci.yml) already excludes ordinary PR, merge-group,
and push events unless the full-Mac label condition applies. Its nearby comment
claims master-push coverage, but the condition does not establish that claim.
The `mac-isolated`, `ci-shared-macos`, and native macOS broker jobs still provide
platform-specific PR coverage. Local source is not evidence of current hosted
workflow configuration.

No macOS bottleneck is established without live captures. If those captures
justify relocation, Security must prepare/review the G1 workflow change while
preserving platform-specific security coverage and required merge checks.
This task explicitly forbids `.github/**` and Tier-1 edits, so no workflow or
protection change is included here. Do not treat the offline report as approval
to remove a security gate.
