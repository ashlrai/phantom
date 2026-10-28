# Router queue

Section context: PHANTOM-DRIVER FLAGSHIP. dispatchd remains the fallback.
<!-- Preserve owner annotations and unknown parenthesized fields. -->
- DONE RQ-MEMORY (P0, pool=codex-personal, tier=frontier, repo=phantom, EO 13:45): Ship memory. Acceptance: durable storage; tests green.
- READY RQ-PHANTOM-DRIVER-1-QUEUE (P0 FLAGSHIP, pool=codex-personal, tier=frontier, repo=phantom, deps=RQ-MEMORY, EO 13:45): Own the queue (including claims). Acceptance: round-trip fixture; concurrent claims; validation.
- [HOLD] RQ-WAIT (priority=P1, pool=codex-personal, tier=frontier, repo=phantom): Wait for owner. Acceptance: approval recorded.
- **PROPOSED** **RQ-IDEA** (P2, pool=local, tier=local, repo=phantom): Evaluate a future task. Acceptance: evidence.
- CLAIMED RQ-LEGACY (P1, pool=codex-personal, tier=frontier, repo=phantom): Existing dispatchd claim. Acceptance: never dispatched twice.
- PR-OPEN RQ-REVIEW (P1, pool=codex-personal, tier=frontier, repo=phantom): Await review. Acceptance: protected merge.
- BLOCKED RQ-BLOCKED (P1, pool=codex-personal, tier=frontier, repo=phantom): Await prerequisite. Acceptance: unblock externally.

Unstructured notes remain byte-for-byte intact.
