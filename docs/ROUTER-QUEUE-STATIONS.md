# Observe router queue job stations

Use `phm telemetry queue` to record box-side queue progress and read GitHub
delivery evidence for one job attempt. It writes a private local journal and
prints new metadata-only events as JSON. It never changes the router queue,
claims work, publishes a PR, merges, releases, or repairs main.

From a source checkout, replace `phm` below with `npm run dev --`. The box's
router queue, claim ledger and `publish.sh` are external to this repository;
their owners must supply the normalized inputs and invoke these hooks. This
change does not install a scheduler or change those external scripts.

## Input contracts and box hooks

The queue adapter supplies a versioned JSON snapshot. `jobId`, `repo` and
`attempt` identify the same execution across every source. Use the claim's
stable generation ID for `attempt`; retries and rewritten PR heads need a new
attempt. Repository names normalize to lowercase. Identifiers allow letters,
digits, dot, underscore and hyphen, up to 128 characters.

```json
{
  "schemaVersion": 1,
  "queue": [
    { "jobId": "EXAMPLE-1", "repo": "example/project", "attempt": "claim-1", "status": "READY" }
  ],
  "claims": [
    { "jobId": "EXAMPLE-1", "repo": "example/project", "attempt": "claim-1", "claimedAt": "2026-10-26T12:00:00.000Z" }
  ],
  "publications": []
}
```

Run after each router-queue diff and claim-ledger append, including each READY
transition. Write the snapshot atomically before invoking the observer. Each
array is required; missing/unreadable sources must fail the adapter rather than
be substituted with an empty array. Queue statuses are `planned`, `READY`,
`claimed`, `published` and `done`. Claims are successful claim receipts, not
claim requests, heartbeats or releases. Inputs are JSON, not Markdown or raw
shell logs; the external adapter owns normalization of its actual file format.

```sh
phm telemetry queue observe --input /path/to/snapshot.json
```

Every observed queue row emits `planned` once per attempt. Only an explicitly
observed `READY` row emits READY; later statuses never invent missing earlier
stations. Claims and publications can also be included in the snapshot. Stable
event IDs make repeated snapshots and observer restarts idempotent. There is no
deletion event when a queue row disappears.

After the box's existing `publish.sh` has successfully published its PR, write a
receipt using the exact returned PR number and pushed head SHA:

