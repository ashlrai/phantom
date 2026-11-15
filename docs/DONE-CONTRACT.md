# Done contract (`done-contract.v1`)

One file-based contract answers "is this agent job done?" — instead of
freeform notes prose that every consumer re-interprets. The contract layers:

1. **Floor** — the framework floor every job in the repo must pass:
   `typecheck`, `unit`, `lint`, `secrets` check names resolved through
   [verify-change's](../src/core/verify-change.ts) repo-agnostic detection
   (package.json scripts, Cargo, pyproject, Go, or CI-declared invocations),
   or explicit commands for repos the detector cannot infer.
2. **Acceptance** — per-job criteria frozen into the dispatch prompt at
   enqueue time. Because the prompt is the job's immutable input, criteria
   copied verbatim into the notes file cannot silently weaken; sweeps can
   diff the embedded block against the frozen prompt.
3. **Verify** — per-job commands whose exit codes prove the criteria the
   floor cannot cover.

`phm verify done --worktree <path>` is the single generic validator — it
interprets the same schema for any repository. When a worktree has no
contract it evaluates the legacy expectation (a present, non-empty
`BRIDGE_NOTES.md`), so jobs dispatched before contracts existed remain
valid; prompts can adopt the contract incrementally, repo by repo.

## Carriers

The contract is file-based, in either of two carriers:

- **`DONE_CONTRACT.json`** at the worktree root — for repos and pipelines
  where an extra untracked file is allowed.
- **An embed block inside `BRIDGE_NOTES.md`** — for the bridge pipeline,
  whose integration proof requires BRIDGE_NOTES.md to be the only untracked
  file in a finished worktree:

  ````markdown
  <!-- done-contract:done-contract.v1 -->
  ```json
  { "schema": "done-contract.v1", ... }
  ```
  <!-- /done-contract -->
  ````

  Other lines inside the markers — a per-item checklist the worker keeps
  current — are ignored by the parser; only the fenced JSON binds.

An explicit `--contract <path>` (worktree-relative or absolute) overrides
discovery, e.g. when the queue keeps contracts beside its prompts.

## Schema

The canonical schema is `doneContractSchema` in
[src/core/done-contract.ts](../src/core/done-contract.ts);
[schema/done-contract.v1.schema.json](../schema/done-contract.v1.schema.json)
is the generated structural subset for non-TypeScript tooling.

```jsonc
{
  "schema": "done-contract.v1",          // required discriminator
  "job": "RQ-EXAMPLE-1",                 // optional dispatch job id
  "frozenAt": "2026-11-08T12:00:00Z",    // optional; when criteria froze
  "floor": {
    "checks": ["typecheck", "unit"],     // named checks via repo detection
    "commands": [                        // or explicit floor commands
      { "id": "gate", "cmd": ["npm", "run", "gate"],
        "cwd": ".", "timeoutMs": 600000, "required": true }
    ]
  },
  "acceptance": [
    { "id": "a1", "text": "x works", "evidence": "command:gate" },
    { "id": "a2", "text": "notes kept" },                       // evidence defaults to notes
    { "id": "a3", "text": "judgement", "evidence": "manual" }   // human-only; reported, never blocks
  ],
  "verify": [
    { "id": "v1", "cmd": ["node", "scripts/check.mjs"], "required": false }
  ],
  "notesFile": "BRIDGE_NOTES.md"         // default; null opts out of notes
}
```

Rules: command ids are unique across `floor.commands` and `verify`, and
share a namespace with `floor.checks` names (a `command:typecheck`
acceptance ref may name either). `command:<id>` evidence must name a
declared check or command. `cwd`, `file:` evidence and `notesFile` are
printable-ASCII relative paths confined to the worktree — no absolute
paths, backslashes or `..` segments. `timeoutMs` is 1 s–1 h (default
10 min). At least one of floor, acceptance or verify must be non-empty.

## Evidence kinds

| `evidence` | Satisfied when |
| --- | --- |
| `notes` (default) | The notes file carries `- [x] <id> — done: …` in the batcher checklist grammar — checked box, and the status word is not `failed`, `skipped`, `deferred`, `blocked`, `pending`, `unreported` or `todo`. Last line per id wins. |
| `command:<id>` | The named floor or verify command exited 0. |
| `file:<path>` | `<path>` exists under the worktree root. |
| `manual` | Never machine-checked — reported as `manual` for human judgement and does not block the verdict. |

A required item that is not satisfied reports `unproven` and fails the
verdict; `required: false` items report `optional-unmet` without failing.

## The validator

```bash
phm verify done --worktree <path>                  # evaluate: JSON verdict on stdout, handoff on stderr
phm verify done --worktree <path> --contract f.json # explicit contract path
phm verify done --worktree <path> --plan           # resolve and print the plan; run nothing
```

Exit codes: 0 pass (or a clean plan), 1 failed verdict or malformed
contract, 2 usage. A contract that exists but cannot be parsed fails
closed — it never downgrades the job to freeform notes.

Verdict shape:

```jsonc
{
  "pass": false,
  "mode": "contract",                 // or "notes" for the legacy expectation
  "job": "RQ-EXAMPLE-1",
  "source": "notes-embed",            // contract-file | notes-embed | none
  "notes_file": "BRIDGE_NOTES.md",
  "notes_present": true,
  "checks": [{ "id": "gate", "source": "floor", "required": true,
               "ok": false, "secs": 1.2, "first_error": "Check exited 1; output withheld for credential safety" }],
  "acceptance": [{ "id": "a1", "text": "x works", "status": "proven", "detail": "command gate exited 0" }],
  "error": null
}
```

## Safety

- This executes repository code with the local toolchain — trusted
  worktrees only, identical to `phm verify change`.
- Commands run argv-only (no shell), each with its timeout, an 8 MiB
  output cap and `cwd` confined under the worktree root. Child output
  never enters the verdict; `first_error` is a safe category.
- The notes file must be a regular file under 64 KiB (the
  integrated-merge bound); the contract source under 256 KiB (the batcher
  parse bound).
- A **committed** `DONE_CONTRACT.json` decides which verify commands run
  — the same authority class as `ashlr.verify.json`. It is intentionally
  untracked in the bridge pipeline; adding it to the owner-lane protected
  paths list (with the generated CODEOWNERS regen) is a flagged follow-up.
- The verdict is local evidence only. It does not publish, merge,
  requeue or grant any authority.

## Incremental rollout

The contract replaces freeform BRIDGE_NOTES expectations one prompt at a
time:

1. A dispatch prompt carries a `done-contract` block — rendered by
   `doneContractBlock()` — with the job's frozen acceptance items.
2. The worker copies the block verbatim into `BRIDGE_NOTES.md` (or writes
   `DONE_CONTRACT.json`), works the job, and flips each checklist line to
   `- [x] <id> — done: …` as it lands evidence.
3. `phm verify done` evaluates the worktree: floor + verify commands run,
   checklist attestations are counted, and the verdict is the structured
   answer sweeps and reapers already needed.
4. Worktrees without a contract still evaluate under the legacy notes
   rule — no reprompt, no re-queue of in-flight jobs.

Batch prompts can carry one contract for the whole session: checklist
lines inside the markers are ignored by the parser, so a batch's
per-member checklist coexists with a single contract block.

## Digest context

Implements item 3 of the 2026-11-05 research digest (layered
done-contract). The digest file lives under `~/.ashlr-runs/coordination/`,
which the lane sandbox denies; the item text comes from the dispatch
prompt verbatim.
