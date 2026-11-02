# Phantom desktop: watch and steer the fleet

People need to see what the fleet is doing and where it needs attention. Everything else is autonomous; for the older command-center contract, see [Command Center](COMMAND-CENTER.md).

## One surface, five places

The desktop is one window with distinct places for distinct questions. Status labels describe the route or feature on master, not a promise that a landing surface already exists.

| Place | What it answers | Data it reads | Poll |
| --- | --- | --- | --- |
| **Ops ▸ Live runs** | What is running on this Mac now: lanes, workers, leaders, merges in the last hour, personal Codex usage, kill switches and the inbox tail? | `GET /api/verse/fleet/runs` [^landing] | 5 s |
| **Ops ▸ Fleet & router ▸ Lanes on this Mac** | How much credit, queued and live work, and recent merges does each lane have? | `GET /api/fleet/lanes` [^master], `fleet.lanes.v1`; the placement is landing [^landing] | 15 s |
| **Fleet ▸ Tell the leaders** | What should the leaders hear, and what were the last entries? | `POST /api/verse/fleet/runs/inbox` appends to the leaders' inbox file under the runs dir; show the snapshot's recent entries [^landing] | Snapshot: 5 s; submit on request |
| **Resources drawer (⌘.)** | What is each account's live usage? Claude has no session cap now; show its weekly window only. | Shared capacity, health, budget and provider readings; preserve unknown and stale states [^master] | While open, using each source's cadence |
| **Settings ▸ Desktop ▸ Updates** | Is an update available, and can the desktop apply it and restart? | `GET /api/verse/ops/self-update`; apply and restart follow [^landing] | On request |

[^master]: On master: the named route or existing resource surface is present; placement and new behavior may still be landing.
[^landing]: Landing: proposed contract, not yet available on master. Do not treat it as current behavior.

## Pulse and incidents

The planned Ops pulse line, notification bell category **Fleet on this Mac**, and phone share the same incident: no start and no merge in 30 minutes. Evaluate that rule only when the necessary evidence is known; a null count is never shown as zero or used as proof of inactivity. These projections are landing [^landing].

## Phone

The planned `/verse/m/#/runs` shows the same snapshot and the same leaders' inbox through the phone's guard [^landing]. The phone can read and submit an inbox message through that guard; it cannot apply updates, restart the desktop, install software, or bypass mutation and authority checks.

## Honesty rules

- Unknown is `—`, not 0; distinguish stale, unavailable and loading readings.
- Sources degrade independently; one failed source must not erase healthy evidence.
- Show basenames only, never paths, prompts or secrets.
- Every write goes through the mutation gate.
- The browser never gains install authority.

## Kill switches

The landing runs view reports under `switches` the files under the runs dir that pause dispatch, by their reported roles [^landing]. Do not infer filenames or claim a switch is clear when its source cannot be inspected. The existing lane projection does not identify those files; see the [CLI reference](CLI-REFERENCE.md) for the documented fleet pause and resume commands and the separate global kill switch.

## For the next job

- Read `src/web-ui/DESIGN.md` before designing a surface.
- Reuse `useQuery` for shared reads.
- Reuse `usePollWhileVisible` for visible polling.
- Narrow data structurally at the boundary.
- Degrade on 404 without hiding other sources.
- Keep poll cadence appropriate to the place.
- Preserve unknowns and source freshness.
- Send writes through the mutation gate.
- Name a new test file, such as `test/docs-desktop-command-center.test.ts`.
- Never touch the owner-reviewed paths.
