# CONTRACT-DONE-CONTRACT-V1: done-contract.v1

Status: source-complete, local-only, fail-closed, authority-free. The
validator interprets a per-job file contract and reports a verdict; it does
not publish, merge, requeue, dispatch or grant any of those effects.

## Purpose

RQ-SWE5-DONE-CONTRACT (research digest item 3) replaces the freeform
BRIDGE_NOTES.md expectation with a layered, file-based contract one generic
validator can interpret for any repo:

- **Floor** — framework checks every job must pass (`typecheck`, `unit`,
  `lint`, `secrets` via `changeCommands` repo detection, or explicit
  commands).
- **Acceptance** — per-job criteria frozen into the dispatch prompt and
  attested in the notes file (the batcher checklist grammar) or proven by
  `command:`/`file:` evidence.
- **Verify** — per-job commands whose exit 0 proves a criterion.

Backward compatibility is a hard requirement: worktrees with no contract
evaluate under the legacy rule — a present, non-empty notes file — so
in-flight jobs never need re-dispatch.

## Surface

`src/core/done-contract.ts` exports:

- `doneContractSchema` / `doneContractCommandSchema` — the zod schema
  (strict objects; `done-contract.v1` discriminator; cross-field rules:
  unique command/acceptance ids, `command:` refs resolve to declared
  commands or check names, worktree-confined relative paths, at least one
  enforceable layer).
- `parseDoneContract`, `doneContractBlock`, `extractDoneContract`,
  `loadDoneContract`, `contractNotesFile`, `attestedIds` — carriers and the
  `<!-- done-contract:done-contract.v1 -->` … `<!-- /done-contract -->`
  embed grammar (first fenced ```json block binds; other lines inside the
  markers are ignored).
- `doneContractPlan`, `evaluateDoneContract`, `doneContractHandoff` — the
  validator: resolves floor checks repo-agnostically, runs argv-only
  commands through an injectable runner (default spawnSync, no shell,
  per-command timeout, 8 MiB cap, `cwd` confined under the root), counts
  attestations, withholds child output, and emits `DoneContractVerdict`.
- `schema/done-contract.v1.schema.json` — generated draft-07 structural
  subset for non-TypeScript tooling (`z.toJSONSchema`; refinements and
  cross-field rules are validator-enforced and documented in the file's
  description).

`phm verify done --worktree <path> [--contract <path>] [--plan]` is the CLI
entry: JSON verdict on stdout, handoff on stderr, exit 0/1/2 (pass / fail
or malformed / usage).

## Safety invariants

- Fail closed: a claimed-but-malformed contract is an error, never a
  silent downgrade to notes mode; undetected floor checks, missing notes
  and unproven required items all fail the verdict.
- Output hygiene: child stdout/stderr never enters the verdict —
  `first_error` is a category, mirroring `verifyChange`.
- Confinement: `cwd`, `file:` evidence and `notesFile` are printable-ASCII
  relative paths under the worktree; timeouts are bounded (1 s–1 h).
- Bounds: notes ≤ 64 KiB (integrated-merge), contract source ≤ 256 KiB
  (batcher parse bound).
- Authority: the verdict is local evidence. A committed
  `DONE_CONTRACT.json` chooses verify commands — the same class as
  `ashlr.verify.json`; owner-lane protection of that path is a flagged
  follow-up (requires the generated CODEOWNERS regen).

## Verification

`test/done-contract.test.ts` — hermetic: tmpdir fixture worktrees, an
injected runner for command evaluation, real `node -e`/`npm run` argv only
inside fixtures, no real HOME or endpoints.
