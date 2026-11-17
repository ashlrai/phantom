# Persistent specialist roster (RQ-GROK-SPECIALISTS-1)

Named specialists outlive provider sessions. This store is separate from the
live `agent-roster.v1` projection and the Devin session roster
(`ashlr.devin-session-roster.v1`, sessions with id, sourceKind, title, status,
org and created). Neither existing roster is imported or changed.

## Schema and storage

`src/core/fleet/roster.ts` exports `Specialist`, `SpecialistRoster` and
`SPECIALIST_ROSTER_SCHEMA = 'fleet-specialist-roster.v1'`.
The envelope is `{schema, specialists: Specialist[]}`. Each specialist has:

- `id`: lowercase letter followed by up to 63 lowercase letters, digits or hyphens.
- `callsign`, `domain`: display identity and feature-area ownership.
- `allowedLanes`, `allowedModels`: string arrays; empty means unconfigured.
- `memoryPath`: exactly `memory/<id>.md`, relative to the roster directory.
- `currentJob`: job identifier or null; metadata, not a claim or launch.
- `stats`: nonnegative integer jobs, merges, reverts and emptyRate in [0,1].

Default: `~/.ashlr-runs/queue/specialists/roster.json`. All I/O APIs accept an
explicit directory. `loadSpecialistRoster` returns empty only for a missing file;
corrupt, unreadable, symlinked, non-regular or oversized files fail closed.
`saveSpecialistRoster` validates, writes an exclusive same-directory temp file,
syncs and renames. New files use 0600, directories 0700. Limits: 1 MiB per file,
1000 specialists. Unknown fields are projected out; memory paths cannot escape.

Pure operations: parseSpecialistRoster, findSpecialist, assignSpecialist,
setSpecialistCurrentJob and recordSpecialistOutcome. Assign creates a missing
identity with callsign equal to id and zero stats; reassignment preserves other
fields. Record once per terminal job: increment jobs, clear currentJob, update
merges/reverts and the fraction of empty jobs. A terminal reverted job counts as
merged and reverted. Notes do not change stats. Save returned snapshots explicitly.
CLI writes use `withSpecialistRosterLock` around read/modify/write; direct API
callers must do likewise. Existing locks fail immediately. After a crash, confirm
no writer is active before removing `.roster.lock`. Rename alone cannot prevent
lost updates. These APIs neither launch work nor acquire claims or permissions.

## Memory and next-prompt context

`src/core/fleet/specialist-memory.ts` exports SpecialistJobOutcome,
renderSpecialistOutcome, appendSpecialistOutcome, renderSpecialistPreamble and
loadSpecialistPreamble. Outcomes contain job, outcome, summary, optional timestamp
at, and optional decisions, pitfalls, filesTouched and conventions arrays.
Outcomes: merged, reverted, empty, completed, failed, note. Missing timestamps use
current time. Files are created lazily; append preserves prior entries. Each entry
has a timestamp/outcome heading and quoted text under the four named sections.
Preambles include identity, domain, lane/model preferences and the most recent
12000 characters of scrubbed memory, quoted as historical data. Missing memory
renders an explicit no-history message without writes. File and memory-directory
symlinks are refused; the caller-owned root must be trusted. Oversized memory
fails explicitly. Serialize concurrent appends for one identity. Free text is
scrubbed for secrets and home paths on persistence and rendering. CLI diagnostics
never echo exception paths or input. Prompt builders can prepend
`await loadSpecialistPreamble(specialist, directory)` to the next prompt.
Dispatch integration and automatic outcome ingestion are not activated here.
Statistics and memory are separate writes, not a transactional outcome ledger.

## CLI and verification

`cmdFleetRoster(args, deps?)` accepts injected directory, out and err callbacks.
Commands: `phm fleet roster list|show <id>|assign <id> <domain>|note <id> <text>`.
Quote multiword values; append `--json` for compact JSON. List returns the schema
envelope; show/assign/note return `{specialist}`. Exit 0: success; 1: state/operation
failure; 2: invalid arguments. Help does not access state. Example:
`phm fleet roster assign grokbot 'fleet routing' --json`.
`test/fleet-specialist-roster.test.ts` verifies persistence, immutable operations,
stats, memory/preambles, redaction, corruption, unsafe paths, symlinks, locking
and the complete CLI lifecycle with injected temporary roots.

## Evidence-derived identity (RQ-AGENT-IDENTITY-1)

Roster v1 optionally carries `identity: SpecialistIdentity`: `role` (nonempty
text, at most 200 characters), `capabilityTags`, `machineAffinity`, `laneAffinity`
and `peerIds` (deduplicated arrays, at most 100 entries of 200 characters).
Peer ids are opaque labels matching `[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}`,
unique across the roster; use transport-qualified labels such as `agentnet:dot`.
Older snapshots retain their exact field shape. Existing allowlists remain
separate from affinity hints. No routing, authentication or send gates consume
this metadata. `configureSpecialistIdentity` returns a validated snapshot;
`specialistForPeer` resolves a descriptive mapping or null and never authenticates.
The CLI `phm fleet roster configure <id> '<identity-json>' --json` serializes and
persists a complete metadata replacement for an existing identity.

`src/core/fleet/specialist-identity.ts` exports `buildSpecialistIdentity`,
`loadSpecialistIdentity`, `defaultSpecialistJobsPath` and
`SpecialistMeasuredOutcomes`. `phm fleet roster identity <id> --json` reads the
`fleet.specialist-identity.v1` projection: `{schema, specialist, outcomes,
authority, evidence}`. Specialist includes persisted metadata except legacy
`stats`; manually recorded counters and memory prose never supply measurements.
The default ledger is `../../metrics/jobs.jsonl` relative to the roster directory.
CLI dependencies may override `jobsPath`. Reads create no files. There is no
parallel outcome store, reputation score or inferred success rate.

Outcomes count distinct job/lane pairs attributed by admitted or complete
orchestration receipts and observed in timestamped launch, finish, outcome,
merged or revert records. Recognized job aliases: job/job_id/jobId; time aliases:
ts/timestamp/at. Rows predating assignment or in the future are excluded. A
missing lane is accepted only if exactly one journal pair matches. Conflicting
specialist attribution or multiple specialists for one pair is unmeasured and
increments ambiguousRows. Repeated terminal rows cannot inflate counts. Reserved
receipts supply no attribution. Jobs with multiple attempts on one lane count
once; no attempt-level claim is made. No merge or revert is inferred from another
outcome. Finish FAILED supplies failed; only explicit boolean empty values supply
emptySamples and emptyRate. Conflicting empty values remove that pair's empty
measurement. No samples yields null emptyRate; absent history yields zero counts.
Counts describe observed evidence, not lifetime completeness or durability.

Ledger reads are bounded to 16 MiB; unavailable, oversized or symlinked sources
are degraded, missing files are missing. Malformed JSONL rows are counted as
ignoredRows with sourceState degraded. Corrupt orchestration state fails closed;
missing journal is explicitly reported in evidence and produces no attribution.
The envelope states coordinationOnly=true, execution=false, sends=false.
Neither this view nor a peer mapping grants rights to external teammates.
