# Release autonomy audit

The implementation is not yet wired into the top-level CLI dispatcher. Once wired, `phm release autonomy` inventories the remaining release steps and controls for the seven enrolled repositories. It reads GitHub settings and workflow evidence through `gh api` GET requests and reads the local fleet publish switch. It never changes settings, dispatches workflows, or sends messages. Authenticate `gh` with access to repository settings before running the audit. Missing permissions or incomplete evidence are reported as unknown, not as absence of a gate.

```sh
phm release autonomy --json
phm release autonomy --repo locus --md
```

Each observed item is marked `human step`, `gate (keep)`, or `ok`. The gate inventory also proposes `cut`, `automate`, or `hard-limit`, with a reason and location. These are recommendations, not authorization to change controls. Required checks and attestation remain gates. Disabled tag rulesets are reported as disabled. The auto-tag result describes the latest observed run, not proof of a successful release. The local `PUBLISH_HOLD` reading applies to this machine; missing or degraded switch evidence is unknown.

The inventory includes policy and source controls in addition to GitHub observations. Those entries identify where to investigate and do not assert that every external system was inspected. Access failures, pagination limits, and unread workflow sources limit completeness; review unknowns before drawing conclusions.

## Orchestration slice

`src/core/release/orchestration.ts` defines an effect-free state machine for a
single repository, source SHA, version and sanctioned workflow. Detection is
followed by exact-candidate gate observations, a dispatch intent, dispatch
reconciliation, and publication verification. Failed publication emits a
rollback signal; it never performs a rollback. A missing or failed gate holds
without authorizing tag creation, billing, or any other owner-reserved action.

The caller must independently verify current grants, required checks, signing,
workflow commissioning, owner-reserved boundaries, and publication evidence.
These input assertions are not attestations or authority. Persist the
`reconcile-dispatch` state before invoking the workflow, use durable exclusive
coordination, and reconcile uncertain outcomes against the provider before any
retry. This module supplies neither persistence nor provider calls, a CLI,
retries, trusted time, or concurrency control; it is not a release executor.
