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
errors; failures return exit code 1, and an unrecognized verb is a usage error
that returns exit code 2. `list` and JSON export do not create files.

`phm queue report --events <file>` is a separate queueing-metrics tool sharing
this command; it reads station-visit events and prints lambda, mu, rho and W.
It does not read or write the queue.v1 snapshot.

## Contract and interoperability

The canonical TypeScript contract and runtime validator are in
[`schema.ts`](../src/core/queue/schema.ts). A document contains `schema: "queue.v1"`
and a `jobs` array. Each job has a unique `id`, status
`READY|CLAIMED|PR-OPEN|BLOCKED|HOLD|DONE|PROPOSED`, `priority`, `pool`, `tier`,
`repo`, `deps`, `scope`, `acceptance`, and `claims`. Claims record `owner`,
`claimedAt`, and optional `finishedAt`. Jobs optionally carry `prUrl` and
`blockedReason`. Timestamps are ISO dates, PR URLs are credential-free HTTPS,
and self-dependencies and duplicate dependency IDs are refused. Cyclic dependencies
cannot be claimed because all dependencies must be DONE.

The store API is a clean seam for a future scheduler: `read`, `add`, `import`,
`claim`, `finish`, and `mirror`. No executor is imported. Status changes happen
inside the same transaction that checks readiness and dependencies.

Markdown import accepts one job per line:

```text
- READY RQ-EXAMPLE (P0 FLAGSHIP, pool=codex-personal, tier=frontier, repo=phantom, deps=RQ-A|RQ-B, EO 13:45): Scope text. Acceptance: criteria.
```

Bullets are optional; status may use brackets or Markdown bold and IDs may be
bold. Fields accept comma or semicolon separators. Dependencies use `|`, `+`, or
spaces within the field (CLI `--deps` uses commas). Unknown fields, headings,
comments, whitespace, line endings, and the original text are retained in
`source`. Absent routing fields become `unspecified`, priority defaults to P2,
and absent acceptance becomes an empty string. Such jobs need operator review
before scheduler cutover. Imported CLAIMED jobs retain their status but have no
invented owner or timestamps, so they cannot be finished through this CLI.
Malformed status-prefixed lines and duplicate IDs reject the entire import.
JSON import validates the same schema. Import requires an empty queue; it never
replaces live state. Use a separate directory to inspect a later snapshot.

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

Locks are never stolen on age or PID heuristics. If a writer crashes, an operator
must confirm that no writer is running before removing its orphaned
`queue.v1.lock`. A busy lock leaves the snapshot unchanged. A crash before rename
can leave an unused temporary file; it is never read as queue state. Atomicity
assumes a local filesystem with exclusive creation and atomic rename. Directory
entries are not fsynced, so sudden power loss is outside the durability guarantee.

The host dispatchd README was not accessible in the implementation workspace.
The import fixture covers the supplied router line contract; verifying it against
the live router snapshot is a required cutover step, not a claimed validation.
