# RQ-SWE3-PRTRIAGE-1 — open-PR disposition sweep, `ashlrai/phantom`

**Date:** 2026-11-08 · **Base:** `master` @ `59bba0341` · **Scope:** all 236 open PRs
(45 merge cleanly but are behind base = GitHub "BEHIND"; 191 conflict = "DIRTY")

## Headline

| Class | Count | Meaning |
| --- | --- | --- |
| **a — auto-mergeable-once-behind-cleared** | 40 | clean merge vs master; just needs update-branch + checks |
| **b — needs-rebase** | 170 | conflicts with master; intent not landed |
| **c — superseded-by-merged-work** | 16 | intent/end-state already on master; close candidates |
| **d — needs-owner** | 10 | hold-list, drafts, dup mega-bundles, security-adjacent |

Dispositions are mechanical git evidence — merge state, patch-id equivalence,
per-file end-state comparison vs `origin/master`, and prior verified triage
verdicts. CI/check state is NOT evaluated (unauthenticated API cannot harvest
`mergeable_state` / check runs). "a" means mechanically clean; a closer must
still let required checks run.

## Machine-readable dispositions

```json
[
 {
  "pr": 878,
  "disposition": "needs-owner",
  "mergeState": "behind",
  "ahead": 2,
  "behind": 2619,
  "files": 1,
  "draft": false,
  "title": "docs: governed-client gateway opt-in design note",
  "evidence": "on Mason hold list (AGENTS.md)"
 },
 {
  "pr": 915,
  "disposition": "needs-owner",
  "mergeState": "behind",
  "ahead": 161,
  "behind": 326,
  "files": 7,
  "draft": false,
  "title": "feat(custody): carry spawn custody into receipt secrets.wrap; hold needs-secrets tasks that would run unwrapped",
  "evidence": "touches .github/CODEOWNERS + tier1-closure.json + custody secrets.wrap \u2014 Security-gate-adjacent"
 },
 {
  "pr": 924,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 8,
  "behind": 2572,
  "files": 6,
  "draft": false,
  "title": "ci: Windows portability and macOS isolated/shared legs only on platform PRs or ci:full-os",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 927,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2572,
  "files": 12,
  "draft": false,
  "title": "Add an offline eval for local versus frontier routing",
  "evidence": "rework merged as #2834 (74fec5cf9) (verified on master)"
 },
 {
  "pr": 929,
  "disposition": "needs-owner",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2385,
  "files": 11,
  "draft": true,
  "title": "fix(cli): keep headless plugins enable from prompting",
  "evidence": "draft PR; draft; open recut #1509 (RQ-DRAIN-PHANTOM-929) exists"
 },
 {
  "pr": 932,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 4,
  "behind": 2385,
  "files": 13,
  "draft": true,
  "title": "ci: CodeQL, Scorecard, Renovate, and Codecov",
  "evidence": "rework merged as #1498 (e9784d15e) (verified on master)"
 },
 {
  "pr": 935,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2572,
  "files": 20,
  "draft": false,
  "title": "Add coding CLI adapters and draft-PR worker plans",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 948,
  "disposition": "needs-owner",
  "mergeState": "conflict",
  "ahead": 8,
  "behind": 2570,
  "files": 80,
  "draft": false,
  "title": "bridge: RQ-FLEET-1-v2",
  "evidence": "RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race \u2014 human call"
 },
 {
  "pr": 949,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 176,
  "behind": 326,
  "files": 2,
  "draft": false,
  "title": "bridge: RQ-INT-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 950,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 4,
  "behind": 2558,
  "files": 10,
  "draft": false,
  "title": "feat(web-ui): live queue station graph behind agentWorkspace (RQ-QUEUE-5)",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 966,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 186,
  "behind": 326,
  "files": 14,
  "draft": false,
  "title": "bridge: RQ-DESKTOP-REPLAY-r2",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 970,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 7,
  "behind": 2558,
  "files": 12,
  "draft": false,
  "title": "bridge: RQ-LAUNCH-LOCK",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 976,
  "disposition": "needs-owner",
  "mergeState": "conflict",
  "ahead": 9,
  "behind": 2568,
  "files": 81,
  "draft": false,
  "title": "bridge: LAND-phantom-941",
  "evidence": "RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race \u2014 human call"
 },
 {
  "pr": 1013,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2560,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-CYCLE-1-r3",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 1022,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2560,
  "files": 10,
  "draft": false,
  "title": "bridge: RQ-BUS-1C",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 1044,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2560,
  "files": 11,
  "draft": false,
  "title": "bridge: RQ-FRESH-DOCS-DRIFT",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1045,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2560,
  "files": 15,
  "draft": false,
  "title": "bridge: RQ-METRICS-IMPACT-SCORE",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1047,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2560,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-PARITY-GROK-DEVIN-PEERS",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 1048,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2560,
  "files": 21,
  "draft": false,
  "title": "bridge: RQ-QUEUE-5",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 1050,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2560,
  "files": 11,
  "draft": false,
  "title": "bridge: RQ-DOCTOR-FAST",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 1058,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2558,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-METRICS-PROD-SHARE",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1064,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 3,
  "behind": 2385,
  "files": 1,
  "draft": false,
  "title": "ci(ecosystem-stats): match the data branch ref exactly",
  "evidence": "merge-tree clean vs master; only behind; mutual duplicate intent with open #1234 (both edit .github/workflows/ecosystem-stats.yml ls-remote line)"
 },
 {
  "pr": 1072,
  "disposition": "needs-owner",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2566,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-PL-FRESH-ECO-CL-JSON",
  "evidence": "RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race \u2014 human call"
 },
 {
  "pr": 1099,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2554,
  "files": 12,
  "draft": false,
  "title": "bridge: RQ-GROKBOT-OFFLOAD",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1111,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2541,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-METRICS-DASH-FEED",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1123,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2554,
  "files": 14,
  "draft": false,
  "title": "bridge: RQ-PHM-CONNECT-WIZARD",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1128,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 4,
  "behind": 2572,
  "files": 9,
  "draft": false,
  "title": "ci: diet step 1, draft-defer custody macOS, scope dependency audit to dependency changes",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 1135,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2552,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-BUS-GROKBOT-R",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1136,
  "disposition": "needs-owner",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2552,
  "files": 28,
  "draft": false,
  "title": "bridge: RQ-AUTO-LOCAL-1e",
  "evidence": "RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race \u2014 human call"
 },
 {
  "pr": 1149,
  "disposition": "needs-owner",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2552,
  "files": 18,
  "draft": false,
  "title": "bridge: RQ-DV-SPLIT-FLEET-STATUS",
  "evidence": "RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race \u2014 human call"
 },
 {
  "pr": 1156,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 2552,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-MEM-RECLAIM",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1161,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2550,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-N26-CON-RULES-LINT",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1166,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2550,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-N26-PH-DISPATCH-EVENTS-PARSER",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1175,
  "disposition": "needs-owner",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2550,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-OT-P3-HANDOFF-SCHEMA",
  "evidence": "RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race \u2014 human call"
 },
 {
  "pr": 1185,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2550,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-RESEARCH-ROUTING-RL",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1222,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 5,
  "behind": 2572,
  "files": 13,
  "draft": false,
  "title": "bridge: THROUGHPUT-PHANTOM-PATHS",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 1223,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 5,
  "behind": 2572,
  "files": 15,
  "draft": false,
  "title": "bridge: RQ-FAST-GATE-PHANTOM",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 1234,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 219,
  "behind": 326,
  "files": 1,
  "draft": false,
  "title": "ecosystem-stats: match refs/heads/ecosystem-stats exactly (G1, +1/-1)",
  "evidence": "merge-tree clean vs master; only behind; mutual duplicate intent with open #1064 (both edit .github/workflows/ecosystem-stats.yml ls-remote line)"
 },
 {
  "pr": 1252,
  "disposition": "superseded-by-merged-work",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2572,
  "files": 1,
  "draft": false,
  "title": "bridge: DESKTOP-PHANTOM",
  "evidence": "RQ-SWE3-STALEPR-1: intent landed on master"
 },
 {
  "pr": 1260,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2572,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-IDEA-2026102703-1",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1261,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2572,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-IDEA-2026102704-1",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1267,
  "disposition": "needs-owner",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2572,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-ONEASK-2-INTAKE",
  "evidence": "RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race \u2014 human call"
 },
 {
  "pr": 1271,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2572,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-PH-CLI-COLDSTART",
  "evidence": "RQ-SWE3-STALEPR-1: still-unique"
 },
 {
  "pr": 1503,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2317,
  "files": 47,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PHANTOM-933",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1504,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 10,
  "draft": false,
  "title": "bridge: RQ-DRAINPH1041Q7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1507,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-DRAINPH1110Q7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1509,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2325,
  "files": 207,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PHANTOM-929",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1517,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-DRAINPH1254Q7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1552,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2314,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-DRAINRECUTQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1554,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-DRAINPH974Q7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1563,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-MERGEAUTOPILOTQ7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1564,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-JOBREPLAYQ7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1565,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2314,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-MERGEDRAINQ9Q8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1674,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-ONB-CONNECT-E2E",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1678,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2354,
  "files": 10,
  "draft": false,
  "title": "bridge: RQ-ONB-3-KEYS-CUSTODY",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1679,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-PARITYROUTERTASKQ7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1680,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2309,
  "files": 45,
  "draft": false,
  "title": "bridge: RQ-PHDEADCODEQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1685,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2314,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-PHDESKQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1690,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 21,
  "draft": false,
  "title": "bridge: RQ-PLAN-ECOCL-B",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1692,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 12,
  "draft": false,
  "title": "bridge: RQ-PLANROUTERTASKBQ7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1698,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-RADAR-COST-CACHE-SPLIT",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1700,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2315,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-RECUT29Q8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1702,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2325,
  "files": 14,
  "draft": false,
  "title": "bridge: RQ-RADARCCUNATTENDEDQ7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1728,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 15,
  "draft": false,
  "title": "bridge: RQ-REFILL-2026102703-LAND-001-RECUT",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1734,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2315,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-ROUTINEGROKQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1735,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2315,
  "files": 12,
  "draft": false,
  "title": "bridge: RQ-ROUTINEBALANCERQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1736,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2315,
  "files": 15,
  "draft": false,
  "title": "bridge: RQ-ROUTINELOCALQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 1737,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2385,
  "files": 30,
  "draft": false,
  "title": "bridge: RQ-SELFOPT-PROMPT-OPT",
  "evidence": "conflicts with master; no merged-work supersession found; 22/30 touched files already match master; PR includes stray ~/.npm/_update-notifier-last-checked junk file"
 },
 {
  "pr": 1745,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 2081,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-TEAMINVITEQ7",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2754,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 5,
  "behind": 1099,
  "files": 14,
  "draft": false,
  "title": "Run hosted test CI once a day",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2774,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1101,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-PHX-SAFARIIMPORTVERB01",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2786,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 1078,
  "files": 45,
  "draft": false,
  "title": "Add a fleet forum for agent coordination",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2788,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 55,
  "behind": 834,
  "files": 18,
  "draft": false,
  "title": "Add a calm fleet mission briefing",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2831,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1105,
  "files": 17,
  "draft": false,
  "title": "bridge: RQ-DRAIN-phantom-1019",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2837,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1063,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-GUARDIANHEADQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2842,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 2309,
  "files": 179,
  "draft": false,
  "title": "bridge: RQ-DRAIN-phantom-1110",
  "evidence": "conflicts with master; no merged-work supersession found; 99/177 touched files match master (DRAIN recut of merged #1110 line); residual differs"
 },
 {
  "pr": 2850,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1078,
  "files": 11,
  "draft": false,
  "title": "bridge: RQ-NODE-1-JOIN",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2880,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 1015,
  "files": 20,
  "draft": false,
  "title": "bridge: RQ-NODE-4-VIEW",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2884,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1020,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-APPSTEER-8-STEERINPUT",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2888,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1020,
  "files": 15,
  "draft": false,
  "title": "bridge: RQ-APPCTL-7-AGENTCONTROL",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2895,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1024,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-APPCARDS-5-PROVIDERCARDS",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2900,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1013,
  "files": 18,
  "draft": false,
  "title": "bridge: RQ-APPCOST-11-JOBBREAKDOWN",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2901,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1028,
  "files": 18,
  "draft": false,
  "title": "bridge: RQ-NODE-6-TENANCY",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2906,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1020,
  "files": 34,
  "draft": false,
  "title": "bridge: FIXUP-MAIN-phantom-7b1d602",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2910,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1008,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-CTXPACK-1-BUILD",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2912,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1003,
  "files": 55,
  "draft": false,
  "title": "bridge: RQ-PHX-CHANGELOGFRAGMENTS02",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2915,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 995,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-PHX-SELFTICKCHECK02SOLC2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2923,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 90,
  "behind": 678,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-PHX-MCPSELFTICKLAST02",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2928,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 991,
  "files": 24,
  "draft": false,
  "title": "bridge: RQ-PHX-SELFLOOPSTOPFILE02SOLD2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2936,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 1003,
  "files": 33,
  "draft": false,
  "title": "bridge: FIXUP-MAIN-phantom-7b1d602-r2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2943,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 982,
  "files": 60,
  "draft": false,
  "title": "bridge: RQ-PHX-SELFTICKCLAUDEQUOTA02",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2960,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 969,
  "files": 35,
  "draft": false,
  "title": "bridge: FIXUP-MAIN-phantom-ed25043",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2966,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 949,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-PHX-SELFLOOPBUSPROGRESS02SOLJ1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 2983,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 932,
  "files": 10,
  "draft": false,
  "title": "bridge: RQ-PACE-TO-RESET",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3057,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 871,
  "files": 17,
  "draft": false,
  "title": "bridge: RQ-BUS-NEUTRAL-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3062,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 862,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-DISPATCH-LIVEPARITY",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3146,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 778,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-LAT-FIX4-EMPTYGATEQ9R2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3150,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 778,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-OMLX-LANE",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3151,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 777,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-APPDRIVE-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3154,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 20,
  "behind": 723,
  "files": 71,
  "draft": false,
  "title": "bridge: RQ-APPTRUTH-6-SOURCEOFTRUTHR2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3158,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 46,
  "behind": 327,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-PHX-APPSCHANGESBUS03SONV1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3162,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 779,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-PHX-MCPAPPSWATCH03SONT1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3163,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 47,
  "behind": 327,
  "files": 2,
  "draft": false,
  "title": "bridge: RQ-PHX-APPSWATCHATTEMPT03SONZ1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3169,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 52,
  "behind": 327,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-MERGERECOVERQ8",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3176,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 51,
  "behind": 327,
  "files": 2,
  "draft": false,
  "title": "bridge: RQ-PHX-RECOVERYHISTORYAPI03SOOL1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3193,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 59,
  "behind": 327,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-PHX-APPSCARDRECOVERY03",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3206,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 61,
  "behind": 327,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-PHX-DOCTORLIVE03",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3230,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 42,
  "behind": 449,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-QUEUELINTQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3231,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 59,
  "behind": 327,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-PHX-MCPFLEETNEEDS03",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3235,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 715,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-PHX-NEEDSREPLYRETRY03SOPD2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3237,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 65,
  "behind": 327,
  "files": 2,
  "draft": false,
  "title": "bridge: RQ-PHX-MCPNEEDS03SOPD1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3239,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 41,
  "behind": 495,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-PHX-MCPFLEETDOCTOR03",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3249,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 66,
  "behind": 327,
  "files": 2,
  "draft": false,
  "title": "bridge: RQ-PHX-MCPNEEDSWAIT03SOPF2",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3250,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 69,
  "behind": 327,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-RESOURCES-1-FEED",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3288,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 20,
  "behind": 612,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-CI-DAILYFULL-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3294,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 670,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-APP-CD-2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3297,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 89,
  "behind": 302,
  "files": 12,
  "draft": false,
  "title": "bridge: RQ-PHX-SESSIONINTERJECT-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3306,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 57,
  "behind": 495,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-PHX-MCPFLEETVERBS04",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3326,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 635,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-AGL-MEM-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3357,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 607,
  "files": 69,
  "draft": false,
  "title": "bridge: RQ-TIER1-APPS-CUT-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3359,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 2,
  "behind": 607,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-PHX-STATUSQUOTALINES06",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3363,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 605,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-PHX-BATCHDRAFTIDENTITY04SPG2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3373,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 35,
  "behind": 448,
  "files": 2,
  "draft": false,
  "title": "bridge: RQ-PHX-UPDATESMOKEGATE04",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3386,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 67,
  "behind": 311,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-PHX-STUCKFIXROUTE04",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3391,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 577,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-PHX-PLANNERWRITEBUDGET08",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3396,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 62,
  "behind": 321,
  "files": 16,
  "draft": false,
  "title": "bridge: RQ-PHX-SELFTICKINCIDENTS08",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3401,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 61,
  "behind": 311,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-PHX-LIVESLOWPRS09",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3464,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 46,
  "behind": 312,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-PHX-RESETCLAUDEPROBE04",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3465,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 5,
  "behind": 504,
  "files": 12,
  "draft": false,
  "title": "bridge: RQ-AGL-CKPT-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3489,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 506,
  "files": 43,
  "draft": false,
  "title": "bridge: RQ-LAT-FIX4-EMPTYGATEQ9R3",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3509,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 3,
  "behind": 473,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-PHX-COSLOOPVERB12",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3510,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 487,
  "files": 19,
  "draft": false,
  "title": "bridge: RQ-PHX-COSSELFTICKSTEP14",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3511,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 2,
  "behind": 473,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-AGENTPROFILE-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3514,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 482,
  "files": 16,
  "draft": false,
  "title": "bridge: RQ-PHX-COSDECLINE13",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3517,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 478,
  "files": 12,
  "draft": false,
  "title": "bridge: RQ-SELFPUBLISH-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3519,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 494,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-FRICTION-3-PLANNER",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3525,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 474,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-PHX-MCPCURRENTSNAPSHOT04SQC1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3529,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 473,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-PHX-PHONECOSASK17",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3530,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 471,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-PHX-MCPPATHCOCHANGES04SQD1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3536,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 464,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-LAUNCHWAITQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3539,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 464,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-PHX-LANEMODELDRIFT18",
  "evidence": "conflicts with master; no merged-work supersession found; 4/5 match master; residual fleet-subcommand-registry differs"
 },
 {
  "pr": 3548,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 474,
  "files": 10,
  "draft": false,
  "title": "bridge: RQ-PHX-APPUPDATEDESKTOP16",
  "evidence": "conflicts with master; no merged-work supersession found; 7/10 match master; residual verse-api/workbench-types differ"
 },
 {
  "pr": 3557,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 28,
  "behind": 344,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-PROFILERECUTQ8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3599,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 424,
  "files": 64,
  "draft": false,
  "title": "bridge: RQ-PHX-OUTCOMEWHYVERB24",
  "evidence": "conflicts with master; no merged-work supersession found; 46/64 touched files match master; residual outcome-why module differs"
 },
 {
  "pr": 3608,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 22,
  "behind": 344,
  "files": 15,
  "draft": false,
  "title": "bridge: RQ-PROFILERECUT2Q8",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3640,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 23,
  "behind": 312,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-PHX-RELEASEGATESTART05SRQ2",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3705,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 324,
  "files": 54,
  "draft": false,
  "title": "bridge: RQ-RECUT-MR-CONFLICT-DRIVERS-phantom-NOV5",
  "evidence": "conflicts with master; no merged-work supersession found; 33/54 files landed via -R2 recut #3708 (463034051); residual iMessage teammate module + release-fast-smoke unlanded"
 },
 {
  "pr": 3711,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 317,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-PHX-RECONCILESTUCK05STE1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3716,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 315,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-PHX-RECONCILESCANBUDGET05STF2",
  "evidence": "conflicts with master; no merged-work supersession found; 3/4 match master; residual budget-reconcile test differs"
 },
 {
  "pr": 3718,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 322,
  "files": 15,
  "draft": false,
  "title": "bridge: RQ-V330-CIFIX-20R2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3822,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 292,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-RECUTLOOPQ8",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3825,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 260,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-UPKEEP-DOCS-phantom-20261106",
  "evidence": "conflicts with master; no merged-work supersession found; newer upkeep runs landed (#3948 Nov-07, #4097 Nov-08) on different files; Nov-06 docs delta still unique"
 },
 {
  "pr": 3868,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 560,
  "files": 14,
  "draft": false,
  "title": "bridge: RQ-COS-PAGES-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3878,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 147,
  "files": 23,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-009",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3879,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 147,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-006",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3880,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 147,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-012",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3881,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 147,
  "files": 12,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-011",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3882,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 147,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-013",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3888,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 2,
  "behind": 5,
  "files": 13,
  "draft": false,
  "title": "chore(master): release 3.30.26",
  "evidence": "merge-tree clean vs master; only behind; release-please PR; master still at 3.30.25 \u2014 pending release"
 },
 {
  "pr": 3889,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 148,
  "files": 23,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-000",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3896,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 144,
  "files": 42,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-033",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3899,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 141,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-041",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3902,
  "disposition": "superseded-by-merged-work",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 139,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-045",
  "evidence": "PR end-state / all patches already on master"
 },
 {
  "pr": 3905,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 141,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-035",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3906,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 139,
  "files": 10,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-044",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3913,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 130,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-SWE-MERGECOCK-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3917,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 126,
  "files": 15,
  "draft": false,
  "title": "bridge: RQ-CIFIX-PH-01",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3918,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 150,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-SWE-SESSVIEW-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3919,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 150,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-SWE-TUI-SESSIONS-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3920,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 144,
  "files": 23,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-030",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3922,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 147,
  "files": 104,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-010",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3924,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 122,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-SWE-EVALS-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3925,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 122,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-SWE-PRQUEUE-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3926,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 122,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-CIFIX-PH-17",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3927,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 122,
  "files": 3,
  "draft": false,
  "title": "bridge: RQ-SWE-RELEASEAUTO-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3935,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 120,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-SWE-CHAINVERIFY-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3941,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 123,
  "files": 5,
  "draft": false,
  "title": "bridge: RQ-SWE-LOCALTOOLUSE-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3942,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 145,
  "files": 48,
  "draft": false,
  "title": "bridge: RQ-DRAIN-PH-021",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3943,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 150,
  "files": 14,
  "draft": false,
  "title": "bridge: RQ-SWE-APPROVALS-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3947,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 116,
  "files": 10,
  "draft": false,
  "title": "bridge: RQ-SWE-BUSPROTOCOL-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3955,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 28,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-21",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3961,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 100,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-37",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3969,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 12,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-12",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3970,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 25,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-06",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3972,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-14",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3979,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 14,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-13",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3984,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 22,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-19",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3986,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 86,
  "files": 6,
  "draft": false,
  "title": "bridge: RQ-SWE2-SELFIMPROVE-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 3989,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 52,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-02",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3991,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 172,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-00",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3992,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 34,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-07",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3993,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 86,
  "files": 16,
  "draft": false,
  "title": "bridge: RQ-SWE2-DOCSLIVING-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 3996,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 56,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-08",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4003,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 87,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-15",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4005,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 73,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-SWE3-OBSERVABILITY-2",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4008,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 24,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-09",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4009,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 100,
  "files": 201,
  "draft": false,
  "title": "bridge: RQ-DRAIN2-PH-01",
  "evidence": "conflicts with master; no merged-work supersession found; 140/199 touched files match master; residual pages/cockpit files differ"
 },
 {
  "pr": 4010,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 68,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-SWE3-DOTFEED-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4017,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 59,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-06",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4023,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 59,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-17",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4027,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 58,
  "files": 37,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-28",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4028,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 58,
  "files": 9,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-33",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4030,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 19,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-15",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4031,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 58,
  "files": 21,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-34",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4033,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 53,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-36",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4036,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 51,
  "files": 27,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-39",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4038,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 30,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-13",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4042,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 24,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-11",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4045,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 77,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-04",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4046,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 58,
  "files": 14,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-31",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4047,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 59,
  "files": 18,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-10",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4048,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 94,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-02",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4049,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 48,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-14",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4050,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 40,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-05",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4051,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 140,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-03",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4052,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 58,
  "files": 61,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-32",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4053,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 61,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-12",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4054,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 200,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-00",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4055,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 59,
  "files": 319,
  "draft": false,
  "title": "bridge: RQ-REBASE-PH-01",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4059,
  "disposition": "superseded-by-merged-work",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 36,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-SWE3-DOTFEED-TTL-1",
  "evidence": "PR end-state / all patches already on master"
 },
 {
  "pr": 4063,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 36,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-SWE3-ATTEMPT-RACE-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4064,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 36,
  "files": 103,
  "draft": false,
  "title": "bridge: RQ-REBASE2-PH-00",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4065,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 36,
  "files": 14,
  "draft": false,
  "title": "bridge: RQ-SWE3-VISION5-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4068,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 32,
  "files": 7,
  "draft": false,
  "title": "bridge: RQ-SWE3-CONFLICPRED-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4070,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 32,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-SWE3-LEADERLOOP-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4071,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 32,
  "files": 8,
  "draft": false,
  "title": "bridge: RQ-SWE3-AUTOPILOT-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4073,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 32,
  "files": 10,
  "draft": false,
  "title": "bridge: RQ-SWE3-IMSGDEEP-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4078,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 36,
  "files": 310,
  "draft": false,
  "title": "bridge: RQ-REBASE2-PH-01",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4079,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 32,
  "files": 16,
  "draft": false,
  "title": "bridge: RQ-SWE3-REBASEORDER-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4081,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 28,
  "files": 14,
  "draft": false,
  "title": "bridge: RQ-SWE3-MERGEBATCH-WIRE-1",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4082,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 36,
  "files": 401,
  "draft": false,
  "title": "bridge: RQ-REBASE2-PH-02",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4083,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 28,
  "files": 13,
  "draft": false,
  "title": "bridge: RQ-SWE3-RESBAR-VERIFY-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4084,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 28,
  "files": 22,
  "draft": false,
  "title": "bridge: RQ-SWE3-BOARDUI-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4088,
  "disposition": "needs-rebase",
  "mergeState": "conflict",
  "ahead": 1,
  "behind": 22,
  "files": 7,
  "draft": false,
  "title": "bridge: FIXUP-CI-phantom-ci-155790",
  "evidence": "conflicts with master; no merged-work supersession found"
 },
 {
  "pr": 4107,
  "disposition": "auto-mergeable-once-behind-cleared",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 3,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-SWE3-RESBAR-FIX-1",
  "evidence": "merge-tree clean vs master; only behind"
 },
 {
  "pr": 4109,
  "disposition": "superseded-by-merged-work",
  "mergeState": "behind",
  "ahead": 1,
  "behind": 1,
  "files": 4,
  "draft": false,
  "title": "bridge: RQ-PARKWAKEQ8",
  "evidence": "PR end-state / all patches already on master; merge commit 26d1e88ec references (#4109) \u2014 merged-but-open"
 }
]
```

