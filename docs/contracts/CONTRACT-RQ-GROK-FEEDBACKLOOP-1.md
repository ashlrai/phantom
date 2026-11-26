# Feedback-to-fix pipeline

```sh
phm fleet feedback scan --json
phm fleet feedback scan --apply --json
phm fleet feedback digest --json
```

`scan` collects recent open issues, PR discussion/review comments, failed CI runs,
exact merge-SHA revert evidence on `master`, and existing local comms receipts.
The window defaults to seven days (`--days 1..30`). Dependency-injected collectors
use read-only gh metadata commands and the canonical local bus, including inbound
owner-thread mirrors. Outbound replies and iMessage bodies/handles are excluded.
Telegram, Slack, desktop and CLI interjections remain untrusted regardless of sender
labels. Existing authenticated adapters own network intake; there are no sends,
acknowledgements, credential resolution, model calls or scheduler installation.

Seven gh processes are spaced by 250 ms, each capped at eight seconds and 1 MiB; collector deadlines are nine seconds with cancellation. Pages cap at 100 records
(1,000 open PRs); saturated pages retain observed records and report `truncated`.
Comms reads at most eleven 100-record pages, returning the latest 100 eligible signals.
Reverts require a full matching merge SHA and a commit time after that merge within
the window; ambiguous, abbreviated or manual reverts are not inferred.

Pure triage classifies bug, regression, feature, flake or question. Oversized,
unrecognized, secret-shaped and protected-scope signals return fixed ignore reasons.
Secret references may be names only. Unicode normalization, decoded paths and the
shared protected-path matcher precede prompt creation. Evidence is JSON data in an
uncommitted review task. Existing dispatcher and diff-level Security checks still
apply: this heuristic is not an execution sandbox. Nothing auto-merges or publishes.

Dedupe uses normalized titles, canonical refs and deterministic `RQ-PHX-FB<hash>` IDs
against open PRs, both queue projections, the batch, and pending/done/launched drops.
An open PR covers its comments. Missing/truncated PR or unreadable queue coverage
withholds injection. Apply alone creates state: a shared lock, one-minute cycle
reservation (including crashed cycles), at most five staged jobs, and existing queue
backpressure. Regressions take priority; questions and excess jobs are deferred.
The existing atomic no-clobber drop writer feeds the normal READY sweep; staging
is not proof of launch. Each successful apply also appends one
`{at,job,source,ref,kind}` row to `feedback/feedback-queued.jsonl` under the runs
root — the scan's own record of which submission became which `RQ-PHX-FB` job,
so a reporter can trace request → job → PR without asking where it went. The
row carries provenance only; submission text stays inside the untrusted job
prompt. A failed journal append reports `queue-record-failed` and never unqueues
the job. Invoke scan from an existing overnight routine for automation.

`digest` covers twelve hours. `shipped` means merged PRs, not deployments; latest
job events distinguish review, failures and last recorded launches (not live probes).
`submissions` folds every journaled `RQ-PHX-FB` job (plus ledger-only FB rows whose
journal predates this record) into one state: `queued` admitted with no verdict,
`under-review` a PR is recorded or open, `action-required` a declined, failed,
give-up or finished-without-PR run, `merged` a ledger MERGED claim, `shipped` a
MERGED claim whose PR ref is inside the ingest's gh-verified merged set. A missing
or unreadable queue journal degrades provenance to null; only an unreadable one
reports `sources["feedback-queued"]` unavailable. An unreadable jobs ledger nulls
`submissions` with the other lists. Missing sources are explicit; unavailable
history yields null lists, malformed rows are counted, and truncated sources
remain partial. The runs root is `--runs-dir`, `ASHLR_RUNS_DIR`, or
`~/.ashlr-runs`; local reads cap at 4 MiB (the queue journal at 1 MiB). Errors
never echo raw input. Both commands emit `fleet.feedback.v1` JSON (pretty
without `--json`): exit 0 complete, 1 degraded/failure, 2 invalid arguments.
Dry-run and digest never write.
