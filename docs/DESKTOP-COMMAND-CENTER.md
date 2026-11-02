# Phantom desktop: watch and steer the fleet

People need to see what the fleet is doing and where it needs attention. Everything else is autonomous; for the older command-center contract, see [Command Center](COMMAND-CENTER.md).

## One surface, five places

The desktop is one window with distinct places for distinct questions. Status labels describe the route or feature on master, not a promise that a landing surface already exists.

| Place | What it answers | Data it reads | Poll |
| --- | --- | --- | --- |
| **Ops ▸ Live runs** | What is running on this Mac now: lanes, workers, leaders, merges in the last hour, personal Codex usage, kill switches and the inbox tail? | `GET /api/verse/fleet/runs` [^landing] | 5 s |
| **Ops ▸ Fleet & router ▸ Lanes on this Mac** | How much credit, queued and live work, and recent merges does each lane have? | `GET /api/fleet/lanes`, `fleet.lanes.v1`; the placement is landing [^landing] | 15 s |
| **Fleet ▸ Tell the leaders** | What should the leaders hear, and what were the last entries? | `GET /api/verse/fleet/runs` reads recent entries; `POST /api/verse/fleet/runs/inbox` appends via `src/core/fleet/mason-inbox.ts` and `src/web-ui/routes/verse/fleet/InterjectBox.tsx` submits [^master] | Snapshot: 5 s; submit on request |
| **Rail badge** | Does the fleet need attention? | `GET /api/verse/fleet/runs`; `src/web-ui/routes/verse/shell/fleet-runs-badge.ts` [^master] | 5 s |
| **Working on this Mac card + job detail sheet** | What is running here, and what happened in a job? | `GET /api/verse/fleet/runs` and `GET /api/fleet/job` [^landing] | 5 s; detail on request |
| **Ops ▸ Leaders ▸ Leader passes** | What did each leader do in a pass? | `GET /api/verse/ops/leaders` [^landing] | While visible |
| **Publish → merge funnel** | Where is work between publishing and merging? | `GET /api/verse/fleet/runs` [^landing] | 5 s |
| **Fleet header ▸ Switches** | Which fleet controls are active? | `GET /api/verse/fleet/control/switches` [^landing] | While visible |
| **Command ▸ Right now tiles** | What needs attention right now? | `GET /api/verse/fleet/runs` [^landing] | 5 s |
| **Usage ▸ Personal Codex burn** | How quickly is personal Codex capacity being used? | `GET /api/verse/fleet/runs` [^landing] | 5 s |
| **⚙ menu ▸ Update** | Is a desktop update available? | `GET /api/verse/ops/self-update` [^landing] | On request |
| **Window title** | Which fleet state is visible at a glance? | `GET /api/verse/fleet/runs` [^landing] | 5 s |
| **Resources drawer (⌘.)** | What is each account's live usage? Claude has no session cap now; show its weekly window only. | Shared capacity, health, budget and provider readings; preserve unknown and stale states [^master] | While open, using each source's cadence |
| **Settings ▸ Desktop ▸ Updates** | Is an update available, and can the desktop apply it and restart? | `GET /api/verse/ops/self-update`; apply and restart follow [^landing] | On request |

[^master]: On master: the named route or existing resource surface is present; placement and new behavior may still be landing.
[^landing]: Landing: proposed contract, not yet available on master. Do not treat it as current behavior.

## Pulse and incidents

The Ops pulse line uses `src/web-ui/routes/verse/ops/MergePulse.tsx` and `src/web-ui/routes/verse/ops/merge-pulse-model.ts`: no start and no merge in 30 minutes signals a stall [^master].

Evaluate the rule only when the necessary evidence is known; a null count is never shown as zero or used as proof of inactivity. The notification bell category **Fleet on this Mac** and phone projection are landing [^landing]. The agent bus feed and runs graph are also landing [^landing].

## Phone

The planned `/verse/m/#/runs` shows the same snapshot and the same leaders' inbox through the phone's guard [^landing]. The phone can read and submit an inbox message through that guard; it cannot apply updates, restart the desktop, install software, or bypass mutation and authority checks.

## Honesty rules

- Unknown is `—`, not 0; distinguish stale, unavailable and loading readings.
- Sources degrade independently; one failed source must not erase healthy evidence.
- Show basenames only, never paths, prompts or secrets.
- Every write goes through the mutation gate.
- The browser never gains install authority.

## Kill switches

The switches API is landing: `GET /api/verse/fleet/control/switches` reads and `POST /api/verse/fleet/control/switches` changes six flag roles: leaders off, Opus leader off, pause launches, publish hold, hold dispatcher, and queue disabled [^landing]. Do not claim a switch is clear when its source cannot be inspected.

## For the next job

- Name a NEW test file for the job, so parallel work does not collide.
- Never edit a file another in-flight job owns; check the in-flight job prompts in the runs dir for ownership.
- Narrow `/api/verse/fleet/runs` locally at the boundary, and treat 404 as “not in this build.”