```json
{
  "jobId": "EXAMPLE-1",
  "repo": "example/project",
  "attempt": "claim-1",
  "publishedAt": "2026-10-26T12:01:00.000Z",
  "pr": 42,
  "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Then invoke the local post-success hook. Preserve and retry that receipt on an
observer failure; never replay publication to retry telemetry. Do not run the
hook before a successful publication or from an unconditional shell EXIT trap.

```sh
phm telemetry queue publish --input /path/to/publication.json
```

These commands mutate only the selected local journal. Input reads refuse
symlinks, non-regular files, unsafe paths, changing files and files over 4 MiB.
Each snapshot array is bounded to 10,000 rows. Extra source fields are discarded;
do not include prompts, bodies, command output, credentials or secret values.
Source timestamps use UTC ISO strings with milliseconds as shown above.

## GitHub polling through Locus

An existing verified Locus job session, or a configured Locus CI binding that
can mint one, is required. The observer uses the existing
[Locus session integration](../src/core/integrations/locus.ts) and revalidates
dispatch before each `gh` child. It refuses ambient-account fallback. Follow
[the companion setup guide](AGENT-TOOLCHAIN.md) to establish identity; no tokens
or credentials belong in receipts or command arguments.

Have the box scheduler invoke one poll per published job on its normal cadence:

```sh
phm telemetry queue poll --input /path/to/publication.json
```

| Station | Required evidence |
| --- | --- |
| `planned` | Queue row first observed for this attempt |
| `READY` | Queue row explicitly has status `READY` |
| `claimed` | Successful claim-ledger receipt with claim time |
| `publish` | Post-success publication receipt, pinned to PR and head SHA |
| `pr-ci` | Nonempty recognized checks on the exact published PR head; records pending, success or failure |
| `merge-queue` | GitHub GraphQL `mergeQueueEntry.id` on that same head while the PR is open |
| `merged` | GitHub reports the pinned PR as MERGED and supplies its merge commit |
| `released` | Published, non-draft, non-prerelease release whose tag contains that merge commit, verified with GitHub compare |
| `fix-main` | A failed, timed-out or startup-failed completed push workflow on that exact merge commit and the repository's verified default branch |

`fix-main` records observed repair demand; it does not mean a repair has run or
succeeded. `merge-queue` and `fix-main` are conditional: a PR merged outside a
queue or a healthy default-branch build will leave those stations missing.
Never fabricate them to make a coverage report green. Auto-merge intent alone
does not establish merge-queue entry. Poll frequently enough to observe a queue
entry before it disappears on merge; this observer cannot reconstruct an
unobserved transient queue entry after the fact.

Polling rejects foreign repositories, fork PRs and changed heads. Conflicting
PR/head/merge identities within one attempt are rejected by the journal. A
rewritten head requires a fresh publication receipt with a new attempt; READY
and claim evidence for that new attempt must actually be observed.

Each child has a 15-second timeout and a 2 MiB output cap. One poll makes bounded
sequential reads: one PR, one queue query when open, or up to five release-tag
comparisons plus repository metadata and up to 100 exact-commit push runs when
merged. The release list is limited to 20 records. Bounded searches report
`release-search-bounded` or `main-ci-search-bounded` when they cannot establish
exhaustive absence. Failed, truncated, partial or malformed evidence appears in
`unavailable`; independently verified events are retained. Poll exits 1 if any
evidence was unavailable. An empty valid result does not emit a station.

## Journal, replay and coverage

The default journal is `~/.ashlr/telemetry/router-queue/events.json`. Use
`--journal /private/directory/events.json` on every command to share another
explicit box-owned journal. Its directory must be owned by the current user
and mode 0700; files use mode 0600. Symlinks, hardlinks and corrupt or oversized
journals are refused. The existing local-store lock serializes writers and the
atomic writer fsyncs file and directory changes. Failed writes never advance
a separate cursor. Successful retries deduplicate the same receipt.

Events contain schema version, deterministic event ID, job/repository/attempt,
station, first observation time, source and allowlisted evidence IDs. They do
not contain raw GitHub responses, check names, titles, bodies, file paths or
logs. These local receipts are observational metadata, not signed authority or
release attestation. Read the durable journal for downstream delivery: stdout
contains only newly added events and is not a transactional delivery channel.

```sh
phm telemetry queue status --job EXAMPLE-1 --repo example/project --attempt claim-1
phm telemetry queue status --job EXAMPLE-1 --repo example/project --attempt claim-1 --require-complete
```

Status returns `seen`, `missing` and `complete`. `--require-complete` exits 1
unless all nine stations were observed for this attempt. Default status exits
0 when it can read the journal, including an empty history. Bad CLI syntax
exits 2; unsafe inputs, storage errors or unavailable polling exit 1 with a
fixed message that does not echo sensitive input.

Journal history is never silently pruned. At 16 MiB, append refuses; stop
writers, preserve the journal as an archive, and select a new private journal
explicitly. Coverage is scoped to the selected journal, so retain the original
for historical queries. Retry ingestion after resolving contention or restoring
safe storage; do not replace an unreadable journal with an empty one.

## Verification boundary

The focused suites exercise one job through all nine stations with fixture
GitHub responses, durable replay and CLI coverage, as well as missing and
malformed evidence. They run offline with a temporary HOME:

```sh
HOME=$(mktemp -d) npx vitest run test/queue-stations.test.ts test/queue-station-store.test.ts test/queue-station-cli.test.ts --maxWorkers=1 --no-file-parallelism
```

Live box acceptance additionally requires its real adapters/hooks, a verified
Locus session and a real job's journal containing each applicable station.
Fixture success does not establish that external deployment.
