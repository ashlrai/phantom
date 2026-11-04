# Phantom job queue

`phm queue` owns a dispatch-neutral `queue.v1` snapshot at
`~/.ashlr-runs/queue/queue.v1.json`. `--dir <directory>` selects an isolated store.
This command does not start workers, change dispatchd, push code, access vendor
authentication, call inference, or fetch credentials. dispatchd remains the
fallback until a separate, explicit cutover. Do not dispatch the same imported
jobs from both schedulers. Publication remains exclusively through publish.sh.

## Commands

```sh
phm queue import router-queue.md --json
phm queue list --json
phm queue add RQ-EXAMPLE --priority P0 --pool codex-personal --tier frontier \
  --repo phantom --scope 'Implement the feature' --acceptance 'Tests pass' \
  --deps RQ-PREREQUISITE --json
phm queue claim RQ-EXAMPLE --owner worker-1 --json
phm queue done RQ-EXAMPLE --owner worker-1 --pr-url https://github.com/ashlrai/phantom/pull/123 --json
phm queue done RQ-EXAMPLE --owner worker-1 --json
phm queue block RQ-OTHER --owner worker-2 --reason 'Waiting for prerequisite' --json
phm queue export --json > queue-backup.json
phm queue export --md --json
```

`claim` requires READY and all dependencies present and DONE. Missing dependencies
fail closed. `done --pr-url` records PR-OPEN without releasing the claim; `done`
without a PR URL records DONE. These are operator-reported states, not evidence
of GitHub merge checks. `block` records BLOCKED and closes the active claim.
Completion and blocking require the last active claim's owner. This is local
coordination, not an authentication boundary. There is no automatic reclaim,
retry, promotion of HOLD/PROPOSED, dispatch, or merge.

`--help` is side-effect free. Unknown commands, flags, irrelevant options and
missing operands fail before mutation. All commands support `--json`, including
errors; failures return exit code 1. `list` and JSON export do not create files.

## Contract and interoperability

The canonical TypeScript contract and runtime validator are in
[`schema.ts`](../src/core/queue/schema.ts). A document contains `schema: "queue.v1"`
and a `jobs` array. Each job has a unique `id`, status
`READY|CLAIMED|PR-OPEN|BLOCKED|HOLD|PROPOSED|SPLIT-PARENT|FIXUP|LAND|DONE|RETIRED|DROPPED`,
`priority`, `pool`, `tier`, `repo`, `deps`, `scope`, `acceptance`, and `claims`.
Claims record `owner`, `claimedAt`, and optional `finishedAt`. Jobs optionally
carry `prUrl` and `blockedReason`. Timestamps are ISO dates, PR URLs are
credential-free HTTPS, and self-dependencies and duplicate dependency IDs are
refused. Cyclic dependencies cannot be claimed because all dependencies must be
DONE. A document may also carry `raw` (unparsed job-shaped lines kept verbatim
with a reason) and `warnings` (non-fatal import observations).

The store API is a clean seam for a future scheduler: `read`, `add`, `import`,
`claim`, `finish`, and `mirror`. No executor is imported. Status changes happen
inside the same transaction that checks readiness and dependencies.

Markdown import accepts one job per line in either direction of the live
router format: fields may sit before or after the id, and operational tokens
(timestamps, worker names, pool names) may precede the id:

```text
- READY RQ-EXAMPLE (P0 FLAGSHIP, pool=codex-personal, tier=frontier, repo=phantom, deps=RQ-A|RQ-B, EO 13:45): Scope text. Acceptance: criteria.
- CLAIMED 14:26 dispatchd codex-personal RQ-EXAMPLE (P0, pool=codex-personal, tier=frontier, repo=phantom): Scope text.
- PR-OPEN (https://github.com/ashlrai/phantom/pull/123, bridge 12:23, EO 12:40) RQ-EXAMPLE: Scope text.
```

Bullets are optional; status may use brackets or Markdown bold and IDs may be
bold. Job IDs use the `RQ-` prefix; the job id is the last `RQ-*` token in the
header (everything before the first `:` that follows the first `RQ-*` token),
excluding tokens claimed by a dependency or `children`/`parent` keyword. Field
groups are balanced parentheses, so inner `(...)` pairs do not truncate them.
Fields accept comma or semicolon separators. Routing fields (`priority`, `pool`,
`tier`, `repo`, `deps`) come only from parenthesized groups; `pool` may also be
inferred from a known pool name in the pre-id tokens. Dependencies use `|`, `+`,
commas, or spaces within the field (CLI `--deps` uses commas), and are also
collected from prose (`deps=`, `depends on`, `after`, `waits for`, `blocked by`,
`needs`, `requires`) anywhere on the line. On the Mac restocker, unmet `after=`
deps become `PARKED-DEP.<lane>` rows whose prompts carry `DEPENDENCY GATE: <ids>`;
restock unparks them when every id has a `MERGED` outcome in `jobs.jsonl` (see
[Mac queue scripts](../contrib/mac/README.md)). `children=`/`parent=` tokens mark
related ids, never the job id or a dependency. `worker=`/`owner=` plus a
`claimed=`/`claimedAt=` ISO timestamp import as a real claim; `reason=`,
`blocked=`, `PR=` and `BASE_OVERRIDE=` text stays intact in `source`. Unknown
fields, headings, comments, whitespace, line endings, and the original text are
retained in `source`. Absent routing fields become `unspecified`, priority
defaults to P2, and absent acceptance becomes an empty string. Such jobs need
operator review before scheduler cutover. Imported CLAIMED and PR-OPEN jobs
without importable claim fields retain their status but have no invented owner
or timestamps, so they cannot be finished through this CLI; jobs that depend on
them cannot be claimed until they are resolved.