## a — auto-mergeable-once-behind-cleared (40)

All merge cleanly onto `master@59bba0341` (`git merge-tree --write-tree` exit 0).
None are ancestors of master; none patch-equivalent to landed work.

| PR | Title | Behind | Files | Evidence |
| --- | --- | --- | --- | --- |
| #949 | bridge: RQ-INT-1 | 326 | 2 | merge-tree clean vs master; only behind |
| #966 | bridge: RQ-DESKTOP-REPLAY-r2 | 326 | 14 | merge-tree clean vs master; only behind |
| #1064 | ci(ecosystem-stats): match the data branch ref exactly | 2385 | 1 | merge-tree clean vs master; only behind; mutual duplicate intent with open #1234 (both edit .github/workflows/ecosystem-stats.yml ls-remote line) |
| #1234 | ecosystem-stats: match refs/heads/ecosystem-stats exactly (G | 326 | 1 | merge-tree clean vs master; only behind; mutual duplicate intent with open #1064 (both edit .github/workflows/ecosystem-stats.yml ls-remote line) |
| #3163 | bridge: RQ-PHX-APPSWATCHATTEMPT03SONZ1 | 327 | 2 | merge-tree clean vs master; only behind |
| #3169 | bridge: RQ-MERGERECOVERQ8 | 327 | 3 | merge-tree clean vs master; only behind |
| #3176 | bridge: RQ-PHX-RECOVERYHISTORYAPI03SOOL1 | 327 | 2 | merge-tree clean vs master; only behind |
| #3193 | bridge: RQ-PHX-APPSCARDRECOVERY03 | 327 | 6 | merge-tree clean vs master; only behind |
| #3231 | bridge: RQ-PHX-MCPFLEETNEEDS03 | 327 | 3 | merge-tree clean vs master; only behind |
| #3237 | bridge: RQ-PHX-MCPNEEDS03SOPD1 | 327 | 2 | merge-tree clean vs master; only behind |
| #3249 | bridge: RQ-PHX-MCPNEEDSWAIT03SOPF2 | 327 | 2 | merge-tree clean vs master; only behind |
| #3250 | bridge: RQ-RESOURCES-1-FEED | 327 | 6 | merge-tree clean vs master; only behind |
| #3297 | bridge: RQ-PHX-SESSIONINTERJECT-1 | 302 | 12 | merge-tree clean vs master; only behind |
| #3359 | bridge: RQ-PHX-STATUSQUOTALINES06 | 607 | 4 | merge-tree clean vs master; only behind |
| #3386 | bridge: RQ-PHX-STUCKFIXROUTE04 | 311 | 4 | merge-tree clean vs master; only behind |
| #3401 | bridge: RQ-PHX-LIVESLOWPRS09 | 311 | 8 | merge-tree clean vs master; only behind |
| #3464 | bridge: RQ-PHX-RESETCLAUDEPROBE04 | 312 | 4 | merge-tree clean vs master; only behind |
| #3640 | bridge: RQ-PHX-RELEASEGATESTART05SRQ2 | 312 | 3 | merge-tree clean vs master; only behind |
| #3711 | bridge: RQ-PHX-RECONCILESTUCK05STE1 | 317 | 5 | merge-tree clean vs master; only behind |
| #3822 | bridge: RQ-RECUTLOOPQ8 | 292 | 4 | merge-tree clean vs master; only behind |
| #3880 | bridge: RQ-DRAIN-PH-012 | 147 | 6 | merge-tree clean vs master; only behind |
| #3888 | chore(master): release 3.30.26 | 5 | 13 | merge-tree clean vs master; only behind; release-please PR; master still at 3.30.25 — pending release |
| #3899 | bridge: RQ-DRAIN-PH-041 | 141 | 6 | merge-tree clean vs master; only behind |
| #3905 | bridge: RQ-DRAIN-PH-035 | 141 | 6 | merge-tree clean vs master; only behind |
| #3919 | bridge: RQ-SWE-TUI-SESSIONS-1 | 150 | 9 | merge-tree clean vs master; only behind |
| #3926 | bridge: RQ-CIFIX-PH-17 | 122 | 6 | merge-tree clean vs master; only behind |
| #3927 | bridge: RQ-SWE-RELEASEAUTO-1 | 122 | 3 | merge-tree clean vs master; only behind |
| #3935 | bridge: RQ-SWE-CHAINVERIFY-1 | 120 | 8 | merge-tree clean vs master; only behind |
| #3961 | bridge: RQ-DRAIN2-PH-37 | 100 | 7 | merge-tree clean vs master; only behind |
| #3986 | bridge: RQ-SWE2-SELFIMPROVE-1 | 86 | 6 | merge-tree clean vs master; only behind |
| #4017 | bridge: RQ-REBASE-PH-06 | 59 | 8 | merge-tree clean vs master; only behind |
| #4023 | bridge: RQ-REBASE-PH-17 | 59 | 8 | merge-tree clean vs master; only behind |
| #4036 | bridge: RQ-REBASE-PH-39 | 51 | 27 | merge-tree clean vs master; only behind |
| #4046 | bridge: RQ-REBASE-PH-31 | 58 | 14 | merge-tree clean vs master; only behind |
| #4047 | bridge: RQ-REBASE-PH-10 | 59 | 18 | merge-tree clean vs master; only behind |
| #4063 | bridge: RQ-SWE3-ATTEMPT-RACE-1 | 36 | 7 | merge-tree clean vs master; only behind |
| #4068 | bridge: RQ-SWE3-CONFLICPRED-1 | 32 | 7 | merge-tree clean vs master; only behind |
| #4083 | bridge: RQ-SWE3-RESBAR-VERIFY-1 | 28 | 13 | merge-tree clean vs master; only behind |
| #4084 | bridge: RQ-SWE3-BOARDUI-1 | 28 | 22 | merge-tree clean vs master; only behind |
| #4107 | bridge: RQ-SWE3-RESBAR-FIX-1 | 3 | 4 | merge-tree clean vs master; only behind |

