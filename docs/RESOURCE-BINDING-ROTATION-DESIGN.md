# Durable native binding rotation: design and test plan

Status: design only. No CLI or store mutation path is authorized by this document.

## Why the existing command cannot be used

`resources pool evolve` is append-only. It rejects every changed existing binding,
and `validateResourcePoolConfigHistory` rechecks that rule for every adjacent
epoch. Replacing a launcher in `bindings.json` without a migration makes the
schema-2 ledger unreadable and must remain rejected.

The affected installation has a two-epoch ledger. Its active epoch has four
workers: personal Codex General and Spark aliases, CMP Codex, and Claude. The
on-disk pool, bindings, and quota config still describe the preceding three-worker
epoch. Five historical receipts exist across both epochs. A read-only status
against the on-disk files fails; status against private copies of the ledger's
active pool and bindings succeeds. No historical data should be rewritten.

## Proposed operator contract

Introduce a distinct `resources pool rotate check|apply` command; keep `evolve`
additive. Its input names the current active pool, bindings and quota config;
their proposed replacements; the private ledger root; and the workspace. `check`
is read-only and returns a content-bound plan digest. `apply` requires that
digest, the console and quota collector stopped, and no reserved or uncertain
work. Existing lock and journal boundaries apply. The three operator config
files are part of this transaction: the command must pin their absolute private
paths, ownership, modes, and exact bytes before planning. A plan against the
stale three-worker files is refused until they have first been reconciled with
the ledger's active four-worker snapshot. The plan digest binds the expected
account hints and proposed commands, not an ephemeral provider probe result.

The pool policy, worker IDs, provider, model, quota scope, concurrency, reserve,
task-window limits, priority, capacity keys, binding kinds, and ordering must be
byte-equivalent after validation. Only the native command may change. All aliases
of one capacity key must rotate together to the same new launcher. A candidate
launcher already used by another capacity key is refused. No local endpoint or
non-native transport rotation is permitted. No worker addition/removal or quota
policy change is combined with a rotation.

Codex account continuity evidence comes from the native metadata probe through
the proposed launcher and proposed pool digest. At `apply` time, after acquiring
offline ownership but before writing a barrier, the command must run a fresh
metadata-only probe for each rotated capacity. It must return `observed`, bind to
the worker and proposed digest, and match that capacity's previously pinned
hint. Different capacity keys must have distinct hints. This hint hashes reported
type, email and plan. It is **continuity evidence, not a stable account identity,
independent subscription proof, billing attestation, or future quota**. An
operator must review native account and billing information separately. The
personal General and Spark aliases require their existing exact bucket scopes;
the new quota config must name both with one personal hint. For a provider
without a prior pinned hint, the first version of the command should refuse that
capacity. Claude therefore remains a separate commissioning problem until its
old and new identity evidence and explicit operator authorization are specified.
Grok has no task-pool worker to rotate.

The fresh apply-time proof must be validated **before** publishing any barrier.
Its canonical digest and bounded nonsecret facts, never credentials or raw
diagnostic text, must be bound into a private immutable journal. A clean first
`apply` cannot rely on a `check`-time probe because that report may have expired
while the operator reviewed the plan; `apply` must either establish fresh proof
against the plan's pinned hints or refuse before mutation. An interrupted
`apply` may resume using its exact already validated journaled proof and plan,
even after the original 60-second metadata expiry; it must not relabel that old
quota sample fresh. A changed proof, input, plan, or partial journal is refused.
This avoids stranding a half-published barrier because a provider metadata
report timed out during recovery. Tests must distinguish first apply from resume.

Use an independent request domain/journal namespace from additive evolution.
Extend historical configuration validation with an explicit structural rotation
transition, while keeping the old additive validator unchanged. Existing receipts
and console jobs continue to decode against their original digest and binding.
New work uses a third epoch. All observations for rotated workers become
unavailable in the new epoch; a fresh collector read is required before admission.
Preserve attempt receipts, their task-window counts, allocation ceiling and
revision, whole-account pauses, quota-scope exclusions and revisions, retained
conversation hashes, and queued-task holds. Never reset the ledger or copy an old
observation to a new launcher.

