# Release autonomy audit

The implementation is not yet wired into the top-level CLI dispatcher. Once wired, `phm release autonomy` inventories the remaining release steps and controls for the seven enrolled repositories. It reads GitHub settings and workflow evidence through `gh api` GET requests and reads the local fleet publish switch. It never changes settings, dispatches workflows, or sends messages. Authenticate `gh` with access to repository settings before running the audit. Missing permissions or incomplete evidence are reported as unknown, not as absence of a gate.

```sh
phm release autonomy --json
phm release autonomy --repo locus --md
```

Each observed item is marked `human step`, `gate (keep)`, or `ok`. The gate inventory also proposes `cut`, `automate`, or `hard-limit`, with a reason and location. These are recommendations, not authorization to change controls. Required checks and attestation remain gates. Disabled tag rulesets are reported as disabled. The auto-tag result describes the latest observed run, not proof of a successful release. The local `PUBLISH_HOLD` reading applies to this machine; missing or degraded switch evidence is unknown.

The inventory includes policy and source controls in addition to GitHub observations. Those entries identify where to investigate and do not assert that every external system was inspected. Access failures, pagination limits, and unread workflow sources limit completeness; review unknowns before drawing conclusions.
