# Dead code and stale artifact audit

Job: RQ-RETHINK-DEADCODE-1. Observed: 2026-11-13.
Base: `00b72c2ea60de124051bb687a80f94663378d3b5`.

**Deleted 0 files / 0 LOC. PROPOSED: 3 file deletions / 127 LOC.**
This is a documentation-only change. The 161 raw Knip file findings below
are triage input, not 161 approved deletions. No CLI surface changes, Article 2
entries, runtime installations, commits, pushes or publications are included.

## Deletion decision and evidence limits

A deletion requires zero importers, zero test references and a complete Git
history showing more than 90 days without changes. Ambiguous candidates stay
PROPOSED. `docs/AGENTS-MD-AUDIT.md` history and CONTRACT files are excluded.

At the initial scan this worktree was shallow: `git rev-parse --is-shallow-repository` returned
`true`; `git rev-list --count HEAD` returned `11`. The oldest initially visible ancestor
is `e7313a5cddc40d2c92e1ac641fbef05da832c163`, dated
2026-11-13T21:54:36Z. A final history check saw only one visible commit, the unchanged HEAD; each
candidate log then returned that boundary commit. Shared history changed during
the audit. Neither shallow attribution establishes an introduction or last-edit
date. The audit cutoff is 2026-08-15T22:13:47Z, 90 days before the base commit.
No candidate establishes the required age. No history was fetched.

The supplied fleet snapshot contains no matching live dead-code claim or open
PR title. A fresh GitHub query could not run because `gh` was denied access to
its configuration. Duplicate-work checking is limited to that supplied snapshot.

## Method and measured inventory

The scan read tracked files only: 13,006 paths, 12,906 decodable text files
under a 2.5 MB per-file cap, and 6,183 JavaScript/TypeScript files under `src/`,
including colocated tests. No dependency was added to the manifest or lockfile.

```sh
npx --yes knip --version
npx --yes knip --no-progress --reporter json --include files,exports,types,duplicates,unresolved
```

Knip version was **6.45.1**. It completed with exit 1 because it found issues;
stderr was empty. Reproduce with `npx --yes knip@6.45.1` to pin the scanner.
The default project discovery was used, without fixes or production-only mode.

| Knip category | Raw findings |
| --- | ---: |
| Unused files | 161 |
| Unused value exports | 2,126 |
| Unused type exports | 1,970 |
| Duplicate-export groups | 21 |
| Unresolved imports | 4 |

File findings by root: scripts 48, examples 67, src 22, desktop 6,
workplans 6, tools 3, site 3, benchmarks 2, contrib 2, integration 1 and
root coverage config 1. Separate packages, examples and standalone commands
need their own entry-point configuration before these counts imply dead code.

A supplemental TypeScript AST scan visited imports, re-exports, literal dynamic
imports, `require` and `new URL`. It unwrapped casts and parentheses, resolved
ESM `.js` specifiers to source `.ts`/`.tsx` files, and recognized directory
indexes and query suffixes. It resolved 42,677 reference occurrences across
tracked code. These are occurrences, not unique graph edges. Computed paths,
external consumers, Rust includes, HTML assets and Vite globs still need manual
review. A preliminary grep graph was used only to prioritize files by size.

Candidate reference checks searched tracked text for each candidate's distinctive
stem, excluding the candidate itself, and separately classified test references.
References in historical `.bridge-evidence` were not treated as runtime callers.
The raw JSON and temporary audit scripts were kept outside the worktree.

## PROPOSED file deletions

These are the **three** proposed deletions counted in the header. None is
eligible for deletion in this change. LOC means physical source lines.

| Candidate | LOC | Import/URL references | Test references | Evidence and remaining requirement |
| --- | ---: | ---: | ---: | --- |
| `vitest.config.coverage.mjs` | 7 | 0 | 0 | No tracked text references to `vitest.config.coverage`. It selects only the still-existing `test/node-context-coverage-31b3.test.ts`; no coverage setting is present. PROPOSED: retire the standalone config if no external invocation needs it, after complete history proves age. Preserve the test. |
| `scripts/seed-north-star-goals.mjs` | 92 | 0 | 0 | No references outside its own usage comment. Described as a one-time M232 seeder, with obsolete Desktop checkout paths and unconditional goal creation. PROPOSED: remove after proving age and confirming it is no longer an operator entry point. It was read, never executed. |
| `src/web-ui/routes/verse/fleet/RepoRankPanel.tsx` | 28 | 0 | 1 | Component has no importer. `test/web-route-audit-16.test.ts:27` explicitly identifies it as unmounted and records its `/api/repos/rank` query as unserved. PROPOSED: retire the component after resolving that test reference and proving age. The test remains intact. |