## b — needs-rebase (170)

All conflict with master (`merge-tree` exit 1); no merged work covers their
intent. `filesSameAsMaster` in the JSON shows partially-landed overlap where
a prior sweep already ported most of the payload — rebase only the residual.

| PR | Title | Behind | Files | Files-same-as-master | Evidence |
| --- | --- | --- | --- | --- | --- |
| #935 | Add coding CLI adapters and draft-PR worker plans | 2572 | 20 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #950 | feat(web-ui): live queue station graph behind agentWork | 2558 | 10 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1044 | bridge: RQ-FRESH-DOCS-DRIFT | 2560 | 11 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1045 | bridge: RQ-METRICS-IMPACT-SCORE | 2560 | 15 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1058 | bridge: RQ-METRICS-PROD-SHARE | 2558 | 8 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1099 | bridge: RQ-GROKBOT-OFFLOAD | 2554 | 12 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1111 | bridge: RQ-METRICS-DASH-FEED | 2541 | 5 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1123 | bridge: RQ-PHM-CONNECT-WIZARD | 2554 | 14 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1135 | bridge: RQ-BUS-GROKBOT-R | 2552 | 3 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1156 | bridge: RQ-MEM-RECLAIM | 2552 | 9 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1161 | bridge: RQ-N26-CON-RULES-LINT | 2550 | 6 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1166 | bridge: RQ-N26-PH-DISPATCH-EVENTS-PARSER | 2550 | 6 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1185 | bridge: RQ-RESEARCH-ROUTING-RL | 2550 | 4 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1260 | bridge: RQ-IDEA-2026102703-1 | 2572 | 5 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1261 | bridge: RQ-IDEA-2026102704-1 | 2572 | 5 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1271 | bridge: RQ-PH-CLI-COLDSTART | 2572 | 7 | 0 | RQ-SWE3-STALEPR-1: still-unique |
| #1503 | bridge: RQ-DRAIN-PHANTOM-933 | 2317 | 47 | 1 | conflicts with master; no merged-work supersession found |
| #1504 | bridge: RQ-DRAINPH1041Q7 | 2385 | 10 | 0 | conflicts with master; no merged-work supersession found |
| #1507 | bridge: RQ-DRAINPH1110Q7 | 2385 | 7 | 0 | conflicts with master; no merged-work supersession found |
| #1509 | bridge: RQ-DRAIN-PHANTOM-929 | 2325 | 207 | 0 | conflicts with master; no merged-work supersession found |
| #1517 | bridge: RQ-DRAINPH1254Q7 | 2385 | 8 | 0 | conflicts with master; no merged-work supersession found |
| #1552 | bridge: RQ-DRAINRECUTQ8 | 2314 | 8 | 0 | conflicts with master; no merged-work supersession found |
| #1554 | bridge: RQ-DRAINPH974Q7 | 2385 | 8 | 0 | conflicts with master; no merged-work supersession found |
| #1563 | bridge: RQ-MERGEAUTOPILOTQ7 | 2385 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #1564 | bridge: RQ-JOBREPLAYQ7 | 2385 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #1565 | bridge: RQ-MERGEDRAINQ9Q8 | 2314 | 6 | 1 | conflicts with master; no merged-work supersession found |
| #1674 | bridge: RQ-ONB-CONNECT-E2E | 2385 | 3 | 0 | conflicts with master; no merged-work supersession found |
| #1678 | bridge: RQ-ONB-3-KEYS-CUSTODY | 2354 | 10 | 0 | conflicts with master; no merged-work supersession found |
| #1679 | bridge: RQ-PARITYROUTERTASKQ7 | 2385 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #1680 | bridge: RQ-PHDEADCODEQ8 | 2309 | 45 | 0 | conflicts with master; no merged-work supersession found |
| #1685 | bridge: RQ-PHDESKQ8 | 2314 | 6 | 0 | conflicts with master; no merged-work supersession found |
| #1690 | bridge: RQ-PLAN-ECOCL-B | 2385 | 21 | 0 | conflicts with master; no merged-work supersession found |
| #1692 | bridge: RQ-PLANROUTERTASKBQ7 | 2385 | 12 | 0 | conflicts with master; no merged-work supersession found |
| #1698 | bridge: RQ-RADAR-COST-CACHE-SPLIT | 2385 | 8 | 0 | conflicts with master; no merged-work supersession found |
| #1700 | bridge: RQ-RECUT29Q8 | 2315 | 5 | 0 | conflicts with master; no merged-work supersession found |
| #1702 | bridge: RQ-RADARCCUNATTENDEDQ7 | 2325 | 14 | 0 | conflicts with master; no merged-work supersession found |
| #1728 | bridge: RQ-REFILL-2026102703-LAND-001-RECUT | 2385 | 15 | 0 | conflicts with master; no merged-work supersession found |
| #1734 | bridge: RQ-ROUTINEGROKQ8 | 2315 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #1735 | bridge: RQ-ROUTINEBALANCERQ8 | 2315 | 12 | 0 | conflicts with master; no merged-work supersession found |
| #1736 | bridge: RQ-ROUTINELOCALQ8 | 2315 | 15 | 1 | conflicts with master; no merged-work supersession found |
| #1737 | bridge: RQ-SELFOPT-PROMPT-OPT | 2385 | 30 | 22 | conflicts with master; no merged-work supersession found; 22/30 touched files already match master; PR include |
| #1745 | bridge: RQ-TEAMINVITEQ7 | 2081 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #2754 | Run hosted test CI once a day | 1099 | 14 | 0 | conflicts with master; no merged-work supersession found |
| #2774 | bridge: RQ-PHX-SAFARIIMPORTVERB01 | 1101 | 7 | 3 | conflicts with master; no merged-work supersession found |
| #2786 | Add a fleet forum for agent coordination | 1078 | 45 | 0 | conflicts with master; no merged-work supersession found |
| #2788 | Add a calm fleet mission briefing | 834 | 18 | 12 | conflicts with master; no merged-work supersession found |
| #2831 | bridge: RQ-DRAIN-phantom-1019 | 1105 | 17 | 0 | conflicts with master; no merged-work supersession found |
| #2837 | bridge: RQ-GUARDIANHEADQ8 | 1063 | 4 | 0 | conflicts with master; no merged-work supersession found |
| #2842 | bridge: RQ-DRAIN-phantom-1110 | 2309 | 179 | 99 | conflicts with master; no merged-work supersession found; 99/177 touched files match master (DRAIN recut of me |
| #2850 | bridge: RQ-NODE-1-JOIN | 1078 | 11 | 0 | conflicts with master; no merged-work supersession found |
| #2880 | bridge: RQ-NODE-4-VIEW | 1015 | 20 | 0 | conflicts with master; no merged-work supersession found |
| #2884 | bridge: RQ-APPSTEER-8-STEERINPUT | 1020 | 13 | 0 | conflicts with master; no merged-work supersession found |
| #2888 | bridge: RQ-APPCTL-7-AGENTCONTROL | 1020 | 15 | 0 | conflicts with master; no merged-work supersession found |
| #2895 | bridge: RQ-APPCARDS-5-PROVIDERCARDS | 1024 | 13 | 0 | conflicts with master; no merged-work supersession found |
| #2900 | bridge: RQ-APPCOST-11-JOBBREAKDOWN | 1013 | 18 | 0 | conflicts with master; no merged-work supersession found |
| #2901 | bridge: RQ-NODE-6-TENANCY | 1028 | 18 | 0 | conflicts with master; no merged-work supersession found |
| #2906 | bridge: FIXUP-MAIN-phantom-7b1d602 | 1020 | 34 | 5 | conflicts with master; no merged-work supersession found |
| #2910 | bridge: RQ-CTXPACK-1-BUILD | 1008 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #2912 | bridge: RQ-PHX-CHANGELOGFRAGMENTS02 | 1003 | 55 | 24 | conflicts with master; no merged-work supersession found |
| #2915 | bridge: RQ-PHX-SELFTICKCHECK02SOLC2 | 995 | 5 | 3 | conflicts with master; no merged-work supersession found |
| #2923 | bridge: RQ-PHX-MCPSELFTICKLAST02 | 678 | 4 | 0 | conflicts with master; no merged-work supersession found |
| #2928 | bridge: RQ-PHX-SELFLOOPSTOPFILE02SOLD2 | 991 | 24 | 11 | conflicts with master; no merged-work supersession found |
| #2936 | bridge: FIXUP-MAIN-phantom-7b1d602-r2 | 1003 | 33 | 6 | conflicts with master; no merged-work supersession found |
| #2943 | bridge: RQ-PHX-SELFTICKCLAUDEQUOTA02 | 982 | 60 | 26 | conflicts with master; no merged-work supersession found |
| #2960 | bridge: FIXUP-MAIN-phantom-ed25043 | 969 | 35 | 7 | conflicts with master; no merged-work supersession found |
| #2966 | bridge: RQ-PHX-SELFLOOPBUSPROGRESS02SOLJ1 | 949 | 3 | 0 | conflicts with master; no merged-work supersession found |
| #2983 | bridge: RQ-PACE-TO-RESET | 932 | 10 | 0 | conflicts with master; no merged-work supersession found |
| #3057 | bridge: RQ-BUS-NEUTRAL-1 | 871 | 17 | 0 | conflicts with master; no merged-work supersession found |
| #3062 | bridge: RQ-DISPATCH-LIVEPARITY | 862 | 4 | 0 | conflicts with master; no merged-work supersession found |
| #3146 | bridge: RQ-LAT-FIX4-EMPTYGATEQ9R2 | 778 | 7 | 0 | conflicts with master; no merged-work supersession found |
| #3150 | bridge: RQ-OMLX-LANE | 778 | 13 | 0 | conflicts with master; no merged-work supersession found |
| #3151 | bridge: RQ-APPDRIVE-1 | 777 | 7 | 0 | conflicts with master; no merged-work supersession found |
| #3154 | bridge: RQ-APPTRUTH-6-SOURCEOFTRUTHR2 | 723 | 71 | 7 | conflicts with master; no merged-work supersession found |
| #3158 | bridge: RQ-PHX-APPSCHANGESBUS03SONV1 | 327 | 3 | 0 | conflicts with master; no merged-work supersession found |
| #3162 | bridge: RQ-PHX-MCPAPPSWATCH03SONT1 | 779 | 4 | 0 | conflicts with master; no merged-work supersession found |
| #3206 | bridge: RQ-PHX-DOCTORLIVE03 | 327 | 5 | 0 | conflicts with master; no merged-work supersession found |
| #3230 | bridge: RQ-QUEUELINTQ8 | 449 | 5 | 0 | conflicts with master; no merged-work supersession found |
| #3235 | bridge: RQ-PHX-NEEDSREPLYRETRY03SOPD2 | 715 | 3 | 0 | conflicts with master; no merged-work supersession found |
| #3239 | bridge: RQ-PHX-MCPFLEETDOCTOR03 | 495 | 4 | 0 | conflicts with master; no merged-work supersession found |
| #3288 | bridge: RQ-CI-DAILYFULL-1 | 612 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #3294 | bridge: RQ-APP-CD-2 | 670 | 13 | 0 | conflicts with master; no merged-work supersession found |
| #3306 | bridge: RQ-PHX-MCPFLEETVERBS04 | 495 | 6 | 0 | conflicts with master; no merged-work supersession found |
| #3326 | bridge: RQ-AGL-MEM-1 | 635 | 4 | 0 | conflicts with master; no merged-work supersession found |
| #3357 | bridge: RQ-TIER1-APPS-CUT-1 | 607 | 69 | 0 | conflicts with master; no merged-work supersession found |
| #3363 | bridge: RQ-PHX-BATCHDRAFTIDENTITY04SPG2 | 605 | 3 | 0 | conflicts with master; no merged-work supersession found |
| #3373 | bridge: RQ-PHX-UPDATESMOKEGATE04 | 448 | 2 | 0 | conflicts with master; no merged-work supersession found |
| #3391 | bridge: RQ-PHX-PLANNERWRITEBUDGET08 | 577 | 7 | 0 | conflicts with master; no merged-work supersession found |
| #3396 | bridge: RQ-PHX-SELFTICKINCIDENTS08 | 321 | 16 | 0 | conflicts with master; no merged-work supersession found |
| #3465 | bridge: RQ-AGL-CKPT-1 | 504 | 12 | 0 | conflicts with master; no merged-work supersession found |
| #3489 | bridge: RQ-LAT-FIX4-EMPTYGATEQ9R3 | 506 | 43 | 17 | conflicts with master; no merged-work supersession found |
| #3509 | bridge: RQ-PHX-COSLOOPVERB12 | 473 | 5 | 0 | conflicts with master; no merged-work supersession found |
| #3510 | bridge: RQ-PHX-COSSELFTICKSTEP14 | 487 | 19 | 2 | conflicts with master; no merged-work supersession found |
| #3511 | bridge: RQ-AGENTPROFILE-1 | 473 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #3514 | bridge: RQ-PHX-COSDECLINE13 | 482 | 16 | 10 | conflicts with master; no merged-work supersession found |
| #3517 | bridge: RQ-SELFPUBLISH-1 | 478 | 12 | 0 | conflicts with master; no merged-work supersession found |
| #3519 | bridge: RQ-FRICTION-3-PLANNER | 494 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #3525 | bridge: RQ-PHX-MCPCURRENTSNAPSHOT04SQC1 | 474 | 3 | 0 | conflicts with master; no merged-work supersession found |
| #3529 | bridge: RQ-PHX-PHONECOSASK17 | 473 | 9 | 4 | conflicts with master; no merged-work supersession found |
| #3530 | bridge: RQ-PHX-MCPPATHCOCHANGES04SQD1 | 471 | 13 | 7 | conflicts with master; no merged-work supersession found |
| #3536 | bridge: RQ-LAUNCHWAITQ8 | 464 | 3 | 0 | conflicts with master; no merged-work supersession found |
| #3539 | bridge: RQ-PHX-LANEMODELDRIFT18 | 464 | 5 | 4 | conflicts with master; no merged-work supersession found; 4/5 match master; residual fleet-subcommand-registry |
| #3548 | bridge: RQ-PHX-APPUPDATEDESKTOP16 | 474 | 10 | 7 | conflicts with master; no merged-work supersession found; 7/10 match master; residual verse-api/workbench-type |
| #3557 | bridge: RQ-PROFILERECUTQ8 | 344 | 13 | 0 | conflicts with master; no merged-work supersession found |
| #3599 | bridge: RQ-PHX-OUTCOMEWHYVERB24 | 424 | 64 | 46 | conflicts with master; no merged-work supersession found; 46/64 touched files match master; residual outcome-w |
| #3608 | bridge: RQ-PROFILERECUT2Q8 | 344 | 15 | 0 | conflicts with master; no merged-work supersession found |
| #3705 | bridge: RQ-RECUT-MR-CONFLICT-DRIVERS-phantom-NOV5 | 324 | 54 | 28 | conflicts with master; no merged-work supersession found; 33/54 files landed via -R2 recut #3708 (463034051);  |
| #3716 | bridge: RQ-PHX-RECONCILESCANBUDGET05STF2 | 315 | 4 | 3 | conflicts with master; no merged-work supersession found; 3/4 match master; residual budget-reconcile test dif |
| #3718 | bridge: RQ-V330-CIFIX-20R2 | 322 | 15 | 6 | conflicts with master; no merged-work supersession found |
| #3825 | bridge: RQ-UPKEEP-DOCS-phantom-20261106 | 260 | 4 | 1 | conflicts with master; no merged-work supersession found; newer upkeep runs landed (#3948 Nov-07, #4097 Nov-08 |
| #3868 | bridge: RQ-COS-PAGES-1 | 560 | 14 | 0 | conflicts with master; no merged-work supersession found |
| #3878 | bridge: RQ-DRAIN-PH-009 | 147 | 23 | 16 | conflicts with master; no merged-work supersession found |
| #3879 | bridge: RQ-DRAIN-PH-006 | 147 | 7 | 0 | conflicts with master; no merged-work supersession found |
| #3881 | bridge: RQ-DRAIN-PH-011 | 147 | 12 | 0 | conflicts with master; no merged-work supersession found |
| #3882 | bridge: RQ-DRAIN-PH-013 | 147 | 13 | 0 | conflicts with master; no merged-work supersession found |
| #3889 | bridge: RQ-DRAIN-PH-000 | 148 | 23 | 4 | conflicts with master; no merged-work supersession found |
| #3896 | bridge: RQ-DRAIN-PH-033 | 144 | 42 | 4 | conflicts with master; no merged-work supersession found |
| #3906 | bridge: RQ-DRAIN-PH-044 | 139 | 10 | 4 | conflicts with master; no merged-work supersession found |
| #3913 | bridge: RQ-SWE-MERGECOCK-1 | 130 | 6 | 0 | conflicts with master; no merged-work supersession found |
| #3917 | bridge: RQ-CIFIX-PH-01 | 126 | 15 | 2 | conflicts with master; no merged-work supersession found |
| #3918 | bridge: RQ-SWE-SESSVIEW-1 | 150 | 13 | 0 | conflicts with master; no merged-work supersession found |
| #3920 | bridge: RQ-DRAIN-PH-030 | 144 | 23 | 2 | conflicts with master; no merged-work supersession found |
| #3922 | bridge: RQ-DRAIN-PH-010 | 147 | 104 | 4 | conflicts with master; no merged-work supersession found |
| #3924 | bridge: RQ-SWE-EVALS-1 | 122 | 6 | 0 | conflicts with master; no merged-work supersession found |
| #3925 | bridge: RQ-SWE-PRQUEUE-1 | 122 | 7 | 0 | conflicts with master; no merged-work supersession found |
| #3941 | bridge: RQ-SWE-LOCALTOOLUSE-1 | 123 | 5 | 0 | conflicts with master; no merged-work supersession found |
| #3942 | bridge: RQ-DRAIN-PH-021 | 145 | 48 | 0 | conflicts with master; no merged-work supersession found |
| #3943 | bridge: RQ-SWE-APPROVALS-1 | 150 | 14 | 0 | conflicts with master; no merged-work supersession found |
| #3947 | bridge: RQ-SWE-BUSPROTOCOL-1 | 116 | 10 | 0 | conflicts with master; no merged-work supersession found |
| #3955 | bridge: RQ-DRAIN2-PH-21 | 100 | 28 | 0 | conflicts with master; no merged-work supersession found |
| #3969 | bridge: RQ-DRAIN2-PH-12 | 100 | 12 | 0 | conflicts with master; no merged-work supersession found |
| #3970 | bridge: RQ-DRAIN2-PH-06 | 100 | 25 | 5 | conflicts with master; no merged-work supersession found |
| #3972 | bridge: RQ-DRAIN2-PH-14 | 100 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #3979 | bridge: RQ-DRAIN2-PH-13 | 100 | 14 | 1 | conflicts with master; no merged-work supersession found |
| #3984 | bridge: RQ-DRAIN2-PH-19 | 100 | 22 | 0 | conflicts with master; no merged-work supersession found |
| #3989 | bridge: RQ-DRAIN2-PH-02 | 100 | 52 | 22 | conflicts with master; no merged-work supersession found |
| #3991 | bridge: RQ-DRAIN2-PH-00 | 100 | 172 | 2 | conflicts with master; no merged-work supersession found |
| #3992 | bridge: RQ-DRAIN2-PH-07 | 100 | 34 | 10 | conflicts with master; no merged-work supersession found |
| #3993 | bridge: RQ-SWE2-DOCSLIVING-1 | 86 | 16 | 0 | conflicts with master; no merged-work supersession found |
| #3996 | bridge: RQ-DRAIN2-PH-08 | 100 | 56 | 0 | conflicts with master; no merged-work supersession found |
| #4003 | bridge: RQ-DRAIN2-PH-15 | 100 | 87 | 14 | conflicts with master; no merged-work supersession found |
| #4005 | bridge: RQ-SWE3-OBSERVABILITY-2 | 73 | 7 | 3 | conflicts with master; no merged-work supersession found |
| #4008 | bridge: RQ-DRAIN2-PH-09 | 100 | 24 | 0 | conflicts with master; no merged-work supersession found |
| #4009 | bridge: RQ-DRAIN2-PH-01 | 100 | 201 | 140 | conflicts with master; no merged-work supersession found; 140/199 touched files match master; residual pages/c |
| #4010 | bridge: RQ-SWE3-DOTFEED-1 | 68 | 7 | 4 | conflicts with master; no merged-work supersession found |
| #4027 | bridge: RQ-REBASE-PH-28 | 58 | 37 | 3 | conflicts with master; no merged-work supersession found |
| #4028 | bridge: RQ-REBASE-PH-33 | 58 | 9 | 0 | conflicts with master; no merged-work supersession found |
| #4030 | bridge: RQ-REBASE-PH-15 | 59 | 19 | 0 | conflicts with master; no merged-work supersession found |
| #4031 | bridge: RQ-REBASE-PH-34 | 58 | 21 | 9 | conflicts with master; no merged-work supersession found |
| #4033 | bridge: RQ-REBASE-PH-36 | 53 | 13 | 4 | conflicts with master; no merged-work supersession found |
| #4038 | bridge: RQ-REBASE-PH-13 | 59 | 30 | 0 | conflicts with master; no merged-work supersession found |
| #4042 | bridge: RQ-REBASE-PH-11 | 59 | 24 | 0 | conflicts with master; no merged-work supersession found |
| #4045 | bridge: RQ-REBASE-PH-04 | 59 | 77 | 4 | conflicts with master; no merged-work supersession found |
| #4048 | bridge: RQ-REBASE-PH-02 | 59 | 94 | 0 | conflicts with master; no merged-work supersession found |
| #4049 | bridge: RQ-REBASE-PH-14 | 59 | 48 | 0 | conflicts with master; no merged-work supersession found |
| #4050 | bridge: RQ-REBASE-PH-05 | 59 | 40 | 0 | conflicts with master; no merged-work supersession found |
| #4051 | bridge: RQ-REBASE-PH-03 | 59 | 140 | 0 | conflicts with master; no merged-work supersession found |
| #4052 | bridge: RQ-REBASE-PH-32 | 58 | 61 | 0 | conflicts with master; no merged-work supersession found |
| #4053 | bridge: RQ-REBASE-PH-12 | 59 | 61 | 0 | conflicts with master; no merged-work supersession found |
| #4054 | bridge: RQ-REBASE-PH-00 | 59 | 200 | 3 | conflicts with master; no merged-work supersession found |
| #4055 | bridge: RQ-REBASE-PH-01 | 59 | 319 | 80 | conflicts with master; no merged-work supersession found |
| #4064 | bridge: RQ-REBASE2-PH-00 | 36 | 103 | 3 | conflicts with master; no merged-work supersession found |
| #4065 | bridge: RQ-SWE3-VISION5-1 | 36 | 14 | 0 | conflicts with master; no merged-work supersession found |
| #4070 | bridge: RQ-SWE3-LEADERLOOP-1 | 32 | 8 | 0 | conflicts with master; no merged-work supersession found |
| #4071 | bridge: RQ-SWE3-AUTOPILOT-1 | 32 | 8 | 0 | conflicts with master; no merged-work supersession found |
| #4073 | bridge: RQ-SWE3-IMSGDEEP-1 | 32 | 10 | 2 | conflicts with master; no merged-work supersession found |
| #4078 | bridge: RQ-REBASE2-PH-01 | 36 | 310 | 4 | conflicts with master; no merged-work supersession found |
| #4079 | bridge: RQ-SWE3-REBASEORDER-1 | 32 | 16 | 0 | conflicts with master; no merged-work supersession found |
| #4081 | bridge: RQ-SWE3-MERGEBATCH-WIRE-1 | 28 | 14 | 0 | conflicts with master; no merged-work supersession found |
| #4082 | bridge: RQ-REBASE2-PH-02 | 36 | 401 | 3 | conflicts with master; no merged-work supersession found |
| #4088 | bridge: FIXUP-CI-phantom-ci-155790 | 22 | 7 | 0 | conflicts with master; no merged-work supersession found |

