# RQ-REBASE-PHANTOM-3961 triage

Target: ashlrai/phantom PR #3961 ("bridge: RQ-DRAIN2-PH-37"). Disposition: **DONE-ALREADY (closed unmerged, content superseded on master)**. No rework performed; no unresolved PR was closed on this evidence (the PR was already closed by the owner before dispatch).

## Liveness probes (2026-11-16, all before any rework)

- Anonymous REST `GET /repos/ashlrai/phantom/pulls/3961`: `state=closed`, `merged=false`, `merged_at=null`, `closed_at=2026-11-15T03:33:20Z`, `merge_commit_sha=null`. Head: `masonwyatt23:codex-bridge/RQ-DRAIN2-PH-37` @ `edae677d62`.
- `git fetch origin refs/pull/3961/merge` → `fatal: couldn't find remote ref` (no server-side merge path; expected once closed).
- Closed ~21.3h before the dispatching roster snapshot (2026-11-16 00:52:07) — stale-roster dispatch, same pattern as RQ-REBASE-PH-4262.

## Why update/rebase was impossible even if open

- PR head lineage is pre-recut: parent commits are from the ~#3952 era, well before the ≈#5058 lineage cutover; head has unrelated histories with current `origin/master` (`34382b8fab` era), so neither `gh pr update-branch` nor a rebase/merge of default branch can apply.
- Agent-lane write path is absent on this host regardless (gh TCC-denied on `~/.config/gh`, no `GH_TOKEN`, `origin` push = `no_push`); nothing was pushed.

## Supersession proof (PR diff vs current master blobs)

PR #3961's diff (7 files, +446/−6):

- `src/cli/fleet-guardian-loop.ts` — **IDENTICAL** on master
- `src/core/fleet/guardian-repeat.ts` — **IDENTICAL** on master
- `scripts/evaluators/routing-off-policy.mjs` — **IDENTICAL** on master
- `test/routing-off-policy-research.test.ts` — **IDENTICAL** on master
- `test/guardian-idle-exit-02solv1.test.ts` — **IDENTICAL** on master
- `docs/research/routing-rl-ttc.md` — **EVOLVED** on master (later edit: "Baseline code and integration boundary" → "Current code and integration boundary", revalidation caveat removed)
- `docs/README.md` — diverged via unrelated master churn (index entry already superseded)

All substantive content landed on master via another path; the PR's residual value is zero. Closure was correct; nothing to re-land.