The first two paths total 99 LOC and pass the repository-reference checks.
Their age and possible external invocation remain unproved. The third fails the
zero-test-reference rule even before history is considered. Do not delete its
model or backend ranking feature merely because this component is unmounted.

## Findings that must be retained

| Apparent dead artifact | Evidence of use |
| --- | --- |
| `src/cli/manager.ts`, `spec.ts`, `tui.ts`, `vercel.ts` | Knip marks these unused, but `src/cli/index.ts` imports them through cast string literals in `lazyCmd`, then invokes their commands from dispatch cases. |
| `src/cli/skills-audit-process.ts` | `src/cli/skills.ts:25` constructs the worker filename with the selected extension and launches it as a child process. |
| `src/cli/coding-cost-feed.ts` | Standalone adapter documented in `docs/router/README.md` and `docs/llms.txt`; lack of main-switch dispatch is insufficient for deletion. |
| `src/core/verse/computer-api.ts` | `src/core/verse/verse-api.ts:534` loads it with a cast dynamic import. `workbench-types.ts` also registers its module path. |
| Resource and Verse worker entry points | `engineering-background.ts`, `quota-evidence-background.ts`, `fleet-history.ts` and `outcomes-io.ts` construct worker URLs. `scripts/build-sea.mjs` and `test/build-sea-worker.test.ts` preserve their binary packaging. |
| `*.pane.tsx` and browser `register.ts` | `src/web-ui/routes/verse/panes/index.ts:29,39` eagerly discovers these with Vite globs. Static-importer absence is expected. |
| Raycast command files | `src/raycast/package.json` registers the seven command names. These belong to a separately built extension. |
| `src/core/web/public/app.js` | Loaded by the script tag in `src/core/web/public/index.html:718`. Zero ESM importers does not establish an unused browser asset. |
| `src/web-ui/public/verse-m/sw.js` | Public service-worker asset. Investigate registration, copied output and client upgrade behavior before considering removal. |
| `scripts/build-preparation-*.d.mts` | Declaration sidecars have matching `.mjs` implementations. TypeScript can select them implicitly without a textual reference to the declaration filename. |
| Four unresolved evaluator imports | `scripts/evaluators/preparation-score.mjs` references three generated measurement modules; `preparation-workload.mjs` references generated fixtures. `scripts/build-preparation-score.mjs` and `build-preparation-builtin.mjs` produce those modules. Source absence is not a deleted dependency. |

## God files and overlapping implementations

Line counts below are physical lines. Importer counts are distinct files from
the preliminary literal import/re-export graph, including tests; they are lower
bounds because cast and computed imports were handled separately later.

| File | LOC | Importers | Test importers | Follow-up |
| --- | ---: | ---: | ---: | --- |
| `src/core/daemon/loop.ts` | 11,567 | 45 | 40 | Extract bounded tick phases behind the existing phase ledger and authority boundaries. |
| `src/core/web/public/app.js` | 7,905 | 0 | 0 | Inventory served legacy views before changing browser assets. HTML is a caller. |
| `src/core/fleet/status.ts` | 7,801 | 34 | 18 | Separate data collection from projection/formatting without duplicating collectors. |
| `src/core/inbox/merge.ts` | 5,423 | 62 | 51 | Separate merge orchestration from evidence assembly while preserving authorization. |
| `src/core/run/orchestrator.ts` | 4,743 | 56 | 36 | Extract planning and execution phases behind current tests. |
| `src/core/run/sandboxed-engine.ts` | 4,525 | 58 | 41 | Separate process lifecycle from result parsing. |
| `src/cli/index.ts` | 3,321 | 2 | 1 | Keep registry and dispatch parity when extracting command groups. |

An exact duplicated component was confirmed separately:
`src/web-ui/routes/verse/SidebarResources.tsx:123` defines the same 14-line
`function SpendDown()` as `resources/SpendDown.tsx:8`. The trimmed function texts
have matching SHA-256
`e75065bb898ca2c4f3c3094d16686788e4ada53c77e38cb0e19e89f126f8bd94`.
The parent also imports `SpendDown` at line 10, producing the TS2440 failure
below. PROPOSED block cleanup: keep the extracted component and remove the
local duplicate and newly unused imports, with existing component tests. This
is a block-level follow-up, not another whole-file deletion in the header count.

No byte-identical non-test implementation files larger than 100 bytes were
found under `src/` using SHA-256 grouping. This does not rule out copied blocks
or behaviorally equivalent implementations. Knip's 21 duplicate-export groups
include aliases such as `VerseApp = PhantomApp` and named/default component
exports; they are not evidence of 21 duplicated implementations.

The comms/queue/router overlap review found active consumers, not superseded
whole files:

