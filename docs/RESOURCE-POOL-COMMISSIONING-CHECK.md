# Offline native pool commissioning

`ashlr resources pool commission check --request /absolute/private/request.json --json`
prepares a content-bound plan without changing ownership, configuration, ledger,
provider state or quota evidence. `apply` can publish that exact reviewed local
locator migration; `resume` continues only an existing complete transaction.
These commands do not establish provider identity, billing entitlement or dispatch
authorization.

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
`applicationImplemented: true`, `executionAuthorized: false`,
`identityContinuityVerified: false` and `independentAccountIdentityVerified: false`.

The transaction preserves policy and evidence, with these boundaries:

- Durable transition custody linked to runtime admission. Missing or tampered
  completed journal evidence must hold admission; broadening structural history
  validation alone is insufficient.
- Retained old account context is not copied into a new origin. Existing queued
  jobs stay held and historical display is preserved. Context transfer requires
  a separately reviewed consent path.
- Target collector and epoch binding for observations. A matching worker ID or a
  newer timestamp is insufficient to qualify old quota data after enrollment.
- Journaled publication, barriers and exact recovery of complete journaled
  publication prefixes for operator configurations, console state and the final
  ledger. The complete snapshot/journal directory is published atomically; no
  partial authoritative journal is published. Before publication, the same
  reviewed apply can complete exact staged file prefixes. Partial or unknown
  bytes remain held for inspection and refusal.
- Current account, quota and billing qualification. Claude's unavailable windows
  and all operator holds remain unresolved after a locator proposal.

The plan pins exact source bytes/identities, active policy, receipts, console
contents, proposed locator metadata and target configuration. It identifies
workers whose observations are invalidated by the transaction. It does
not rewrite historical receipts, origins, retained text, allocation revisions,
account pauses or quota-scope exclusions.

Any existing console/pool/quota lock, pending quota marker, pending migration,
reserved/uncertain receipt, unresolved console work or unknown commissioning
custody refuses the check. A collector recovery receipt does not authorize
clearing its marker. Files changed during planning refuse the check. No refusal
path removes evidence or invents an empty ledger.

## Apply the reviewed local migration

Inspect the planned source and target digests, grouped aliases, preservation
counts, held queued IDs and dispatch qualification holds. Applying is an explicit
operator choice; a plan does not authorize it automatically. Use the lowercase
SHA256 `planDigest` from that exact check:

```sh
ashlr resources pool commission apply \
  --request /absolute/private/request.json \
  --expected-plan-digest REVIEWED_SHA256 --json
```

The flag selects an exact local plan; it is not a credential or a signed grant.
Changed source files or reviewed metadata require a new check and a newly
reviewed digest. Apply takes the existing console, pool and collector ownership
leases while publishing immutable custody, the migration barrier, operator
configurations, preserved console state and final ledger. It does not start the
collector, invoke native auth or providers, change authority or amend spending
limits. No live migration occurs merely because a plan is available.

An applied report distinguishes a new transaction (`created`), interrupted
publication (`resumed`) and an already finished transaction (`replayed`). Finished
replay verifies custody and preserves later receipts, observations and operator
changes. It does not restore an old snapshot over newer work.

## Resume without creating a new enrollment

If apply is interrupted, preserve the request, reviewed digest, journal,
snapshots, ledger and operator files. Inspect the fixed refusal reason, then use
the same request and digest only for that existing transaction:

```sh
ashlr resources pool commission resume \
  --request /absolute/private/request.json \
  --expected-plan-digest REVIEWED_SHA256 --json
```

Resume refuses an absent or incomplete journal. It never substitutes a fresh
plan, removes an unknown lock or marker, clears uncertain work, or invents an
empty ledger. Missing, malformed or changed custody remains held for review;
do not delete evidence to make the command succeed. A lost response is not
permission to retry with different inputs.

## Migration is separate from dispatch

Successful migration still reports `executionAuthorized: false`. Account
continuity and independent account identity remain unverified. Enrolled workers
need fresh observations from their exact target collector/configuration/profile
epoch and genuine account-specific subscription-only billing evidence. A newer
timestamp, quota percentage, credit balance, plan label or shared alias is not
that proof. Unknown quota or billing stays held, and existing pauses, allocation
revisions, quota exclusions and signed limits remain binding.

The command accepts no provider, authentication or spending options. Exit codes
are **0** for planned/applied/help, **1** for held/unavailable and **2** for invalid
CLI arguments. Read the report's migration disposition and qualification holds
separately; an applied local migration is not a commissioned runnable fleet.
