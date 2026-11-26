# Session continuity and quota failover

`session-handoff.v1` preserves authored task state across lanes and models. This
release is **advisory**: the repository dispatcher emits packet references, and
an explicit harness can checkpoint and resume. It does not activate automatic
replay, change the live launcher, install anything, or spend model credits.

## Record and storage

The wire path is `<runs-dir>/handffs/<job>.jsonl` (the `handffs` spelling is
intentional), normally under `~/.ashlr-runs`. Create the runs directory first;
Git repositories, including ignored directories, are refused as storage roots.
The journal directory is private (0700), files are 0600. Each append preserves
history through a locked, fsynced atomic replacement; expected revision is a
compare-and-swap. Torn, malformed, secret-bearing or oversized history is
refused without falling back to an older checkpoint. A new attempt needs a new
job ID; an existing job's attempt, repository, goal and capability floor cannot
be replaced or weakened by appending.

The strict schema is in [session-handoff-schema.ts](../src/core/agents/session-handoff-schema.ts).
Records include job/attempt/repository identity, source lane/model, required
capabilities and minimum tier, goal, ordered plan with done/pending state, files
touched, decisions, evidence references, exact next action and context digest.
Narrative strings are scrubbed using the shared credential scrubber **before**
truncating the context digest to 8,192 characters. Other oversized fields refuse;
records are at most 32 KiB and journals at most 4 MiB. Store references rather
than transcripts or command output. No claim credentials enter the packet.

Repository evidence binds the canonical worktree path, HEAD, staged and unstaged
binary diffs, porcelain inventory and untracked file bytes. Only hashes are
stored. Fingerprinting is bounded to 128 untracked files / 16 MiB, with a
five-second deadline per Git command. Unsupported untracked symlinks and
nonregular files refuse. Ignored files are outside this contract. Stop mutations
while capturing; resume requires the same worktree, including dirty files.
There is no automatic checkout, reset, stash, patch application or remote copy.