## c — superseded-by-merged-work (16) — close candidates

| PR | Title | Behind | Files | Evidence |
| --- | --- | --- | --- | --- |
| #924 | ci: Windows portability and macOS isolated/shared legs only  | 2572 | 6 | RQ-SWE3-STALEPR-1: intent landed on master |
| #927 | Add an offline eval for local versus frontier routing | 2572 | 12 | rework merged as #2834 (74fec5cf9) (verified on master) |
| #932 | ci: CodeQL, Scorecard, Renovate, and Codecov | 2385 | 13 | rework merged as #1498 (e9784d15e) (verified on master) |
| #970 | bridge: RQ-LAUNCH-LOCK | 2558 | 12 | RQ-SWE3-STALEPR-1: intent landed on master |
| #1013 | bridge: RQ-CYCLE-1-r3 | 2560 | 6 | RQ-SWE3-STALEPR-1: intent landed on master |
| #1022 | bridge: RQ-BUS-1C | 2560 | 10 | RQ-SWE3-STALEPR-1: intent landed on master |
| #1047 | bridge: RQ-PARITY-GROK-DEVIN-PEERS | 2560 | 3 | RQ-SWE3-STALEPR-1: intent landed on master |
| #1048 | bridge: RQ-QUEUE-5 | 2560 | 21 | RQ-SWE3-STALEPR-1: intent landed on master |
| #1050 | bridge: RQ-DOCTOR-FAST | 2560 | 11 | RQ-SWE3-STALEPR-1: intent landed on master |
| #1128 | ci: diet step 1, draft-defer custody macOS, scope dependency | 2572 | 9 | RQ-SWE3-STALEPR-1: intent landed on master |
| #1222 | bridge: THROUGHPUT-PHANTOM-PATHS | 2572 | 13 | RQ-SWE3-STALEPR-1: intent landed on master |
| #1223 | bridge: RQ-FAST-GATE-PHANTOM | 2572 | 15 | RQ-SWE3-STALEPR-1: intent landed on master |
| #1252 | bridge: DESKTOP-PHANTOM | 2572 | 1 | RQ-SWE3-STALEPR-1: intent landed on master |
| #3902 | bridge: RQ-DRAIN-PH-045 | 139 | 4 | PR end-state / all patches already on master |
| #4059 | bridge: RQ-SWE3-DOTFEED-TTL-1 | 36 | 7 | PR end-state / all patches already on master |
| #4109 | bridge: RQ-PARKWAKEQ8 | 1 | 4 | PR end-state / all patches already on master; merge commit 26d1e88ec references (#4109) — merged-but-open |

