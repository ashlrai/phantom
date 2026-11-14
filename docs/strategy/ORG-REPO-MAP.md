# AshlrAI repository leverage map

Survey: 2026-11-14, public GitHub observations at approximately 09:42–09:44 UTC.
Job: RQ-CMP-CROSSREPO-SYNC-1. Phantom source baseline:
`c5fed9a5a70dc51721b660d69179581f120296c7`. Recommendations and the queue extension
below are proposals, not implemented routing or evidence of installed readiness.

## Scope and evidence

The requested “9 org repos” is not the observed org inventory. The anonymous
[GitHub repository listing](https://api.github.com/orgs/ashlrai/repos?per_page=100&type=public)
returned **29 public repositories**, all unarchived. The source
[restock allowlist](../../contrib/mac/restock.py) (`GS_REPOS`) and
[ranking seed](../REPO-RANK.md) contain **seven**: phantom, phantom-secrets, locus,
lexicon, ashlr-plugin, ashlr-stack and ashlr-md. This map examines those seven
plus ashlr-core-efficiency and ashlr-pulse in depth: the former supplies shared
efficiency primitives; the latter has a concrete Phantom telemetry adapter.
Those two additions are analytical scope, not enrollment. The other 20 public
repos remain visible in the inventory below.

`gh repo list ashlrai --limit 100 --json nameWithOwner,description,isArchived,isPrivate,pushedAt,updatedAt,defaultBranchRef,url`
failed before contacting GitHub because its local configuration was unreadable.
The fallback used anonymous HTTPS GETs, without credential recovery. Public
metadata cannot establish private inventory. Cortex is referenced in
[companion documentation](../COMPANIONS.md), but its public PR endpoint returned
404; its current activity and queue coverage are **unknown**, not absent.
The [23-entry historical ecosystem map](../ECOSYSTEM-MAP.md) is not a current
org roster. In particular, do not turn historical local directories into
assertions about present GitHub repositories.

For reproduction, enumerate `/orgs/ashlrai/repos?per_page=100&type=public` until
the final page; for each detailed repo read `/repos/ashlrai/REPO/commits?per_page=1`,
then `README.md` at that SHA from raw.githubusercontent.com. Read
`/repos/ashlrai/REPO/pulls?state=open&per_page=100&page=N` through the last page.
The nine PR inventories contained 554 open PRs: Phantom 409 across five pages;
the other eight fit one page each. Pagination is not an atomic snapshot.
No title matched crossrepo, cross-repo, repo map or repo-map; an additional
public open-PR search for `ORG-REPO-MAP` returned zero with no incomplete-results
flag. This is a bounded duplicate check, not proof about private or untitled work.

The supplied live-claim snapshot identifies three Phantom rebase jobs and one
unresolved claim; it does not establish sibling job queues. The table below
therefore cites **observed open-PR job IDs**, not active executor assignments.
Private router prompts and job ledgers were not read. Recommendations require
reconciliation with the existing PR owner before another implementation is queued.

## Activity and observed fleet targeting

Times are UTC. Default-head time is the Git committer timestamp at the linked
revision. `pushed_at` can include other branches; neither timestamp proves a
release, deployment or accepted owner outcome. Six of the seven seeded repos'
latest default commits are documentation upkeep. PR counts include non-fleet PRs.

| Repository / purpose source at inspected revision | Default head time | Last push | Open PRs | Observed targeting, not live claims |
| --- | --- | --- | ---: | --- |
| [phantom](https://github.com/ashlrai/phantom/blob/c5fed9a5a70dc51721b660d69179581f120296c7/README.md) | Nov 14 09:27:13 | Nov 14 09:28:20 | 409 | [RQ-PHX-CLAIMBOARDBIND329 #5509](https://github.com/ashlrai/phantom/pull/5509); [FIXUP-MAIN-phantom-e89e806 #5407](https://github.com/ashlrai/phantom/pull/5407). RQ-REBASE-PHANTOM-3510/4281/4641 are supplied live claims. |
| [phantom-secrets](https://github.com/ashlrai/phantom-secrets/blob/9a2f05e9e8d143ba835560184e017ad7822b3ba0/README.md) | Nov 14 05:48:39 | Nov 14 05:50:40 | 67 | [RQ-PS14A110916Q8 #1437](https://github.com/ashlrai/phantom-secrets/pull/1437); [RQ-UPKEEP-REL-phantom-secrets-20261110 #1433](https://github.com/ashlrai/phantom-secrets/pull/1433). |
| [locus](https://github.com/ashlrai/locus/blob/42b92d1a4d194fe89cdf80baaa3cb56ea0cfa5db/README.md) | Nov 14 05:32:01 | Nov 14 05:33:10 | 16 | [FIXUP-CI-locus-conformance-277950 #952](https://github.com/ashlrai/locus/pull/952); [RQ-LOCUS8102A110907Q8 #946](https://github.com/ashlrai/locus/pull/946). |
| [lexicon](https://github.com/ashlrai/lexicon/blob/67bd98632316d1c52b5175ef5a57761e0c245bb0/README.md) | Nov 14 05:31:40 | Nov 14 05:32:32 | 13 | [RQ-LEXICON21A110919Q8 #1004](https://github.com/ashlrai/lexicon/pull/1004); [RQ-LEXICON5A110919Q8 #994](https://github.com/ashlrai/lexicon/pull/994). |
| [ashlr-plugin](https://github.com/ashlrai/ashlr-plugin/blob/5973fcf4c72523b1284c154a786831eee718f3c7/README.md) | Nov 12 05:31:10 | Nov 13 17:24:24 | 12 | [RQ-PLUGIN6A110915Q8 #1184](https://github.com/ashlrai/ashlr-plugin/pull/1184); [RQ-PLUGIN4A110915Q8 #1181](https://github.com/ashlrai/ashlr-plugin/pull/1181). Benchmark refresh [#1176](https://github.com/ashlrai/ashlr-plugin/pull/1176) already exists. |
| [ashlr-stack](https://github.com/ashlrai/ashlr-stack/blob/933bead02d9371a9d7cd3f32c87114312e11a4be/README.md) | Nov 11 06:12:15 | Nov 11 06:13:05 | 18 | [RQ-STACK5A110919Q8 #1318](https://github.com/ashlrai/ashlr-stack/pull/1318); [RQ-DELETE-ashlr-stack-1028 #1309](https://github.com/ashlrai/ashlr-stack/pull/1309). |
| [ashlr-md](https://github.com/ashlrai/ashlr-md/blob/b8ee45c2b7e14d86535b6f506cf5b4ae72566d26/README.md) | Nov 14 05:43:40 | Nov 14 05:45:11 | 18 | [RQ-MD17A110919Q8 #1871](https://github.com/ashlrai/ashlr-md/pull/1871); [RQ-UPKEEP-REL-ashlr-md-20261110 #1907](https://github.com/ashlrai/ashlr-md/pull/1907). |
| [ashlr-core-efficiency](https://github.com/ashlrai/ashlr-core-efficiency/blob/5cd1a39053bc0c246ac063238229af8d8f79694c/README.md) | Oct 11 23:15:52 | Oct 11 23:15:53 | 0 | No open-PR job observed; outside the seven-repo restock allowlist. Live coverage unknown. |
| [ashlr-pulse](https://github.com/ashlrai/ashlr-pulse/blob/e77f91d06094a1f2127f75e3cb7345b70d806545/README.md) | Aug 18 21:27:02 | Sep 29 14:35:56 | 1 | [v0.3 work #2](https://github.com/ashlrai/ashlr-pulse/pull/2), without a fleet job ID. Outside the seven-repo restock allowlist; live coverage unknown. |

## Ownership and leverage

Optimize the [end-state vision](ENDSTATE.md): verified owner outcomes per day,
less repeated work and fewer human interruptions within existing grants.
Ranks 1–3 within each repo are judgment, ordered by shared benefit and confidence
relative to implementation effort; they are not measured ROI. Acceptance examples
make the ranking falsifiable. Broad contract repairs precede new product surfaces.

Dependency direction below is **consumer → producer**. A CLI/MCP or telemetry
edge is a protocol boundary, not necessarily a package dependency. The
[toolchain](../AGENT-TOOLCHAIN.md) and
[companion inventory](../../src/core/companion-inventory.ts) are the local
integration evidence; installed compatibility still needs separate verification.

| Consumer → producer | Boundary and work split |
| --- | --- |
| Phantom → Secrets | Separate `phantom` CLI and MCP for credential custody. Secrets owns injection/refusal semantics; Phantom owns its adapter and value-blind readiness display. |
| Phantom → Locus | Scoped identity/session tools. Locus owns binding and revocation; Phantom consumes readiness without inventing an identity store. |
| Phantom → Lexicon | Transcript normalization and project trust. Lexicon owns correction semantics; Phantom owns when input is normalized. |
| Phantom → Plugin → Core Efficiency | Plugin supplies compact MCP tools to supported execution paths; Core Efficiency documents shared compression/budget primitives. This does not establish a direct Phantom package dependency. |
| Phantom → Stack → Secrets | Stack supplies service planning/provisioning interfaces and uses Secrets for custody. Provisioning and payment authority remain separate from queue eligibility. |
| Phantom → Ashlr MD | Markdown opening/review via a separate app/CLI, with terminal fallback. Artifact presentation does not authorize publication. |
| Phantom → Pulse | Optional metadata export/polling through the [Pulse adapter](../../src/core/integrations/pulse-exporter.ts). Pulse owns telemetry ingestion/presentation; Phantom owns job state and admission. Configuration presence does not prove live traffic. |

### phantom — engineering work and evidence kernel

Own intake, queue identity, scoped assignment, attempts and outcome receipts.
Keep companion implementations in their producer repositories.

1. **Bind cross-repo work to one outcome and per-repo children.** Extend the shared queue seam below; replay a crash between child creation and claim with no duplicate work or lost target.
2. **Make producer compatibility evidence consumable.** Record exact producer artifact and consumer test revisions together; a source-only change must not be displayed as installed compatibility. This removes repeated companion diagnosis across lanes.
3. **Close the outcome loop across repos.** Attribute merged, released and accepted milestones separately, including recut cost and observation coverage. A docs-upkeep commit must not become evidence that a product defect was repaired.

### phantom-secrets — credential custody

Keep vault values and route-bound injection inside Secrets. Phantom and Stack
consume references and explicit readiness/refusal outcomes.

1. **Publish a shared adapter conformance fixture.** Exercise synthetic placeholders, denied routes and expired access through Secrets, Stack and Phantom; no fixture secret appears in captured logs. One producer fixture removes three independently drifting interpretations.
2. **Qualify release-to-consumer compatibility.** Join the producer's sanctioned artifact receipt to the reviewed Phantom pin and bootstrap smoke result; preserve the distinction between source candidate and published release.
3. **Make failure recovery value-blind.** Stable reason codes should distinguish locked vault, unavailable proxy and unsupported version; consumers render actionable recovery without exposing values or performing automatic secret creation.

### locus — identity and account scope

Locus owns pinned identity and sealed sessions. Its README's pin-based isolation
is a boundary to preserve, not a credential fallback for a failed `gh` call.

1. **Share identity refusal fixtures across consumers.** A mismatched repo/account, revoked session or expired binding must prevent provider operations in both Locus and the Phantom adapter.
2. **Unify session readiness diagnostics.** Distinguish registered MCP, connected process and usable scoped session; verify transitions using synthetic identities. Route only when the required capability has evidence.
3. **Version CLI/MCP compatibility together.** Feed supported schema/version metadata to Phantom's existing inventory and onboarding surfaces; reconcile the existing conformance repair PR before creating new work.

### lexicon — correct intent before execution

Lexicon rewrites transcripts using the user's vocabulary; it is not the
dictation engine. Preserve project trust and keep personal vocabularies local.

1. **Test repo/job identifiers as an intent boundary.** A shared synthetic corpus covers Ashlr repo names, paths and job IDs, ensuring normalization does not change the intended target or command semantics.
2. **Preserve provenance through intake.** Expose original-versus-corrected evidence locally so a correction can be inspected before it becomes scoped work; never pool private transcript bodies.
3. **Publish one capability manifest for supported entrypoints.** Verify MCP and CLI behavior against the same corpus, then let Phantom diagnose missing project trust separately from unavailable service.

### ashlr-plugin — efficient agent tool results

Own tool selection, compact output and local accounting. Share compression
primitives with Core Efficiency instead of copying them into Phantom adapters.

1. **Measure accepted-task cost with semantic checks.** Extend existing benchmark work (#1176) with complete-file fallback and missed-evidence cases; smaller output alone is not success if the fix becomes wrong.
2. **Qualify lane-specific MCP behavior.** Test explicit worktree paths, cwd, bounded output and Unicode on actual supported adapters; the [lane parity audit](../AGENT-TOOLCHAIN.md#lane-tool-parity-audit-rq-delegate-scope-1) shows repo declarations do not imply lane injection.
3. **Coordinate shared primitive releases with consumers.** Pair a Core Efficiency release fixture with Plugin acceptance and a Phantom sidecar smoke test; retain the existing working version until compatibility is demonstrated.

### ashlr-stack — service setup and reconciliation

Own provider adapters and service plans. Use Phantom for work coordination and
Secrets for custody; preserve provider-specific setup and spending constraints.

1. **Make plan/apply receipts idempotent across retries.** Synthetic provider failures must resume or reconcile the same operation without duplicate services; Phantom consumes the receipt rather than repeating task prose.
2. **Share credential and identity readiness contracts.** Test Secrets references and, where supported, scoped identity before provider effects; unsupported providers remain explicit instead of appearing ready.
3. **Generate capability docs from tested adapters.** Publish supported read/plan/apply operations and evidence status per provider so the fleet requests the right capabilities without assuming universal provisioning.

### ashlr-md — human-readable artifact surface

Own document rendering, opening and review interaction. Phantom owns the work
item and authoritative status; links connect a document to its source outcome.

1. **Bind review to the exact artifact digest.** Changed documents invalidate stale review results; the Phantom handoff preserves document and outcome identity without treating review as send authority.
2. **Qualify CLI/MCP opening and fallback.** Cover installed, missing-app, unsupported-version and timed-out cases; terminal access remains available and source-branch features are not advertised as shipped.
3. **Render fleet evidence consistently.** Exercise representative tables, source links and diffs from Phantom reports, with export/accessibility checks, so useful evidence survives the presentation handoff.

### ashlr-core-efficiency — reusable context primitives

The inspected README names Plugin and ashlrcode as consumers of compression,
genome retrieval and budgeting modules. Phantom benefits indirectly through tools.

1. **Create a consumer compatibility matrix.** Pin Plugin/ashlrcode fixtures to a candidate primitive version; both must preserve required evidence and compile against supported subpaths before adoption.
2. **Evaluate compression against task success.** Measure retrieval omissions and accepted-fix quality alongside bytes/tokens saved; include small-context local-model cases without remote inference.
3. **Retire duplicate algorithms only after parity evidence.** Inventory consumer copies, move one primitive at a time and delete proven redundant implementations. First establish enrollment and ownership; this map grants neither.

### ashlr-pulse — shared operational visibility

Own team-visible metadata and telemetry views. Preserve the documented privacy
floor: no prompts, completions or code. Avoid a second authoritative queue.

1. **Join job, attempt, repo and outcome identities end to end.** Replay Phantom export into Pulse with duplicate events and missing coverage; one attempt appears once and absent data remains unknown.
2. **Make stale telemetry visible.** Distinguish event time, ingestion time and source health; dashboard outages must not stall Phantom ticks or masquerade as zero work.
3. **Reconcile old roadmap work with current fleet boundaries.** Review existing #2 before proposing overlapping UI work; prioritize metadata views and shared admission semantics over another orchestration implementation. Enrollment remains unresolved.

## Remaining public repositories

Purpose and last-push dates below come from the same public repository listing
(all dates 2026). Unlike the nine detailed repos, their PR inventories and default
heads were not surveyed: **fleet job IDs/coverage are unknown for every row**.
None is in the seven-repo `GS_REPOS` source allowlist. “Potential” edges are
recommendations, not verified integration. The compact 1 → 3 lists rank suggested
improvements by the same vision/effort judgment; a discovery task precedes any
implementation where the edge is unverified.

| Repository | Purpose; last push UTC | Edge to Phantom | Top three proposals, highest leverage first |
| --- | --- | --- | --- |
| [ashlr-ao](https://github.com/ashlrai/ashlr-ao) | Local agent orchestration; Nov 04 00:34:52 | Potential overlapping execution surface | 1. Map overlap with Phantom; 2. adapt useful executors to existing work IDs; 3. retire redundant coordination only after migration evidence. |
| [morphkit](https://github.com/ashlrai/morphkit) | React/TypeScript to native iOS; Oct 30 15:03:13 | Potential build capability | 1. Reproducible conversion acceptance corpus; 2. capability/output manifest for jobs; 3. bounded resumable conversion receipts. |
| [binshield](https://github.com/ashlrai/binshield) | Package supply-chain analysis; Oct 16 06:18:56 | Potential dependency evidence producer | 1. Machine-readable findings with provenance; 2. sanctioned consumer integration; 3. false-positive fixtures and bounded scan cost. |
| [creatures](https://github.com/ashlrai/creatures) | Connectome-driven virtual organisms; May 15 22:43:08 | No direct edge established | 1. Reproducible offline benchmark; 2. explicit research acceptance; 3. separate research demand from fleet upkeep. |
| [homebrew-phantom](https://github.com/ashlrai/homebrew-phantom) | Secrets distribution tap; Oct 06 15:27:34 | Indirect, via Secrets installation | 1. Bind formulas to qualified Secrets artifacts; 2. clean-install smoke; 3. automate drift reporting through its release workflow. |
| [ashlrcode](https://github.com/ashlrai/ashlrcode) | Multi-provider agent CLI; Oct 16 05:54:20 | Historical executor candidate; Core Efficiency consumer | 1. Verify bounded executor adapter; 2. align session/outcome receipts; 3. share primitive compatibility fixtures. |
| [webfetch](https://github.com/ashlrai/webfetch) | License-aware image discovery; Oct 13 05:02:45 | Potential product-building capability | 1. Preserve source/license evidence; 2. deterministic unavailable-provider fallback; 3. job capability manifest with bounded results. |
| [homebrew-webfetch](https://github.com/ashlrai/homebrew-webfetch) | WebFetch distribution tap; May 09 22:19:18 | Indirect potential tool installation | 1. Qualified artifact/checksum parity; 2. clean-install smoke; 3. stale-formula reporting. |
| [ashlr-workbench](https://github.com/ashlrai/ashlr-workbench) | Local multi-agent workbench; Jul 10 04:13:36 | Historical executor composition | 1. Resolve overlap with Phantom; 2. preserve useful adapter conformance; 3. deprecate duplicated lifecycle ownership after migration. |
| [solar](https://github.com/ashlrai/solar) | Solar permitting knowledge/docs; Jun 17 04:18:15 | Potential domain knowledge input | 1. Source freshness/provenance checks; 2. jurisdiction-specific retrieval fixtures; 3. explicit human acceptance for generated domain claims. |
| [idle](https://github.com/ashlrai/idle) | macOS DePIN app orchestration; May 08 22:20:29 | No direct edge established | 1. Explicit resource-consumption inventory; 2. reversible lifecycle tests; 3. keep revenue hypotheses separate from fleet capacity evidence. |
| [homebrew-idle](https://github.com/ashlrai/homebrew-idle) | Idle distribution tap; May 08 22:17:53 | No direct edge established | 1. Artifact/checksum parity; 2. install/uninstall verification; 3. stale-formula reporting. |
| [.github](https://github.com/ashlrai/.github) | Org profile/discovery; Oct 13 00:27:27 | Public entrypoint to Phantom | 1. Current product links; 2. generated repo/source inventory; 3. distinguish source ambitions from released capabilities. |
| [mechanistic-interpretability](https://github.com/ashlrai/mechanistic-interpretability) | Local Apple Silicon research; May 28 22:30:54 | Potential offline evaluation input | 1. Reproducible research artifacts; 2. explicit compute bounds; 3. measured transfer to a routing question before integration. |
| [ashlr-mux](https://github.com/ashlrai/ashlr-mux) | Agent-oriented macOS terminal; Jul 20 08:59:32 | Potential operator surface | 1. Session/job deep links; 2. lifecycle notification contract; 3. accessible terminal-to-Phantom handoff without another scheduler. |
| [codedreamer](https://github.com/ashlrai/codedreamer) | Learned code-execution research; Jun 29 02:33:50 | No production edge established | 1. Exactness/abstention benchmark; 2. reproducible local artifacts; 3. isolate research from trusted code execution. |
| [runbook-control-plane](https://github.com/ashlrai/runbook-control-plane) | Financial-agent control research; Nov 01 15:36:16 | Potential evidence-contract reuse | 1. Offline ledger verifier; 2. evaluate reusable evidence types; 3. preserve prototype/no-order boundary rather than connect trading effects. |
| [homebrew-tap](https://github.com/ashlrai/homebrew-tap) | Locus/Ashlr distribution; Nov 10 04:37:01 | Indirect identity-tool installation | 1. Map package owners and releases; 2. consumer install/version smoke; 3. reconcile overlapping taps without moving tags. |
| [wrkpad](https://github.com/ashlrai/wrkpad) | Creator Micro 2 fleet controls; Nov 05 00:30:48 | Potential operator input surface | 1. Bind controls to existing work IDs; 2. reflect actual command outcomes; 3. test reconnect/idempotency without duplicate actions. |
| [fleet-canary](https://github.com/ashlrai/fleet-canary) | Fleet verification/revert drills; Sep 26 20:29:25 | Explicit [canary contract](../../src/core/authority/standing-grant.ts) | 1. Reproducible scoped failure drills; 2. preserve attempt/evidence identity; 3. verify sanctioned recovery without extrapolating canary authority to production. |

## Shared-queue extension proposal

Add optional `targets` to a proposed **`queue.v2`** job at the existing
[schema/store seam](../../src/core/queue/schema.ts), leaving
[queue.v1 and live router/TSV semantics](../QUEUE.md) unchanged until migration.
Omitted `targets` means the single primary repo. Each target has a stable ID,
canonical `owner/repo`, relative path scope,
additional `needs`, acceptance and dependency edges to other target IDs with
an explicit `merged` or `released` evidence milestone. Keep `repo` as the primary
coordination repo and require exactly one matching target; it is not permission
to edit other repos from that checkout. The coordinator validates unique repos
and IDs, rejects cycles, unknown dependencies, unsafe paths and unenrolled or
out-of-owner-scope targets, then atomically materializes deterministic children
`parent-id.target-id`, one worktree and one coherent PR per repo. Effective needs
are the union of parent and target needs; tier, cost ceiling, holds, privacy,
capability admission, leases and route hysteresis still apply per child. The
parent groups the outcome and never launches a second worker. Resolve dependency
milestones using receipts bound to the producer child, repository, revision and,
for release, the sanctioned artifact identity; local `DONE` or a PR URL alone
cannot release a dependent child. On restart, reconcile the same child IDs and
receipts before retrying; an open claim/PR is reused, never duplicated. Validate
against a host-owned repo registry, never infer checkout paths or commands from
prompt text. Legacy v1 jobs lift to a single target only through explicit
migration; older readers must reject v2 rather than silently discard targets.
Version the producer, Markdown/TSV adapter and consumer together, shadow-replay
before a bounded cutover, and keep one scheduler owner per cohort. Unknown
enrollment/receipt/access evidence remains blocked with a reason, without new
credentials or spending. This extends RQ-SHARED-QUEUE-1 ownership; it creates no
second queue and does not alter the live Security-pinned dispatcher.

Illustrative format only; this is not accepted queue input or queued work:

```json
{
  "schema": "queue.v2",
  "jobs": [{
    "id": "EXAMPLE-PLUGIN-COMPAT",
    "status": "PROPOSED",
    "repo": "ashlrai/phantom",
    "priority": "P1",
    "tier": "work",
    "min_tier": "work",
    "max_cost_class": "included",
    "needs": ["git", "node"],
    "exclusive": true,
    "deps": [],
    "claims": [],
    "scope": "Qualify the Plugin output contract in Phantom",
    "acceptance": "Producer and consumer receipts agree on the released contract",
    "targets": [
      {
        "id": "plugin",
        "repo": "ashlrai/ashlr-plugin",
        "paths": ["servers/", "docs/"],
        "needs": ["bun"],
        "depends_on": [],
        "acceptance": "Publish a sanctioned artifact with output-contract evidence"
      },
      {
        "id": "phantom",
        "repo": "ashlrai/phantom",
        "paths": ["src/core/run/sandboxed-engine.ts", "test/"],
        "needs": [],
        "depends_on": [{"target": "plugin", "milestone": "released"}],
        "acceptance": "Sidecar smoke passes against that exact Plugin artifact"
      }
    ]
  }]
}
```

Implementation acceptance must cover v1 round-trip, v2 refusal by old readers,
unknown enrollment, private-scope rejection, duplicate/cyclic targets, missing or
wrong-revision receipts, held producers, crash recovery during child creation,
and overlapping claims. A released producer with a failed consumer leaves the
parent incomplete; it does not trigger automatic rollback or publication retries.

## Recommended first shared outcomes

1. **Companion conformance:** Secrets/Locus producers and Phantom/Stack consumers share synthetic refusal/readiness fixtures. Preserve existing custody and identity boundaries; measure repeated integration failures removed.
2. **Context efficiency with correctness:** Core Efficiency → Plugin → Phantom, after any needed enrollment is independently resolved. Extend the existing benchmark PR rather than duplicate it; compare accepted-task cost, not output size alone.
3. **Outcome observability:** Phantom → Pulse with stable repo/job/attempt IDs and explicit evidence coverage. Measure time to an accepted result and repeated-work cost; do not optimize raw PR volume or occupied seats.

These are proposal themes, not new job IDs or launch authority. Respect the
current [holds and Security boundaries](../../AGENTS.md), including held Secrets
and Plugin PRs. No runtime code, enrollment, live queue, workflow, release or
installed machinery changes are part of this survey.
