# Router queue fixture

<!-- Synthetic line shapes from the task brief, not a copy of the live queue. -->
<!-- Preserve comments, blank lines, ordering, punctuation, and unknown fields. -->

- READY RQ-FIXTURE-READY (pool=codex-personal, tier=work, repo=phantom, EO 13:50): preserve `code`, commas, and colons: detail. EXTRA=keep-me
- CLAIMED RQ-FIXTURE-CLAIMED (pool=codex-personal, tier=work, repo=phantom): worker=fixture-worker; claimed=2026-10-26T13:00:00Z
- PR-OPEN RQ-FIXTURE-PR-OPEN (pool=codex-personal, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/123
- BLOCKED RQ-FIXTURE-BLOCKED (pool=codex-personal, tier=work, repo=phantom): depends=RQ-FIXTURE-READY; reason=waiting for prerequisite
- HOLD RQ-FIXTURE-HOLD (pool=codex-personal, tier=work, repo=phantom): reason=owner hold; READY in prose is not a status
- PROPOSED RQ-FIXTURE-PROPOSED (pool=codex-personal, tier=work, repo=phantom): awaiting admission
- SPLIT-PARENT RQ-FIXTURE-SPLIT-PARENT (pool=codex-personal, tier=work, repo=phantom): children=RQ-FIXTURE-READY,RQ-FIXTURE-BLOCKED
- LAND RQ-FIXTURE-LAND (pool=codex-personal, tier=work, repo=phantom): PR=https://github.com/ashlrai/phantom/pull/124 BASE_OVERRIDE=fixture-integration

Freeform operator note: READY and BASE_OVERRIDE here must survive round trips.