The HEAD commit's `Entire-Checkpoint` trailer is retained when it contains a
legacy 12-hex ID or a 26-character ULID. It is an evidence reference, not proof
that the Entire store is installed or accessible. Entire's existing hooks own
checkpoint creation; this protocol never commits or copies transcripts. See
[Entire's checkpoint contract](https://github.com/entireio/cli/blob/main/docs/architecture/sessions-and-checkpoints.md)
for branch/ref storage and recovery. A missing Entire checkpoint is recorded as
`null`; worktree fingerprint verification still applies.

## Author and inspect

`phm checkpoint handoff save request.json /absolute/runs /absolute/worktree --json`
accepts a JSON object with `draft`, `signal` and `expectedRevision` (zero initially).
The draft has all authored fields described above; generated schema/revision/time
and repoState fields are omitted. For example, `signal` is
`{"kind":"checkpoint"}` at a natural boundary, `{"kind":"rate-limit","status":429}`,
`{"kind":"quota-exhausted"}`, or
`{"kind":"budget","remainingFraction":0.08,"threshold":0.1}`. Signals come from
the provider adapter or measured budget; arbitrary transcript text is not a signal.
`{"kind":"completed"}` requires every plan step done and closes the journal.

`phm checkpoint handoff show /absolute/runs JOB --json` validates the full journal
and prints the latest row. `phm checkpoint handoff list /absolute/runs --json`
indexes every journal without knowing job ids: each entry reports job, attempt,
revision, timestamp, lane, model, tier, repo, signal, required capabilities,
open-or-completed state and HEAD — never goal, plan, decisions or context
digest, which stay behind `show`. The scan is bounded to the newest 256 journals
by file time and sets `truncated` when more exist; a journal that fails the same
validation `show` applies lands in `unreadable` by job id instead of poisoning
the index. A never-written store reports `status: "missing"` (verified absent,
empty lists); a store that cannot be read reports `status: "unavailable"` with
null lists — unknown stays unknown. `phm checkpoint handoff plan resume.json --json` is
read-only. Its request contains `runs`, `worktree`, `job`, `attempt`, `repo`,
`lane`, `model`, `tier`, `owner` and `capabilities`. For example, a target can be
`lane: "claude", model: "model-b", tier: "work", capabilities: ["typescript"]`.
All verbs return exit 2 on refusal and withhold raw parser/IO diagnostics.
Use `npm run dev -- checkpoint handoff ...` when testing this source checkout.

`phm checkpoint handoff failover request.json --json` accepts `{options, candidates}`:
`options` is the resume request above; each candidate supplies `lane`, `model`,
`tier`, `capabilities`, `available` and `remainingFraction` (0–1 or null).
The host supplies these enrollment/usage observations. The first capable,
available lane with measured remaining capacity is selected, excluding the
exhausted lane. Unknown/zero capacity and lower tiers stay pending. A ready
advisory contains a validated packet and exact resume arguments; it executes
nothing. The acceptance harness consumes those arguments to run the next turn.

## Harness resume contract

Use `runSessionTurn(options, callback)` from
[session-handoff.ts](../src/core/agents/session-handoff.ts). The callback receives
the validated record, `checkpoint(draft, signal)`, `assertLease()` and an abort
signal. Persist the initial record before starting. The harness must map provider
429/quota events and measured budget thresholds to checkpoint signals, and call
checkpoint after each verified edit/test/plan boundary. Below-threshold budget
and quota signals persist before yielding; no further callback work should run.
On abrupt process death, the last durable boundary remains available. A hard
kill cannot capture progress since that boundary; changed repo state refuses
automatic resume until explicitly reconciled into a new checkpoint.

Resume refuses mismatched attempt/repo, completed work, missing capabilities,
a lower tier, future/over-24-hour records and changed worktree evidence. Target
capabilities/tier must come from trusted enrollment, not the packet itself.
It acquires the existing [Agent Bus v2](AGENT-BUS.md#v2) queue and repository
claims, then rechecks the checkpoint/repo before work. Unique claim source IDs
prevent a repeated owner from replacing another worker's lease. Claims renew
every 20 seconds with a 60-second lease; renewal failure aborts the callback's
signal. Respect that signal and call `assertLease()` before mutations. Every
checkpoint checks the claim again before publication. Partial acquisitions and
normal exits release only their own claims; a crash leaves leases to expire.
Completion requires a completed checkpoint. Claims grant no execution authority.

## Dispatcher rollout and verification

The source dispatcher emits `session-failover.v1` advisory rows for recognised
provider quota exits (including EMPTY outcomes and failed partial work) and for
pending jobs with measured zero quota. Rows contain only identity, an optional
existing-market target and the expected packet path. They do not assert that a
packet exists or is valid. Failed-run advice uses the existing once-per-attempt
marker; pending advice is an observation on each applicable tick. Existing
market routing, holds, admission, reaping and launch behavior are unchanged.

Security must review and re-pin `dispatchd.py` plus `session_handoff.py` before
installation through the sanctioned installer. A later activation must preserve
the interrupted worktree, stop/fence the original worker, validate the packet
and trusted target capabilities, reacquire claims, then pass the resume packet
to the launcher instead of re-running the original prompt. Missing packets,
unknown liveness, no capable capacity and changed worktrees must remain pending.
No enforce switch or live install is included here.

The hermetic TypeScript acceptance test completes four of five steps, receives
429, releases claims, resumes on another lane/model, and checks the exact final
artifact with no repeated steps. It also covers content drift with unchanged
porcelain status, capability/tier refusal, concurrent claims, budget signals,
scrubbing, private storage, corrupt history and CLI round trips. Python tests
exercise the repository dispatcher with a synthetic HOME and launcher. These
prove protocol continuity, not equal reasoning quality, latency or success rate
across real models; such claims require measured provider evaluations.