| Implementations | Distinct responsibilities and evidence |
| --- | --- |
| `src/core/queue/schema.ts` and `src/core/drive/queue-v1.ts` | Canonical document uses `schema: 'queue.v1'` and READY/CLAIMED/etc. The drive module projects that document into scheduling jobs. It has four literal importers, three tests. PROPOSED consolidation: derive the projection input type from the canonical schema, preserving its intentionally narrower view. |
| `src/core/drive/nodes/queue-v1.ts` and `nodes/router.ts` | Node queue uses `version: 'queue.v1'`, pending/running/completed and fenced claims, unlike the fleet document's `schema` discriminator. Three importers each; router has a test importer. PROPOSED: disambiguate protocol names in documentation before any shared-type migration. |
| `src/core/fleet/router-queue.ts` | Trusted bridge follow-up/recut queue, with 11 literal importers including nine tests. It is not interchangeable with the node lease queue. |
| `src/core/run/router.ts`, `src/core/routing/router.ts`, `src/core/fleet/router.ts` | Task/model/cascade selection, capacity-seat ranking, and fleet backend/repair routing respectively. Literal importer counts are 23, 33 and 29. PROPOSED: inventory duplicated eligibility policy, with parity fixtures, before extracting shared policy. |
| `src/core/comms/requests.ts`, `owner-thread.ts`, `unified-inbox.ts` | Pending request lifecycle, ordered owner conversation/delivery, and read-only aggregation of six inbox sources. Literal importer counts are 21, 36 and 13. Combining their stores would change semantics. |
| `src/core/comms/migrations.ts` | Still called from `comms/dispatch.ts`; CLI imports its legacy-kind constant. A one-time migration is not dead while older installations may still upgrade. |

These consolidation ideas are separate from the three proposed file deletions;
no queue, router, comms or authority implementation was edited.

## Stale documentation and doc-facts coverage

All **263** tracked `docs/*.md` files were scanned for CLI examples and literal
source paths. `test/doc-facts.test.ts` explicitly lists 12 documents, only eight
of which are top-level `docs/*.md`: **255 top-level guides are outside its
command/verb/flag checks**. Its npm-script check covers only four entry-point
files. It does not validate source-module paths. Link validation in
`scripts/check-documentation.mjs` has a different scope and cannot prove that
inline command examples exist.

Three unknown top-level commands were found with the same inline/fenced-line
extraction shape as doc-facts, then checked against actual dispatch:

| Location | Classification | Proposed action |
| --- | --- | --- |
| `docs/VERSE-TELEMETRY-V2.md:117` | `ashlr resource-console` is not dispatched. The historical telemetry note describes a separate collector process in current-tense operational instructions. | Label the September observation as historical and point current operation to the resource/Verse guides after checking collector behavior. Do not invent an equivalent command. |
| `docs/SPEC-V3-TEAM.md:114` | `ashlr sync` is not dispatched. The document explicitly says NOT BUILT. | Preserve design history; exclude proposed command examples explicitly if doc-facts is expanded. |
| `docs/RESIDENT-RUNTIME.md:36` | `ashlr activation ...` is absent, but the paragraph explicitly documents that command's deletion. | Preserve the historical explanation. A blind global command check would be wrong here. |

Additional module-path findings:

- `docs/PLUGIN-LEVERAGE-PLAN.md:162,172` names absent
  `src/core/fleet/supervisor.ts`. The actual drive supervisor is under
  `src/core/drive/`; the planned integration must be re-evaluated before
  changing a path. Proposed new files elsewhere in that plan are not dead code.
- `docs/SPEC-ELITE-ENGINE-UTILIZATION.md:122,221` describes absent
  `src/core/run/merge-gate.ts` as an existing authority boundary. Mark the claim
  historical and re-establish the current boundary from actual merge code.
  The spec's design status does not make that current-state assertion accurate.
- `docs/ECOSYSTEM-MAP.md` and `docs/REVIEW-FINDINGS.md` intentionally discuss
  other repositories. Example paths in `ASHLR-UNIVERSE.md`, `PLUGINS.md` and
  `VERSE.md` are illustrative. They were not counted as removed Phantom modules.
- `docs/intent-preservation-4235.md` explicitly compares historical PR source
  with the unified `fleet intent` implementation. Preserve those absent-path
  references as evidence, like the protected audit and CONTRACT history.

PROPOSED coverage work: extend doc-facts with a curated list of current operator
guides and explicit historical/design exclusions. Include per-command verb and
flag checks; the existing global flag set can accept a flag belonging to a
different command. Do not simply add all design specs to the existing allowlist.

## Orphaned tests

The AST scan found **zero unresolved literal import/re-export/require targets in
test files**, after ESM source resolution and cast unwrapping. Missing URL paths
were reviewed separately: compiled `dist/` output, the optional custody helper,
intentionally absent fixtures, and URLs whose base is a source-module URL rather
than the test's directory. These are not established orphaned tests.