The durable sequence is: validate exact snapshots and current external config;
verify offline ownership and collector settlement; run fresh apply-time metadata
probes; write and fsync private before/after snapshots, nonsecret proof, and
journal; publish a pending ledger barrier; publish the console's new origin
metadata; publish the three proposed operator configs while admission is held by
the barrier; verify their exact bytes and modes; publish ready proof; publish the
active ledger last. The multi-file config publication is not atomic by itself:
the barrier must keep every mixed-file state unavailable, and crash recovery must
recognize only exact old/next file combinations from the journal. It must not
start a new collector between config writes. Resume is deterministic at each
boundary and requires the same plan digest. Finalized replay only verifies
preservation; it never overwrites later work. Existing 16-epoch and bounded-file
limits remain. `connections.json` is a separate Verse roster transaction and must
not be silently rewritten by this pool command.

A native quota collector pending marker, even with no visible process, is an
uncertain ownership record. Neither `check` nor `apply` may delete or infer it
safe from a stopped console. Use the supported collector recovery procedure to
establish a settled receipt and clear the marker under its own authority first;
then recheck the marker and lock absence before planning/applying. If the marker
cannot be reconciled, leave the ledger and config untouched. A recovered marker
does not itself prove account identity or quota freshness.

## Verification matrix

1. Pure policy: one or two Codex capacity groups rotate; personal General and
   Spark aliases rotate together. Reject partial alias, duplicate-account hint,
   command to another capacity, non-native binding, provider/model/policy change,
   addition/removal, stale/wrong-digest/wrong-worker proof, and missing hint.
2. Historical ledger fixture: start with two epochs and five receipts; after
   rotation there are three epochs, unchanged receipts and origin digests, and
   identical allocation (75% ceiling) plus personal General quota-scope exclusion.
   Current status works only against the proposed config. No old observation is
   admitted as fresh.
3. Console fixture: queued work stays held; terminal jobs and retained transcript
   hashes are unchanged. Active/uncertain work prevents check and apply.
4. Crash injection at every journal, barrier, console, each of the three config
   file publications, ready, and final-ledger publication. Every mixed-file state
   remains blocked. Exact resume succeeds after the probe's wall-clock expiry;
   changed or incomplete proof/journal/config fails closed without deleting
   evidence. A fresh first apply with expired or mismatched proof is refused.
5. Lock/collector tests: ownership and any pending native quota marker block
   apply. A recovery receipt without an absent marker is insufficient. Check
   never creates a lock or contacts a provider; first apply probes metadata only
   under the offline lock, never invokes a model or starts a resident service.
6. CLI tests: strict option parsing, exact plan digest, private bounded reports,
   redacted errors, no raw identities or secrets in stdout, explicit no-rollback
   wording after new work is admitted. Separate tests must show that a valid
   same-hint probe never claims a stable identity or independent capacity.
7. Run targeted policy/runtime/console/migration tests and typecheck, then full
   hosted CI. Rehearse `check` against copies of the real two-epoch ledger and
   reviewed config before any live apply.

## Near-term safe recovery

Restore the ledger's exact active four-worker pool and bindings snapshot to the
operator's top-level configuration, and derive the matching quota config with the
personal Spark worker using `codex_bengalfox`. The installed parser validates that
combination and a read-only status succeeds against the existing ledger. This
repairs the stale-config mismatch only: those bindings still use the pre-reboot
launchers, which reject device drift. Keep the task pool blocked until a reviewed
rotation implementation and fresh provider evidence are available. Verse's
separate four-seat `connections.json` can be switched after native sign-in and
profile witness upgrade without altering the task-pool ledger.