## d — needs-owner (10)

| PR | Title | Behind | Files | Evidence |
| --- | --- | --- | --- | --- |
| #878 | docs: governed-client gateway opt-in design note | 2619 | 1 | on Mason hold list (AGENTS.md) |
| #915 | feat(custody): carry spawn custody into receipt secrets.wrap | 326 | 7 | touches .github/CODEOWNERS + tier1-closure.json + custody secrets.wrap — Security-gate-adjacent |
| #929 | fix(cli): keep headless plugins enable from prompting | 2385 | 11 | draft PR; draft; open recut #1509 (RQ-DRAIN-PHANTOM-929) exists |
| #948 | bridge: RQ-FLEET-1-v2 | 2570 | 80 | RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race — human call |
| #976 | bridge: LAND-phantom-941 | 2568 | 81 | RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race — human call |
| #1072 | bridge: RQ-PL-FRESH-ECO-CL-JSON | 2566 | 6 | RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race — human call |
| #1136 | bridge: RQ-AUTO-LOCAL-1e | 2552 | 28 | RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race — human call |
| #1149 | bridge: RQ-DV-SPLIT-FLEET-STATUS | 2552 | 18 | RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race — human call |
| #1175 | bridge: RQ-OT-P3-HANDOFF-SCHEMA | 2550 | 4 | RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race — human call |
| #1267 | bridge: RQ-ONEASK-2-INTAKE | 2572 | 4 | RQ-SWE3-STALEPR-1: dup/mega-bundle/design-race — human call |

