# CEO org plane

The Leader is the digital cofounder/CEO; Mason is the board. The desktop is the
observability and interjection surface. `runs/org/agents.json` means
`$ASHLR_RUNS_DIR/org/agents.json` (default `~/.ashlr-runs/org/agents.json`). This
private atomic document contains the chart, revisioned ledger and bus outbox.
Reads of an absent store return standing roles without creating files.

```sh
phm org agents --json
phm org agents janitor --json
phm org propose --input proposal.json --json
phm org propose --input proposal.json --apply --json
phm org sync --json
```

`propose` records a candidate; `--apply` records and applies the supplied change.
Refresh `expectedRevision` after every proposal, including an unapplied one.
`--runs <dir>` selects a scratch root, including its local `bus/`. Existing `org show|join|plan` still operate
on co-founder contributions in `org.toml`.

Example `proposal.json` (read the current revision first):

```json
{"actor":"leader","reason":"Batch engineering review","expectedRevision":0,"change":{"kind":"upsert","role":{"id":"review-session","title":"Review worker","charter":"Review changes and propose follow-up work","tier":"WORKER_SESSION","reportsTo":"engineering","status":"active","scope":"engineering","needs":["git","gh","node"],"laneAffinities":["codex-personal"],"budget":{"tokens":0,"sessions":0,"maxCostClass":"included"},"sizing":{"batchDepth":100,"fanOut":2},"sessionId":null}}}
```

Change kinds are `upsert` (full role, including retitle/re-scope), `retire` with
`id`, and `revoke` with an applied ledger `revision`. Retirement cascades to
worker roles; it does not kill running processes. Revocation restores previous
metadata only if affected roles have not changed since; history is retained.
The writer lock and expected revision prevent lost concurrent edits. Corrupt
stores fail closed. Bounded ledgers refuse new writes when full; no audit rows
are silently dropped.

LEADER → ORCHESTRATORS → WORKER_SESSION is validated. One active `leader` is
required. Engineering (Grokbot-style), JANITOR and comms are standing
orchestrators. Orchestrators may edit their own worker roles. `actor` is local
attribution, not an authenticated identity or a grant. Scopes are engineering,
research, janitor and comms-draft; capability `needs` use work-market labels
(for example git, gh, node, browser or python). Credential/payment/2FA scopes and capability labels are excluded;
secret-shaped metadata and unknown fields are refused. Charters are untrusted
descriptions, never executable instructions. Private-to-public disclosure and
security bypass remain forbidden under existing gates.

Budgets are planning ceilings, initially zero, with child totals bounded by
their parent and cost class. Raising a ceiling grants no quota or money. Lanes
are affinities; host-advertised capabilities and work-market `needs` decide
eligibility. No launcher, scheduler, profile grant or external send is changed.
Existing `phm sessions` owns actual session lifecycle; `sessionId` links its
metadata. Comms drafts cover email, LinkedIn, iMessage and dot without sending.

## Session economics and the AMPLIFY loop

Each Leader tick reads org data, vitals and JANITOR findings before proposing
staffing, titles, scope or retirement. JANITOR continuously proposes dead-code
and stale-info kill lists and the next cross-repo work ranked by leverage to
the unified vision. Orchestrators batch 10–100+ tasks, generate new work and
plan bounded sub-agents; employment has no wage stickiness.

`phm org agents --vitals vitals.json --json` adds advisory `sessionAdvice`.
Vitals contain `queued`, `liveClaims`, `tokenCeiling`, `fanOutCeiling`, `warm`
(sample or null) and `fresh` (samples). Each measured sample contains
`batchDepth` (10–1000), `fanOut` (0–32), `completed`, `tokens`, `elapsedMs`, and
`setupTokens`. Compare useful tokens/task plus fresh setup amortized over the
remaining batch; throughput breaks ties. Warm setup is already paid. The
result is keep/spawn/drain/retire/hold with sizing. Missing evidence holds;
live claims drain before replacement; no remaining work retires. Consumers
must respect exclusive tasks, claim leases and existing admission at launch.

## Board and Agent Bus v2

`GET /api/verse/leader/org` requires a current desktop read session and returns
`org.board.v1` for OrgCard: agents, pending proposals, recent edits and pending
bus counts. It accepts no HTTP mutations. The CLI provides the same projection.
Applied changes enqueue `org.membership` bodies with tier, reporting line,
status, needs, revision and `grantsExecutionAuthority:false`. Delivery retries
in order through `org sync`; event IDs are namespaced to the store. Consumers
reconcile by revision against the chart. `org:<role id>` claims overlap only
the same role and use existing expiring token-fenced claim operations. Neither
membership nor a claim grants execution authority. Source prompt changes need
the existing Security pin process before any live leader deployment.
