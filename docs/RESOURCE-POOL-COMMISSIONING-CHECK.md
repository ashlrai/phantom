# Offline native pool commissioning preparation

`ashlr resources pool commission check --request /absolute/private/request.json --json`
prepares a content-bound plan without changing ownership, configuration, ledger,
provider state or quota evidence. Only `check` is available. `apply` and `resume`
are refused before reading inputs.

Use this when old launchers cannot prove account continuity and the operator is
considering explicit new roster enrollment. The plan acknowledges that missing
continuity; it does not infer continuity from email hints, profile paths or a
shared label. A roster's account hint is an operational metadata pin. A witnessed
profile establishes filesystem identity, not provider identity or entitlement.

## Private request

```json
{
  "root": "/private/accounts/ledger",
  "workspace": "/absolute/repository",
  "accountsRoot": "/private/accounts",
  "acknowledgment": "new-roster-enrollment-without-continuity",
  "enrollments": [
    { "capacityKey": "personal", "seatId": "reviewed-personal-seat" },
    { "capacityKey": "cmp", "seatId": "reviewed-cmp-seat" }
  ]
}
```

`root` must be `accountsRoot/ledger`, outside the workspace. The planner reads
fixed `pool.json`, `bindings.json`, `quota-config.json` and `connections.json`
under `accountsRoot`, plus existing ledger and optional console state. Selected
files must be private owned regular files, without symlinks or hard links.

The selected operator pool and bindings must match one exact recorded epoch.
An earlier three-worker snapshot can be recognized while the active ledger has
four workers; mixed, unknown or edited snapshots are refused. Active policy is
the basis of the proposal: worker IDs, models, scopes, capacities, caps and
reserves are unchanged. Every alias of an enrolled capacity uses the same
proposed launcher. Codex quota configuration includes all aliases with exact
scope buckets and reviewed roster hints. Distinct locators and distinct hints
prevent operational duplicates; they do not prove independent accounts.

No native executable, auth command, provider API, collector or discovery is
invoked. The native profile resolver performs bounded OS/filesystem metadata
checks. Native auth files and credential contents are not read. The planner
requires existing reboot-stable witnessed profiles and does not upgrade them.

## Holds and preservation

A plan is inert preparation. It always reports `applicationReady: false`,
`applicationImplemented: false`, `executionAuthorized: false`,
`identityContinuityVerified: false` and `independentAccountIdentityVerified: false`.

Writable commissioning requires separate reviewed implementation and approval:

- Durable transition custody linked to runtime admission. Missing or tampered
  completed journal evidence must hold admission; broadening structural history
  validation alone is insufficient.
- Exact visible acknowledgment before copying retained old account context into
  a new origin. Existing queued jobs stay held; historical display is preserved.
- Target collector and epoch binding for observations. A matching worker ID or a
  newer timestamp is insufficient to qualify old quota data after enrollment.
- Journaled publication, barriers and exact crash recovery for all operator
  configurations, console state and final-ledger publication.
- Current account, quota and billing qualification. Claude's unavailable windows
  and all operator holds remain unresolved after a locator proposal.

The plan pins exact source bytes/identities, active policy, receipts, console
contents, proposed locator metadata and target configuration. It identifies
workers whose observations must be invalidated by a future transaction. It does
not rewrite historical receipts, origins, retained text, allocation revisions,
account pauses or quota-scope exclusions.

Any existing console/pool/quota lock, pending quota marker, pending migration,
reserved/uncertain receipt, unresolved console work or unknown commissioning
custody refuses the check. A collector recovery receipt does not authorize
clearing its marker. Files changed during planning refuse the check. No refusal
path removes evidence or invents an empty ledger.

The plan digest is not an apply credential. If source files or reviewed metadata
change, a new check produces a different digest. No live migration or provider
admission has occurred merely because a plan is available.