## Context for the closers

- **#4109 is merged-but-still-open**: commit `26d1e88ec` on master is its
  squash-merge (`bridge(RQ-PARKWAKEQ8) … (#4109)`); every PR patch is on master.
  Safe close.
- **#3902, #4059**: every touched file on the PR head is byte-identical to
  master — end-state fully landed via parallel work. Safe close.
- **#927 / #932**: DRAIN reworks merged as #2834 (`74fec5cf9`) and #1498
  (`e9784d15e`) — verified on master. Safe close.
- **Stale-wave cohort (≤#1271)** carries forward RQ-SWE3-STALEPR-1 verdicts,
  re-verified where DRAIN2/REBASE triages postdate it (#927 flipped to
  superseded by the newer evidence).
- **#1064/#1234** are one intent in two open PRs (same `ls-remote` fix line,
  differing only in `--heads` flag retention). Both merge cleanly; pick either.
- **#948/#976** remain the same 80-file fleet-v1 payload in two open PRs.
- **#3705**: 33/54 files landed via the `-R2` recut (#3708); the iMessage
  teammate-inbox module + release-fast-smoke residual is unlanded — a rebase
  would be a residual recut, not a conflict resolution.
- **Fleet shape**: the 170 needs-rebase PRs are dominated by two waves —
  ~60 RQ-REBASE*/RQ-DRAIN2*/RQ-DRAIN-PH-* fleet jobs (rebase/triage machinery)
  and ~45 RQ-PHX-* self-tick/apps wave — plus the ≤1271 stale cohort. Most are
  single-commit PRs; `behind` counts of 2300+ reflect the Oct-19→Oct-28 base.

## Method & limits

- PR list + titles via unauthenticated REST `/pulls?state=open` (3 calls);
  `gh` unusable (config unreadable under sandbox). `mergeable_state` cannot
  be harvested unauthenticated (returns `unknown`).
- Heads fetched via `git fetch origin refs/pull/N/head`; repo unshallowed so
  merge bases resolve. Verified all 236 fetched heads match API-reported SHAs.
- Merge state: `git merge-tree --write-tree origin/master <head>` — exit 0 =
  clean (BEHIND), 1 = conflict (DIRTY). Equivalent to GitHub's computation.
- Supersession: `git cherry` (patch-id equivalence per commit), per-file
  `head:file` vs `master:file` blob comparison, `(#N)` squash-merge references
  in `git log`, exact RQ-id landing-commit match, plus prior triage files in
  `.bridge-evidence/` whose claimed landings were each verified on master.
- Not evaluated: CI check state, review comments, PR bodies. Class (a) does
  not assert checks pass — only that no mechanical blocker exists.
