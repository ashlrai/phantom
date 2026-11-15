# RQ-REBASE-PH-27 triage

Compared against origin/master eff2ade56843436b7ee355264285d31a1f736e4a. Zero reworks; only the explicitly superseded PRs are candidates for closure.

- PR 1727: skipped — residual pairing work; its web-triggered daemon installation conflicts with main's fail-closed signed daemon repair authority. Requires security/authority resolution; not superseded.
- PR 1726: skipped — residual local-model onboarding and readiness work. Main's newer Connect balancer already probes local endpoints; a three-way application conflicts across API, UI, and readiness and does not preserve its opt-in promise. Requires a semantic port; not superseded.
- PR 1725 SUPERSEDED — sibling drain #3895 (f8d371d2d) incorporated lane ranking and CLI, with later extensions.
- PR 1724 SUPERSEDED — sibling drain #3895 incorporated both routing observation commands and documentation.
- PR 1723 SUPERSEDED — sibling drain #3895 incorporated the resource ledger projection and tests.
- PR 1720: skipped — residual old local-lane eligibility and escalation rules alter live dispatcher policy; current restock has advanced and deployment requires Security re-pinning. Current applicability of the historical owner directive needs judgment; not superseded.