Job-shaped lines that cannot be parsed (an unknown status, no `RQ-` id, or a
duplicate id) never abort the import: each becomes a `raw` record with its
line number, verbatim text and reason, and a warning is collected on the
document and printed to stderr by `phm queue import`. Plain prose lines are
left as `source` text, not raw records. Self-dependencies are dropped with a
warning, and an unbalanced `(` is treated as literal text with a warning.
JSON import validates the same schema. Import requires an empty queue; it never
replaces live state. Use a separate directory to inspect a later snapshot.

### Tier values

A router-queue line's `tier=` must be one of `frontier`, `work`, `mid` or
`fast`. dispatchd skips any other value without an error, so the job never
runs. `queuegen` refuses to write a line with another tier, and
`router-lint` reports such an admission line as `invalid` with reason
`unknown-tier`. The refusal names the allowed values and, where one is near,
the closest match: `standard` means `work`, `medium` means `mid`, `low` means
`fast` and `high` means `frontier`. Nothing is accepted by alias; write the
tier name itself. The vocabulary lives in
[`queue-tier.ts`](../src/core/drive/queue-tier.ts). Keep it identical to
`TIERS` in `contrib/mac/dispatchd.py`.

`exportMarkdown` round-trips unchanged imports byte-for-byte. State changes
update the status while retaining original text and append a comment with claim,
PR and block metadata. JSON export is the complete backup and restore format.
`export --md` writes `queue.mirror.md` with a read-only notice and mode 0444 on
POSIX. It never overwrites `router-queue.md`; the mirror is not an input channel.

## Storage and failure behavior

Every mutation and mirror export acquires `queue.v1.lock` with exclusive file
creation, then reads and validates the snapshot under that lock. Concurrent
callers wait up to five seconds. Updates use a unique private temporary file,
fsync its contents, and atomically rename it over the snapshot. Readers observe
a whole old or new snapshot. Files use mode 0600 and newly created directories
use 0700. The existing dispatchd directory's permissions are not changed.
Corrupt snapshots fail closed instead of becoming empty queues.

## Load-aware admission

`phm pool admission [--json]` is a read-only report of the dispatchd load gate:
1-min loadavg and its limit, `ncpu`, process and live-worktree counts, the daemon
tick age, the global running cap, running jobs, the `queue/install.lock` holder and
`admit` true or false with the reason. It claims and launches nothing. The gate
logic itself lives in `contrib/mac/dispatchd.py`; see `contrib/mac/README.md`.

`ashlr fleet admission [--json]` reads that stored verdict from `queue/status.json`
and says why each lane is waiting: held, at target, blocked by the global cap, or ok.
It does not probe the host or launch work. It exits 1 when any lane is blocked by
the global cap with 5 or more jobs queued. Other waits are `ashlr fleet lane-idle`.

Locks are never stolen on age or PID heuristics. If a writer crashes, an operator
must confirm that no writer is running before removing its orphaned
`queue.v1.lock`. A busy lock leaves the snapshot unchanged. A crash before rename
can leave an unused temporary file; it is never read as queue state. Atomicity
assumes a local filesystem with exclusive creation and atomic rename. Directory
entries are not fsynced, so sudden power loss is outside the durability guarantee.

The host dispatchd README was not accessible in the implementation workspace.
`test/fixtures/queue/router-queue-live.md` is a scrubbed snapshot covering every
status prefix and line shape observed in the live queue; the suite imports it
with zero unparsed lines and round-trips it byte-for-byte. Verifying the real
snapshot end to end remains a required cutover step, not a claimed validation.

## Replay failed attempts

`ashlr queue replay --failed --since 2026-11-02T00:00:00Z --query repair --dry-run --json`
lists proposed READY runs without writing. Remove `--dry-run` to persist them.
Failed means BLOCKED with a finished claim; `--since` filters that completion
instant inclusively and `--query` matches job ID, repo, scope, acceptance or reason
(case insensitive). Omit either filter to include all failed attempts.
`--mode replay_failed` is the default. `--mode replay_failed_and_dependents`
includes transitive dependents in dependency order and maps their dependencies
to replay runs. Active original dependents must finish before replay. Claims still require
all dependencies DONE. Each new run records `replayOf` (the original run ID)
and `replayedAt`; original runs remain unchanged. Concurrent or repeated requests
reuse active READY, CLAIMED or PR-OPEN replays. Completed replays allow a later
explicit replay. Queue snapshots persist lineage across process restarts.

## Group failed jobs by error

`ashlr issues` (also `phm issues`) reads the queue and groups failed jobs (BLOCKED
with a finished claim) by their error text. Ids, timestamps and long numbers are
ignored, so one problem counts once. Each group shows a count and a few sample
job ids. It never writes unless you add `--retry`, which queues one READY retry per
failed job using the same lineage as `queue replay` (repeats do not duplicate).
Add `--json` for `{ v, failed, groups: [{ error, count, samples, jobs }] }`, or
`{ v, retried: [{ id, retry }] }` with `--retry`. Use `--dir` to pick a queue directory.
