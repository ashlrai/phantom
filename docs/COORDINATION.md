# Coordinate work across the fleet

Mason's orders are to coordinate rather than collide (23:06, October 31)
and avoid wasted work, including a DIRTY PR (19:28). This page describes
what the current master provides and the operator decisions still needed.
A displayed overlap is a signal to coordinate, not a reservation of a file.

## Three ways work collides

1. An outside agent, including work shipped through Devin on a supporting
   repository, edits a file a fleet job is changing. Both may be correct,
   but the later PR can conflict and need a fresh implementation and checks.
2. A hand-made PR and a fleet job touch the same file. The same merge-time
   cost applies, and a late discovery can waste review as well as compute.
3. Two fleet jobs change the same file. Shared top-of-file entries and
   generated files are especially likely to conflict; the later job may
   require a recut and fresh verification.

A GitHub `DIRTY` PR is a conflict, not a verdict that the code is bad.
Avoiding it saves the work of reconstructing and checking the later change.

## See outside work in Merges

Open the Merges pane and expand **Outside PRs**. This is the exact heading
in `src/web-ui/routes/verse/fleet-merges/FleetMergesPane.tsx`. A row shows
the repository, PR number, title, author and age. A `collides with <job>`
button opens that job's log; its tooltip names up to five overlapping paths.
For example, a row can include:

```text
collides with job-123
```

The data comes from `src/core/fleet/outside-prs.ts`, exposed by
`src/core/verse/fleet-live-api.ts` as
`GET /api/verse/fleet/live/outside-prs`. The response includes each PR's
files and overlaps with running jobs' changed paths. It scans distinct repos
of claimed jobs plus the workspace repo. PRs with a `codex-bridge/` head
or the fleet App as author are excluded from this outside list.

An illustrative response fragment is:

```json
{"repo":"example/project","state":"healthy","prs":[{"number":42,"title":"Improve parser","author":"dev","head":"dev/parser","updatedAt":null,"files":["lib/parser.ts"],"overlaps":[{"job":"job-123","paths":["lib/parser.ts"]}]}]}
```

The response has a top-level `sourceState`. Missing `gh` produces `missing`;
unreadable sources can produce `degraded`. The pane says **Outside PR check
unavailable (gh missing).** or **Outside PR data may be incomplete.**
An empty or incomplete observation does not reserve a path or prove safety.
Results are bounded and cached, so check again as work changes. The scan
compares changed files, not an agent's intended future edits.

## Shared-file checks

`src/core/fleet/collision-free-edits.ts` defines the shared-file policy:
README and changelog singletons, `CLAUDE.md`, lockfiles and unsafe paths
are refused by its check. A suitable changelog edit can be diverted to a
job-specific fragment when the caller supplies valid fragment content.
`src/cli/fleet-edit-collisions.ts` exposes a read-only path check:

```sh
printf 'README.md\n' | phm fleet edit-collisions
```

Example first line:

```text
edit-collisions: refused 1 of 1 paths
```

The command reports each rule and reason, exits 1 on refusals, and does not
write files or grant merge permission. `src/cli/knowledge-edit-preflight.ts`
checks edit contents and optional changelog metadata through the same policy;
`phm knowledge edit-preflight --help` describes its input. Job change
projection in `src/core/fleet/runs-job-changes.ts` also reports refusals.
These are wired checks and projections; the inspected master does not establish
that every bridge publish is blocked by this policy. Do not assume universal
enforcement from the advisory CLI or the worker-log projection.

## Conflict detection and recuts

`src/core/fleet/fleet-merge-state.ts` classifies GitHub `DIRTY` or
`CONFLICTING` as `conflicted` with reason `merge-conflict`.
`src/core/fleet/merge-backlog-plan.ts` places conflicts in its recut lane.
Inspect the advisory snapshot using `src/cli/fleet-backlog.ts`:

```sh
phm fleet backlog --repo example/project
```

For example, its counts line can read:

```text
  0 ready, 0 behind, 1 conflicting, 0 repair, 0 waiting
```

A backlog plan does not merge or authorize work. A recut replays the
proposal on the current base and needs fresh verification and existing gates.
`src/cli/autopilot.ts` provides `phm autopilot 42 --repo example/project`
to plan for an owned PR. With `--apply`, it can recut a conflicting lane
on a fresh branch and verify it; it closes the superseded PR only after the
recut merges. It does not itself merge the PR. Check the plan and ownership
before choosing to act.

## Mason's response to an overlap

- Open the collision's job log and compare the named paths with the outside PR.
  Agree on which change should land first; let the outside PR land first when
  it owns the shared change, then base the fleet work on the new result.
- Steer the affected run with a note such as “avoid the parser file; the
  outside PR owns it.” `src/core/fleet/fleet-control-types.ts` defines
  `interject`: headless engines cannot accept live input, so this stops and
  requeues a run with the note in its brief. It is not an in-place edit.
- Pause the affected repository from the Fleet surface while coordinating.
  `src/core/verse/fleet-live-api.ts` accepts a `pause-repo` action on
  `POST /api/verse/fleet/live` with the repository and reason. Resume only when
  the competing work and next attempt are understood.
- If a PR is already DIRTY, inspect the backlog and recut rather than treating
  the old branch's checks as proof for a new base.

## Before an outside agent edits

1. Read `GET /api/verse/fleet/live` for the fleet snapshot and runs, or
   `GET /api/verse/fleet/runs` for the runs view. The latter is implemented in
   `src/core/verse/fleet-runs-api.ts`. Inspect the relevant job and its changed
   paths; a missing job or unchanged file is not a claim on future work.
2. Check **Outside PRs** and the open PRs in the target repository. Coordinate
   with Mason if another hand owns the intended path. Keep each job's scope
   disjoint where practical; master does not state a one-file-per-job rule in
   the contributor or agent instructions.
3. The fleet identifies `codex-bridge/` branches as fleet work for the outside
   PR filter. An outside agent using that prefix will be hidden from that
   particular list, so use it only when the work is actually fleet bridge work.
4. Record the repository, branch, intended paths and status on the durable
   local bus using `phm comms bus post --file <envelope.json>`, then read it
   with `phm comms bus read`. `src/cli/comms-bus.ts` documents the envelope
   and filters; `docs/CHANNELS.md` describes the channel feed. The bus is
   local JSON transport with no delivery handlers or authenticated identities:
   posting is a coordination notice, not a lock or proof anyone saw it.
5. Recheck before opening a PR and after the base moves. If the work overlaps,
   agree on order and update the notice instead of silently racing.

## Current limits

No hot-file pack was found by the requested master searches under fleet and
CLI, and no universal one-file-per-job rule was found in the named instructions.
Treat hot spots and disjoint ownership as operating advice, not an automatic
reservation. The durable bus guide named in the request is absent from master;
the bus CLI help and channel guide are the available references.
