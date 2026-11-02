# Router queue (scrubbed live snapshot)

Section context: PHANTOM-DRIVER FLAGSHIP. dispatchd remains the fallback.
<!-- Sanitized excerpt of the live queue; each observed line shape is represented. -->
<!-- Preserve owner annotations and unknown parenthesized fields. -->

## Active

- READY RQ-ALPHA (P0 FLAGSHIP, pool=codex-personal, tier=frontier, repo=phantom, deps=RQ-BETA|RQ-GAMMA, EO 13:45): Own the first slice. Acceptance: tests green.
- READY RQ-BETA (P0, pool=codex-cmp, tier=frontier, repo=phantom): Second slice, waits-for RQ-ALPHA review. Acceptance: merged.
- CLAIMED 14:26 dispatchd codex-personal RQ-GAMMA (P0, pool=codex-personal, tier=frontier, repo=phantom): In flight now. Acceptance: report filed.
- CLAIMED 15:02 worker-9 devin RQ-DELTA (P1, pool=devin, tier=frontier, repo=phantom): Driver lane work. Acceptance: bridge notes.
- PR-OPEN (https://github.com/ashlrai/phantom/pull/1001, bridge 12:23, EO 12:40) RQ-EPSILON (P1, pool=codex-personal, tier=frontier, repo=phantom): Awaiting review. Acceptance: two approvals.
- PR-OPEN RQ-ZETA (P1, pool=codex-personal, tier=frontier, repo=phantom): Review https://github.com/ashlrai/phantom/pull/1002 open. Acceptance: protected merge.
- BLOCKED 12:23 publish ABORT missing-env RQ-ETA (P0, pool=codex-personal, tier=frontier, repo=phantom): Publish aborted. Acceptance: env restored.
- BLOCKED RQ-THETA (P1, pool=codex-personal, tier=frontier, repo=phantom): depends=RQ-ALPHA; reason=waiting for prerequisite
- HOLD RQ-IOTA (P1, pool=codex-personal, tier=frontier, repo=phantom): reason=owner hold; READY in prose is not a status
- PROPOSED RQ-KAPPA (P2, pool=local, tier=local, repo=phantom): Candidate task. Acceptance: triage.
- **PROPOSED** **RQ-LAMBDA** (P2, pool=local, tier=local, repo=phantom): Bold decorated proposal. Acceptance: evidence.
- FIXUP RQ-MU (P0 DRIVER, pool=codex-cmp, tier=frontier, repo=phantom, EO 16:25): Fixup on branch codex-bridge/RQ-MU (PR #1003, review https://github.com/ashlrai/phantom/pull/1003). Acceptance: re-review green.
- LAND RQ-NU (P0, pool=codex-cmp, tier=frontier, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/1004 BASE_OVERRIDE=main
- SPLIT-PARENT RQ-XI (P0, pool=codex-cmp, tier=frontier, repo=phantom): children=RQ-OMICRON,RQ-PI Acceptance: all children landed.
- READY RQ-OMICRON (P1, pool=codex-cmp, tier=frontier, repo=phantom): after RQ-XI split. Acceptance: child slice done.
- READY RQ-PI (P1 (hot), pool=codex-cmp, tier=frontier, repo=phantom): Nested field group. Acceptance: ok.

## Done and archived

- DONE (https://github.com/ashlrai/phantom/pull/999, landed 09:12) RQ-RHO: Shipped earlier work. Acceptance: done.
- DONE RQ-SIGMA (P1, pool=codex-personal, tier=frontier, repo=phantom): Plain completion record.
- RETIRED RQ-TAU (P2, pool=local, tier=local, repo=phantom): Retired after scope change.
- DROPPED RQ-UPSILON (P2, pool=local, tier=local, repo=phantom): Dropped at intake.
- [HOLD] RQ-PHI (priority=P1, pool=codex-personal, tier=frontier, repo=phantom): Bracket status. Acceptance: approval recorded.

Unstructured notes remain byte-for-byte intact.
Freeform operator note: READY and BASE_OVERRIDE here must survive round trips.
