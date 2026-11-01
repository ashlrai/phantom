# Unwired Fleet Modules

Modules in `src/core/fleet` that have **no non-test importer** as of 2026-10-31.

| Module | Purpose |
|--------|---------|
| `skill-routing-calibration-snapshot.ts` | Emits a tamper-evident snapshot (HMAC) of skill-routing calibration data, applying hard limits on skills, cases, sparse terms, vectors, and text size. Exports policy version `m453-token-counts-v1`. |
| `automerge-canary-ladder.ts` | State-machine ladder for canary enforcement (shadow → armed → enforce) with audit logging, guarded by two false compilation flags so `enforce` is unreachable and the default/pinned state is always `shadow`. |
| `one-ask-reward.ts` | Observation-only reward scorer for a single merge attempt: computes a per-token reward within a 72-hour observation window, returning scored or unknown states without routing or merge authority. Imported by `src/cli/reflect-attempt-reward.ts` and has no non-test importer. |
| `adapters/grok-peers.ts` | Locus CLI transport (`peers <op> --session-id <id> --client grok --json`) implementing the Locus peers contract for Grok clients. Reads no Grok files; validates session-id and caps inbox at 64 KiB. |
| `adapters/codex-peers.ts` | Locus CLI transport (`peers <op> --session-id <id> --client codex --json`) implementing the Locus peers contract for Codex clients. Reads no Codex files; validates session-id and caps inbox at 64 KiB. |
