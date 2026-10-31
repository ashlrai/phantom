# Task-aware bandit lane

[Source](../../src/core/routing/task-bandit.ts) implements the RQ-PARITYROUTERTASKQ7
lane inside the existing seat router. There is no second router: the bandit
draws an arm, `routeSeat` narrows capacity to that arm's engine, and the
unchanged routing core still decides the seat — every eligibility, headroom,
context-fit and funding check stays exactly where it was. Devin seats keep
their own session-lane verdict; a drawn `devin` arm can never bypass it.

The lane is off unless a caller passes `opts.taskBandit` on an autonomous
request. Interactive routing is never consulted by the bandit, and a disabled
or absent flag produces a byte-identical `SeatDecision` with no `bandit`
field at all.

## How a decision is made

1. **Classify** the request into a context cell: task class (the request's
   `RoutingTask`), size bucket (`contextTokens` against `sizeEdges`), risk
   class (`difficulty`, or a hint override), and repo (`owner/name`, else
   `unknown`).
2. **Gate** the arm catalog: only engines present among the caller's seats,
   only frontier engines for risky work, only pools whose #938 pacing
   allowance clears the floor, and never credentialed work.
3. **Draw** once per remaining arm from the deepest cell level holding at
   least `minCellSamples` observations — a Thompson Beta sample. Every
   outcome updates four cell levels (exact → repo-free → size-free →
   global), so a cold cell borrows strength instead of starting cold.
4. **Apply** per mode: `shadow` attaches the annotation to the static
   decision; `enforce` tries the drawn engines in θ order through the seat
   router and holds when no drawn engine produces an eligible seat.

## Arms and engines

Arms are `(engine, model, effort)` triples over the five named engines —
Claude Code, Codex, Grok, Devin and the local runtimes (oMLX rides `local`).
`claude-api` is absent: an engine outside the catalog is unknown, is never
an arm and is never selected. `model` and `effort` are advisory for dispatch;
the seat router admits a seat by engine.

Risky contexts stay frontier-only per #926: `riskClass === 'high'` or a merge,
merge-rights or publish authority hint admits no `local` arm. A `local`-only
fleet on a risky task holds in enforce mode rather than relaxing the gate.
Credentialed work holds outright — no model seat holds secrets.

## Reward

Success means merged AND green checks. A success earns
`min(1, tokenNorm / max(tokens, tokenFloor))` — merged-and-green per token —
and anything else earns zero. Beta posteriors therefore optimize
merges-per-token, not merges alone. Missing token evidence is the floor
(full credit), never a synthesized cost.

## LP pacing constraint (#938)

`TaskBanditInput.pacing` maps each engine pool to its current window
(`used`, `windowStartMs`, `resetAtMs`, optional `paceWindow` knobs and
reading stamp). The lane asks `paceWindow` for the pool's first-period
allowance and drops arms whose pool does not clear `pacingFloor`. Supplying
a pacing map is opt-in: absent means the constraint is inactive; a map that
omits or invalidates a pool fails that pool closed — unknown usage is not
headroom.

## Flag and config

`TaskBanditInput` travels on `RouteOptions.taskBandit`:

| Field | Meaning |
|-------|---------|
| `config` | Raw `taskBandit` config; `parseTaskBanditConfig` salvages valid fields, defaults invalid ones, ignores unknown keys and keeps the lane off for absent input. `enabled: true` without a valid `mode` parses to `shadow`. |
| `state` | Persisted Beta posteriors; corrupt or foreign shapes fail closed to the prior. |
| `hints` | `itemKey` (seeds the deterministic draw), `repo`, `riskClass`, authority roles (`mergesToMain`, `holdsMergeRights`, `publishes`), `needsCredentials`. |
| `pacing` | Per-engine window snapshots for the #938 constraint. |

Every draw comes from a mulberry32 stream seeded by FNV-1a(`seed`, `itemKey`),
so a replay reproduces the same arms. The module is pure and browser-safe:
no `node:` imports, no I/O — the caller owns persistence and evidence.

## Evidence and replay

A settled decision is logged as a `phantom-task-bandit-outcome/v1` record:
context, the arm that actually ran (id or triple), the engines seated at
decision time, optional authority and pacing evidence, and the measured
outcome. `recordTaskOutcome` folds it into the posteriors; an arm unknown to
the catalog earns no credit.

`replayTaskBandit` is the offline estimator the acceptance runs on fixture
history (see `test/fixtures/task-bandit/`). It replays each record in order:
the bandit — trained only on what it has kept so far — draws among the arms
passing every gate at that record; a draw equal to the logged arm credits
the real outcome (rejection sampling), and a mismatch drops the record
because a log cannot say what an unchosen arm would have earned. The report
compares the bandit's kept-evidence metrics against the logged policy's and
counts held records, unknown-engine records and every arm drawn.
