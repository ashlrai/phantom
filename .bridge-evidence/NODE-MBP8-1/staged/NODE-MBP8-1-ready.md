# NODE-MBP8-1 security package (ready for review, NOT live)

Intended homes: ~/.ashlr-runs/staged/NODE-MBP8-1/ and ~/.ashlr-runs/bus/security/NODE-MBP8-1-ready.md.
The bridge sandbox denied writes under ~/.ashlr-runs, so the package is staged here; the operator copies it.

## Scope
`worker-profile-wiring.patch` touches `src/core/drive/nodes/worker.ts` (the node worker's admission path), nothing else.
Everything else in this change is read-only or pure and is in the PR tree:
`profiles.ts` (static data and sizing, no I/O beyond the existing fixed vm_stat/sysctl readers and statfs),
the roster projection in `src/core/nodes/view.ts`, and web-ui rows.

## Behaviour change if applied
For a node id with a declared profile (only `mbp8` today), not in `--light` mode:
- slots = min(2, pack-aware RAM slots); held when free RAM < 15%, swap > 2 GiB, or kernel pressure not normal.
- local-model caps (local, omlx, mlx, ollama, llama) are never advertised.
All other node ids and the light/muse path are unchanged.

## What it does not do
No new listener, no 0.0.0.0 bind, no tailscale serve/funnel, no new SSH path, no new remote exec,
no credential or keychain access, no new job types. Transport stays the existing `phm node pool` SSH aliases, tailnet only.

## Review points
1. The profile can only lower admission relative to `readNodeCapacity`, never raise it (min with nodeRamSlots).
2. `nodeProfile(config.node)` keys on the operator-chosen `--node` id, so a profile is opt-in at join time.
3. Go-live is blocked until Security signs off; the join itself needs Mason at the Mac (see BRIDGE_NOTES.md).