`test/m518.goal-conductor-permit-operator.test.ts:907` checks that the removed
`src/cli/activation.ts` **does not exist**. It is an active security regression
test and must remain. `test/node-context-coverage-31b3.test.ts` still exists;
the proposed standalone config deletion does not imply deleting that test.
Computed imports and dynamically assembled `readFile` paths remain a limitation.
No test was changed, skipped, weakened or deleted.

## Npm scripts and CLI dispatch

All **48** root npm scripts were inspected. All 36 direct Node/tsx entry targets
and the 19 explicit `node --test` files exist. Every nested `npm run` script name
resolves. No dead root npm script was established.

A literal `npm run <name>` reference search initially missed `prepack` and
`bench:memory:embed`. `prepack` is a packaging lifecycle hook and is discussed
by CI packaging code. The embedding benchmark uses `npm run --silent` in its
own usage text and is imported by `test/memory-embeddings.test.ts`. Keep both.

All **97** `lazyCmd` loader declarations in `src/cli/index.ts` have another
identifier reference. This is a reachability screen, not proof of behavior.
Knip flags 29 value exports and seven type exports in CLI modules; examples
include usage constants and test seams. No CLI export was removed without
checking callers and external compatibility. Public package exports from
`src/api/` also remain supported entry points despite no repository importers.

## Runtime scripts: report only

The committed `fleet/manifest.json` contains **30** machinery entries:
11 managed, seven manual and 12 pinned. In particular, `router.py` and
`router_queue.py` are pinned ops-side scripts; the manifest describes
`contrib/router` as a successor, not evidence that the live scripts are unused.

A metadata-only attempt to list `~/.ashlr-runs/bin` was denied with
`PermissionError`. Therefore live script counts, ages, references, launchd
consumers and deadness are **unknown**. No live script contents were read and no
live file or LaunchAgent was changed. No installation or sync apply was run.
The release autorun/signing scripts, publish wrapper, secret gate and dispatcher
remain outside deletion scope. A future runtime audit needs authorized metadata
and caller/launchd evidence, followed by the required Security pin process.

## Verification discoveries and proposed repairs

The audit's existing checks exposed four additional problems. They are repair
proposals, not deletion candidates and not changes in this patch:

- `src/cli/index.ts:2625` dispatches `ideas`, but
  `src/cli/completions.ts` and `src/cli/help.ts` lack its registry/description.
  Three `cli-registry-drift.test.ts` assertions fail. PROPOSED: add accurate
  completion/help metadata with the required Article 2 record in a CLI change.
- `docs/README.md:347,349` links `DONE-CONTRACT.md` and `TIER1-WHY.md` locally,
  but neither file is in the curated `package.json` payload. Four
  `documentation-navigation.test.ts` assertions fail in package mode while
  source docs validation passes. PROPOSED: use source-only links or explicitly
  curate the guides after reviewing their packaged dependencies. Preserve
  the contract itself and the existing tests.
- Full web typecheck reports TS2440 in
  `src/web-ui/routes/verse/SidebarResources.tsx:10`: imported `SpendDown`
  conflicts with a local declaration. PROPOSED: resolve the declaration conflict
  in a focused web change.

- Full lint reports three `no-control-regex` errors in
  `test/leader-reply-clean-original-238s.test.ts:74,99` and
  `test/leader-status-reply.test.ts:44`, plus 268 warnings. PROPOSED: correct the
  escape-sequence matching expressions without removing their regression checks.

These files and test inputs are byte-for-byte unchanged from HEAD, verified
with `git diff --exit-code HEAD -- <paths>`. New audit documents are the only
worktree changes. The failures are in existing source/packaging inputs.

## Verification

`node scripts/verify-changed.mjs` ran once in the foreground and exited 0.
It passed backend TypeScript and both lane/I/O guards, skipped ESLint because
its installed CLI module was missing, and skipped web typechecking because no
web source changed. Its unchanged-real-I/O-membership warnings are retained in
the handoff notes.

`npm run check:docs` passed with zero errors and zero external requests. An
explicit `checkDocumentation` call for this report also passed. The affected
Vitest selection ran with a temporary HOME: **44 passed, seven failed, 51 total**
across four suites. Doc-facts and web-route-audit passed; CLI registry and
packaged documentation navigation failed as described above.

The initial full lint and typecheck attempts could not start because local
ESLint was incomplete and `tsgo` was missing. `npm run install:worktree` then
succeeded using pnpm 10.28.2 and both sanctioned dependency/cache healing steps.
The repeated full typecheck passed the backend and failed on the existing web
`SpendDown` conflict. Full lint completed with exit 1: three existing regex-rule errors and 268
warnings. Exact commands are recorded in `BRIDGE_NOTES.md`. No test or security control was changed to hide failures.
