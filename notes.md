# LAND-phantom-941 findings

PR https://github.com/ashlrai/phantom/pull/941 head 6dd08f447f4b89def8b33d504f07bf381b117c5d. Eight unresolved reviews: stale handoff, legacy activation shape, telemetry HTTPS, coordination compaction, packaged model catalog, pool load keys, subscription expiry, real-I/O lane registration.

Tier-1 restrictions prohibit manifest/build-config edits, test/config/**, activation-readiness-package test and routing/**. Seek compatible source fixes where possible; record genuine blocked work rather than weakening tests.

Latest default a6f3c323 merges cleanly: prospective tree 443371f811673b83c7fc810fd00df9db3f966490. No merge commit or protected upstream-path import created. CI run 40273303697 fails only source binding before tests (candidate tree differs original event merge tree); downstream jobs skipped. No local source change can establish hosted green without authorized later push.

Permitted fixes: compiled catalog defaults with source-drift test and default-only ENOENT fallback; shared PostHog HTTPS origin validation plus redirect refusal; operational status remains compatible, new snapshot explicit --coding; real process/FIFO tests execute in existing serialized gateway integration suite via helper.
