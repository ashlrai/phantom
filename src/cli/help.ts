/**
 * cli/help.ts — agent-facing docs surface (M31).
 *
 * `ashlr docs --agent [--json]` emits a compact, llms.txt-style cheat sheet of
 * the agent-relevant commands: what each does, its safety class, the --json
 * contract, and exit-code discipline. Generated from AGENT_COMMANDS so the
 * docs can never drift from one source of truth.
 *
 * `claudeMdSnippet()` renders a ready-to-paste CLAUDE.md block teaching agents
 * the CLI-first usage (consumed by `ashlr wire --claude-md`).
 *
 * Safety classes mirror CONTRACT-M31:
 *   read       — inspection-oriented; consult the command's actual effects.
 *   append     — writes or executes work; not an append-only storage guarantee.
 *   proposal   — creates a PENDING inbox proposal; never applies anything.
 *   human-gate — listed for awareness only; agents must NOT run it.
 */

import { makeColors, isTty, pad } from './ui.js';
import { BACKLOG_SOURCE_FILTER_HELP } from './backlog.js';

export type AgentSafety = 'read' | 'append' | 'proposal' | 'human-gate';

export interface AgentCommandDoc {
  /** Invocation shape, e.g. `ashlr ask "<question>" --json`. */
  usage: string;
  /** One-line purpose. */
  description: string;
  /** Safety classification (CONTRACT-M31). */
  safety: AgentSafety;
  /** Name of the command's --json output type, or a short shape note. */
  jsonShape: string;
}

/**
 * Selected agent-relevant commands, not an exhaustive permission registry.
 * Preserve the legacy safety vocabulary for consumers; descriptions document
 * actual effects and command-specific result/exit semantics.
 */
export const AGENT_COMMANDS: AgentCommandDoc[] = [
  {
    usage: 'phm constitution check [--root <repo>] [--json] [prompt-or-template-path ...]',
    description: 'Validate constitution rule IDs and prompt/template references. Read-only; exit 0 valid, 1 invalid or unreadable input, 2 bad usage.',
    safety: 'read',
    jsonShape: '{ ok, ruleCount, referenceCount, filesChecked, diagnostics: [{ path, line, id, kind }] }',
  },
  { usage: 'phm check [--base <ref>] [--json]', description: 'In the Phantom repository, run incremental typechecks, cached lint and affected tests concurrently. Development feedback only; run the gate for release checks.', safety: 'append', jsonShape: '{ok, mode, base, durationMs, steps}' },
  { usage: 'phm tune prepare <reviewed-samples.jsonl> <new-output-directory> <scrub.pl> | evaluate <paired-report.json>', description: 'Prepare scrub-gated local-model datasets or assess paired evaluation evidence; never train or activate a lane.', safety: 'append', jsonShape: 'Dataset counts/hashed task IDs or paired evaluation decision' },
  {
    usage: 'phm connectors list|show <id> [--json]',
    description: 'Read validated connector metadata from ~/.phantom/connectors/profile.toml. Credential names only; never resolves secrets. Exit 0 success, 2 invalid profile/usage.',
    safety: 'read',
    jsonShape: 'ConnectorProfile {version:1, connectors[]} | {connector}',
  },
  {
    usage: 'phm connectors add <id> --kind <kind> [--command <executable>|--url <url>] [--arg <argument>] [--scope <scope>] [--tool <tool>] [--lane <lane>] [--credential <binding=vault-name>] [--json] | phm connectors remove <id> [--json] | phm connectors import [--json]',
    description: 'Write metadata only. Import projects safe client names/endpoints; withholds credential-bearing entries and reports skipped Codex lanes. Never reads ~/.codex. Exit 0 success, 1 partial import, 2 invalid input/IO.',
    safety: 'append',
    jsonShape: '{ok, connector? , removed?} | {imported, skipped} | {ok:false,error}',
  },
  {
    usage: 'phm capacity publish [--json]',
    description: 'Publish local subscription usage metadata once using this node’s local auth. Exit 0 fresh/published, 1 unavailable, 2 bad usage/configuration. No model execution.',
    safety: 'append',
    jsonShape: 'PublisherStatus {state,reason,lastPublishedAt}',
  },
  {
    usage: 'phm graph nodes|edges|status [--json]',
    description: 'Read-only GRAPH-1 nodes, edges, and availability. Exit 0 success/help, 1 unavailable or loader failure, 2 bad usage; unavailable counts are unknown.',
    safety: 'read',
    jsonShape: '{schemaVersion:1, command, status:"ready", nodes|edges|counts} | {schemaVersion:1, command, status:"unavailable"|"error", error:{code,message}}',
  },
  { usage: 'phm chain verify [--json]', description: 'Exercise synthetic in-memory chain paths; never sends or checks live transport. Exit 0 pass, 1 failure, 2 usage.', safety: 'read', jsonShape: 'phantom.chain.verify.v1; per-link status and latency' },
  { usage: 'phm fleet deploy-plan --since <sha> [--repo <path>] [--bin <path>] [--json]', description: 'Find committed fleet scripts without matching live copies. Read-only; pinned or unknown files need Security review. Exit 0 compared, 1 unreadable live file, 2 invalid input or unavailable evidence.', safety: 'read', jsonShape: 'FleetDeployPlan {schema:fleet.deploy-plan.v1,since,head,checked,inSync,files:[{repoPath,livePath,repoSha256,liveSha256,shaPinned,status,action}]} | {schema,error}' },
  { usage: 'phm fleet restock plan [--json]', description: 'Check READY candidates before grouping 6–10 items per repo. Read-only; exclusions and small groups remain visible.', safety: 'read', jsonShape: 'RestockPlan {schema:fleet.restock-plan.v1,jobs,excluded,held,invalid}' },
  { usage: 'phm route explain [--json]', description: 'Read persisted dispatcher pools and accepted route moves in the trailing hour.', safety: 'read', jsonShape: '{available, route-moves-per-hour: number|null, lines}' },
  { usage: 'ashlr router rank --tier <local|mid|frontier> [--routes FILE] [--slots pool=count ...] [--json]', description: 'Rank eligible lanes by forecast exhaustion, then nearest reset; missing slots or budgets exclude a lane. No dispatch or state writes.', safety: 'read', jsonShape: '{ schema: fleet.lane-rank.v1, tier, lanes: RankedLane[] }' },
  { usage: 'phm router-calibration --jobs <jobs.jsonl> [--posthog <runs.json>] [--json]', description: 'Compare recorded router predictions with matched outcomes and usage offline.', safety: 'read', jsonShape: 'CalibrationReport (schemaVersion 1)' },
  {
    usage: 'phm context --for-agent <lane> --json',
    description: 'Compact under-4KB brief for one lane from the world model, roster claims, open pulls, bottlenecks, blind spots, and that lane pacing. Read-only. Exit 0 brief, 2 bad usage.',
    safety: 'read',
    jsonShape: 'ashlr.context-brief/v1',
  },
  {
    usage: 'phm claim acquire <work-key> --lane <lane> [--repo owner/name] [--pr N] [--branch NAME] [--pulls <file>] --json | phm claim release <work-key> --lane <lane> --reason open|merge|abandon --json',
    description: 'Claim a work key before starting. Refuses a live claim or an open pull on that key and returns the holder. Release on pull open, merge, or abandon. Grants no execution authority.',
    safety: 'append',
    jsonShape: 'ashlr.work-claim/v1',
  },
  {
    usage: 'phm growth [--json] [--range 1H|1D|1W|1M] [--prs <file>]',
    description: 'Read the Growth chart series. Each series comes from a local ledger. A missing source is no-data-source and a world-model blind spot. Exit 0 report, 1 unreadable pull file, 2 bad usage.',
    safety: 'read',
    jsonShape: 'growth.series.v1',
  },
  {
    usage: 'phm world [--json] [--refresh] | phm world get <path> [--json]',
    description: 'Read the cached ashlr.world-model/v1 snapshot. blindSpots lists each unknown field by path with a stable id. Unknown is never zero. Exit 0 snapshot, 2 bad usage.',
    safety: 'read',
    jsonShape: 'ashlr.world-model/v1 | one dotted path node',
  },
  {
    usage: 'phm observe [--json] | phm observe session <id> [--json]',
    description: 'Read-only human observe snapshot. Sensor headroom null, stale readings, and unreachable resources stay unknown and are never counted as idle. Exit 0 snapshot, 1 unreadable pull file, 2 bad usage.',
    safety: 'read',
    jsonShape: 'observe.human.v1 | session detail',
  },
  {
    usage: 'phm wb secrets [--json]',
    description: 'Read Phantom Secrets custody metadata only: names, scope, age and last rotation. Exit 1 when unavailable; never reveals values.',
    safety: 'read',
    jsonShape: '{ v: 1, state: ok|unknown, secrets: SecretCustody[] }',
  },
  {
    usage: 'phm wb steer --text <note> [--apply] [--json]',
    description: 'Append a steer note to the leaders\' inbox — the same steer.note the workbench action API runs. Dry run unless --apply. Exit 0 accepted, 1 operational, 2 usage/invalid.',
    safety: 'append',
    jsonShape: '{ v: 1, dryRun, action, outcome, at, id, bytes } | { v: 1, dryRun, error }',
  },
  {
    usage: 'phm wb reprioritize <job-id> --priority P0|P1|P2|P3 [--apply] [--json]',
    description: 'Re-priority one unclaimed queue.v1 line (READY or HOLD) — the same queue.reprioritize the workbench action API runs. Dry run unless --apply. Exit 0 changed, 1 operational, 2 usage/invalid.',
    safety: 'append',
    jsonShape: '{ v: 1, dryRun, action, outcome, job, from, to } | { v: 1, dryRun, error }',
  },
  {
    usage: 'phm wb stop <job-id> [--apply] [--json]',
    description: 'SIGTERM then SIGKILL every process carrying the job id on token boundaries — the same job.stop the workbench action API runs, audited to queue/job-stops.jsonl before the first signal. Dry run lists the matched pids only. Exit 0, 1 operational, 2 usage/invalid.',
    safety: 'append',
    jsonShape: '{ v: 1, dryRun, action, outcome, job, pids } | { v: 1, dryRun, error }',
  },
  {
    usage: 'phm budget show [--json]',
    description: 'Read per-pool budget buckets, burn rates, resets and provenance. Unknown is never zero.',
    safety: 'read',
    jsonShape: '{ budgets: PoolBudgetSnapshot }',
  },
  {
    usage: 'phm budget add <pool> --bucket <bucket> --remaining N [--reset-at UTC] [--at UTC] [--json]',
    description: 'Append a manual reading, or import counts and times with --source cli|log --input <file|->. Manual readings override automatic readings until reset.',
    safety: 'append',
    jsonShape: '{ budgets: PoolBudgetSnapshot }',
  },
  {
    usage: 'phm resource --json [--directory <fleet-directory>]',
    description: 'Refresh the shared resource projection in fleet.json from recorded usage and machine telemetry; no provider calls or dispatch.',
    safety: 'append',
    jsonShape: 'resource.v1; missing or stale inputs have null measurements and unknown status',
  },
  {
    usage: 'ashlr fleet queue merged|read|complete <job-id> [--json]',
    description: 'Trusted bridge router handoff: merged reads verified metadata from stdin; read emits untrusted model prompts and audits queue changes; complete acknowledges work. Requires an operator-owned seven-repo allowlist.',
    safety: 'append',
    jsonShape: 'Merge: {status,jobId}; read: {v:1,jobs:[{jobId,repo,prompt}]}; complete: {status,jobId}; errors exit 1, usage exit 2',
  },
  { usage: 'phm jobs empty [--since 24h] [--json]', description: 'Explain empty jobs from local notes and logs.', safety: 'read', jsonShape: 'jobs.empty.v1 {hours,total,counts,jobs}' },
  {
    usage: 'phm metrics ingest --jobs <jobs.jsonl> --status <status.json> [--json]',
    description: 'Read local job snapshots into deterministic lane and tier metrics and advisory priors. No network, writes or operational steering.',
    safety: 'read',
    jsonShape: 'MetricsFeed (schemaVersion 1); unknown measurements are null; refused input exits 2',
  },
  {
    usage: 'phm node bootstrap --dry-run [--json]',
    description: 'Print persistent Linux node setup and future registry lease steps; no provisioning or registry calls. Exit 0 plan, 2 bad usage.',
    safety: 'read',
    jsonShape: 'schemaVersion 1; dryRun=true, executable=false, registry.status=stub, steps',
  },
  {
    usage: 'phm node join|beat|enqueue|plan|pull|renew|complete|list|status|leave|pool|watch|worker|rpc [flags] [--json]',
    description: 'Node router: nodes advertise caps and live usage, jobs carry an owner scope and a fenced lease so no job runs twice. A node only sees and pulls jobs of its own owner scopes; auth stays local to each node. Exit 0 ok, 1 lease/session lost or store unavailable, 2 bad usage; errors include a Fix.',
    safety: 'append',
    jsonShape: '{schemaVersion:1, command, ...result} | {schemaVersion:1, command, error:{code,message,fix}}',
  },
  {
    usage: 'phm metrics levers [--window <7d|30d>] [--json]',
    description: 'Rank three opportunity proxies from local activity and fleet rollups.',
    safety: 'read',
    jsonShape: 'schemaVersion 1; unavailable scores are null',
  },
  {
    usage: 'phm companions [--json] [--root <install-root>] [--bin-dir <dir>]',
    description: 'Separate companion executable inventory using scrubbed version/help probes only; installed is not bundled or runtime-ready. Exit 0 reports inventory, including missing/incompatible tools; 2 bad usage.',
    safety: 'read',
    jsonShape: 'CompanionInventory (schemaVersion 1); no credential, trust, MCP or service inspection',
  },
  {
    usage: 'phm verify change --worktree <path> [--checks typecheck,unit,lint,secrets]',
    description: 'Execute trusted repository checks. JSON on stdout, ten-line handoff on stderr; child output withheld. Exit 0 pass, 1 failed, 2 usage.',
    safety: 'append',
    jsonShape: '{pass,checks:[{name,ok,secs,first_error}],changed_files}',
  },
  {
    usage: 'phm engineering-receipt --events <file.jsonl> [--claims <file>] [--task <text>] [--json]',
    description: 'Engineering receipt from recorded tool events only: Evidence plus model Claims, unsupported claims flagged UNVERIFIED, no-check-after-edit flagged. Requires PHANTOM_RECEIPTS=1; read-only, secrets scrubbed.',
    safety: 'read',
    jsonShape: '{task,evidence:{commitSha,typecheck,suites,integration,build,deploy,verificationScope,edits,noCheckAfterEdit},claims:[{text,kind,status,reason}]}',
  },
  {
    usage: 'ashlr verify-pr <owner/repo> <PR> --confirm-head <SHA> [--json]',
    description: 'Host-owned maintainer PR intake: authenticates the caller, runs base-derived checks confined on the exact tree and posts the ruleset-bound App check. Does not merge or deploy; saved receipts never authorize a check.',
    safety: 'append',
    jsonShape: 'MaintainerVerificationResult; exit 0 verified, 1 withheld, 2 usage',
  },
  {
    usage: 'ashlr benchmark --compare-reports BASELINE.json CANDIDATE.json',
    description: 'Compare compatible recorded local-eval receipts offline. Descriptive measurements, no runtime or provider calls, no universal savings claim.',
    safety: 'read',
    jsonShape: 'PairedReceiptComparison; refused comparisons exit 2',
  },
  {
    usage: 'ashlr benchmark run [--task ID] [--trials N] [--concurrency N] [--out FILE]',
    description: 'Explicit agent/model execution using the existing local-eval runner and real checker exits; writes private artifacts. No dispatch, merge or new adoption gate.',
    safety: 'append',
    jsonShape: 'EvalReport at --out or the private artifact root; failed trials exit 1',
  },
  {
    usage: 'ashlr openai-agents sessions|inspect|turns [session-id] [--limit 1..100] [--after <id>] --json',
    description: 'Read bounded managed OpenAI Agents API metadata using host-held API authentication. Separate from subscription access; no execution qualification or session mutations.',
    safety: 'read',
    jsonShape: '{readOnly:true, executionQualified:false, result:metadata|page}; page={data,hasMore,nextCursor}',
  },
  {
    usage: 'ashlr agents bus channels list|test <id> [--json]',
    description: 'List registered channel adapters. bus and handoff probes write one local envelope; other channels stay refused. No network.',
    safety: 'append',
    jsonShape: '{dryRun, channels:[{id, adapterRegistered, healthy}]} | {id, dryRun, status, reason}',
  },
  {
    usage: 'ashlr agents bus contract [--json]',
    description: 'Print the Agent Bus v2 contract version, providers, body kinds, work statuses and claim key forms. Read-only; claims coordinate and grant no execution authority.',
    safety: 'read',
    jsonShape: '{schemaVersion, providers[], wakeKinds[], bodyKinds[], workStatuses[], claimKeyForms[], claimLeaseMs:{min,max}, claimsGrantExecutionAuthority:false}',
  },
  {
    usage: 'ashlr agents roster [--json]',
    description: 'Unified live session roster across Phantom jobs, Devin cloud, Devin Desktop, Codex, Claude, Cursor, Grok, Ollama and oMLX. Each probe times out in about 5s and degrades to unknown. Read-only; no secrets.',
    safety: 'read',
    jsonShape: 'agent-roster.v1 {schema, observedAt, latencyMs, sources[{source, ok, availability, sessions, error, observedAt, truncated}], sessions[], claims}',
  },
  {
    usage: 'ashlr runtime status --store <absolute> --json',
    description: 'Verify the explicitly selected local candidate and rollback slot without installing, publishing, or starting services.',
    safety: 'read',
    jsonShape: 'LocalRuntimeStatus',
  },
  {
    usage: 'ashlr runtime run --store <absolute> -- universe status --root <absolute> --json',
    description: 'Read an explicit Universe store through the exact installed candidate and Node interpreter. No source-checkout fallback.',
    safety: 'read',
    jsonShape: 'UniverseOverview from the selected installed candidate',
  },
  {
    usage: 'ashlr universe console --root <absolute> [--port N] --json',
    description: 'Start a foreground, read-only loopback console scoped to one explicit Universe root. No general dashboard, provider calls, execution, or service activation.',
    safety: 'read',
    jsonShape: 'One startup record: {schemaVersion:1, mode:"universe", root, readOnly:true, url, consoleUrl, port, readToken, readTokenHeader}',
  },
  {
    usage: 'ashlr universe status [id] [--root <path>] --json',
    description: 'Read local experiments, raw measurements, lineage, and per-niche winning artifacts. No provider calls.',
    safety: 'read',
    jsonShape: 'UniverseOverview',
  },
  {
    usage: 'ashlr universe graph <id> [--node <node-id> --direction ancestors|descendants --depth N] [--root <path>] --json',
    description: 'Read recorded experiment lineage and evidence relationships; optionally traverse one node. No provider calls, execution, or delivery.',
    safety: 'read',
    jsonShape: 'UniverseGraph | {graph: UniverseGraph, traversal: UniverseGraphTraversal}',
  },
  {
    usage: 'ashlr universe compare <baseline> <challenger> [--root <path>] --json',
    description: 'Read matched campaign outcomes, model-token coverage, recorded time, and local delivery evidence. No provider calls or execution; not accepted production changes.',
    safety: 'read',
    jsonShape: 'UniverseCampaignComparison',
  },
  {
    usage: 'ashlr universe preparation-measurement --input <absolute-report.json> --json',
    description: 'Read one explicit installed preparation measurement report, including workload version and separate during-call qualification status/counts. Diagnostic only: reported checks are not a score or acceptance evidence; unknown totals stay unknown, blob counts are subsets, and fixture groups are separate. No store discovery, execution or provider calls.',
    safety: 'read',
    jsonShape: '{schemaVersion:1,kind:"preparation-measurement-summary",scope:"diagnostic-only",...PreparationMeasurementSummary}',
  },
  {
    usage: 'ashlr universe preparation-measurement-calibrate <id> --root <absolute> --capture <id1> --capture <id2> --capture <id3> --expected-source-digest <sha256> --json',
    description: 'Read three settled captures and their frozen seed to emit a repeatable diagnostic calibration. No execution, installed scoring authority or acceptance.',
    safety: 'read',
    jsonShape: 'PreparationMeasurementCalibration',
  },
  {
    usage: 'ashlr universe preparation-measurement-compare <id> --root <absolute> --capture <id> --calibration <absolute-json> --json',
    description: 'Compare retained candidate evidence to caller-supplied calibration after workload and full artifact scope checks. No scoring, selection, execution or delivery.',
    safety: 'read',
    jsonShape: 'CapturedPreparationMeasurementComparison',
  },
  {
    usage: 'ashlr universe portfolio plan --manifest <file.json> [--root <path>] --json',
    description: 'Read explicit campaign dependencies, ordering frontier, blocker roots, structural layers and downstream impact without execution. Observation only; not worker or delivery readiness, and declared priority is unchanged.',
    safety: 'read',
    jsonShape: 'UniversePortfolioPlan',
  },
  {
    usage: 'ashlr universe integration plan --manifest <private-absolute.json> [--root <absolute>] --json',
    description: 'Inspect pinned same-repository delivery composition, exact path scope and conflicts. Structural plan only; no execution, Git writes, combined evaluation or acceptance.',
    safety: 'read',
    jsonShape: 'UniverseIntegrationPlan',
  },
  {
    usage: 'ashlr universe integration evaluate --manifest <private-absolute.json> [--root <absolute>] --json',
    description: 'Materialize an explicitly pinned composition and run one fixed local evaluator under the acceptance Universe execution lease. Retains private intent, artifact and result; no models, elite selection, Git publication or deployment.',
    safety: 'append',
    jsonShape: 'UniverseIntegrationEvaluationResult',
  },
  {
    usage: 'ashlr universe integration inspect --manifest <private-absolute.json> [--root <absolute>] --json',
    description: 'Read an existing verified evaluation and its result digest. Missing evidence never launches an evaluator; no local or Git writes.',
    safety: 'read',
    jsonShape: 'UniverseIntegrationEvaluationEvidence',
  },
  {
    usage: 'ashlr universe integration deliver --manifest <private-absolute.json> [--root <absolute>] --json',
    description: 'Deliver a digest-pinned passing combined evaluation to an explicit new local codex/ branch. Retains private delivery evidence; no evaluator rerun, checkout, push, merge, provider call or deployment.',
    safety: 'append',
    jsonShape: 'UniverseIntegrationDeliveryReceipt',
  },
  {
    usage: 'ashlr universe integration inspect-delivery --manifest <private-absolute.json> [--root <absolute>] --json',
    description: 'Read a completed combined delivery and its exact receipt digest. Missing or pending evidence never creates or reconciles a branch.',
    safety: 'read',
    jsonShape: 'UniverseIntegrationDeliveryEvidence',
  },
  {
    usage: 'ashlr universe integration handoff --manifest <private-absolute.json> [--root <absolute>] --json',
    description: 'Register an explicitly defined new downstream experiment from a digest-pinned delivered combined commit. Records source lineage with a fresh comparator; does not inherit scores, execute models, alter branches, or enroll campaigns.',
    safety: 'append',
    jsonShape: 'UniverseIntegrationHandoffReceipt',
  },
  {
    usage: 'ashlr universe portfolio run --manifest <file.json> [--root <path>] [--resource-runtime <private-absolute.json>] [--delivery-plan <private-absolute.json>] --json',
    description: 'Run declared campaign dependencies with optional resource workers and explicit local Git delivery prerequisites; preserve shared pool limits and campaign budgets. Foreground only; no daemon, artifact transfer, merge, or deployment.',
    safety: 'append',
    jsonShape: 'UniversePortfolioResult',
  },
  {
    usage: 'ashlr universe controller run --manifest <private-absolute.json> [--root <absolute>] [--resource-runtime <private-absolute.json>] [--delivery-plan <private-absolute.json>] --json',
    description: 'Run a checkpointed campaign DAG with one persisted deadline. Recover proven dispatch-attributed completed calls and existing delivery receipts without replaying workers. Preserve declared priority and account admission; uncertain dispatches are not retried. No resident service or implicit campaign discovery.',
    safety: 'append',
    jsonShape: 'UniversePortfolioControllerReport',
  },
  {
    usage: 'ashlr universe controller status <id> [--root <absolute>] --json',
    description: 'Read persisted controller outcomes and deadline without creating storage, executing work, or reconciling uncertain dispatches. In-flight means no recorded settlement, not verified liveness.',
    safety: 'read',
    jsonShape: 'UniversePortfolioControllerReport',
  },
  {
    usage: 'ashlr universe run <id> [--root <path>] [--resource-runtime <private-absolute.json>] --json',
    description: 'Execute one budgeted generation and fixed evaluation. Command subprocesses deny network; local-chat uses its declared loopback endpoint. Resource-pool generation requires an explicit private runtime, repeats admission checks and can consume provider/model usage. No merge or deploy.',
    safety: 'append',
    jsonShape: 'UniverseRun',
  },
  {
    usage: 'ashlr universe campaign init --manifest <file.json> [--root <path>] --json',
    description: 'Register a bounded campaign for an existing universe in the selected local store. Writes campaign state but does not execute workers; the manifest fixes the original resource and stagnation limits.',
    safety: 'append',
    jsonShape: 'UniverseCampaignSummary',
  },
  {
    usage: 'ashlr universe campaign status [id] [--root <path>] --json',
    description: 'Inspect recorded campaign progress without starting or resuming work. Without an ID, reports the campaign inventory and sourceState; missing inventory is not an active fleet. Completion is local experiment evidence, not production acceptance.',
    safety: 'read',
    jsonShape: 'UniverseCampaignSummary | {campaigns: UniverseCampaignSummary[], sourceState, reasons}',
  },
  {
    usage: 'ashlr universe campaign check <id> --root <absolute> --json',
    description: 'Read recorded campaign recovery evidence from an explicit canonical absolute private root. Inspect disposition, reasonCode, automaticAction and sourceState; automaticAction is advisory, not permission to execute. No provider contact, quota refresh or resume. Exit 0 includes held and terminal healthy snapshots; 1 unavailable/degraded, 2 invalid arguments. Does not accept --resource-runtime.',
    safety: 'read',
    jsonShape: 'UniverseCampaignReadiness',
  },
  {
    usage: 'ashlr universe resources check --resource-runtime <private-absolute.json> --json',
    description: 'Validate explicit local resource configuration; report worker/capacity counts, policy holds, planner recheck hints and diagnostic nextChecks without changing reserves, contacting providers or refreshing quota. evidenceScope is local-configuration-only and providerContacted is false. Exit 0 means valid configuration even when all workers are excluded; 1 invalid/unavailable, 2 invalid arguments. Does not prove authentication, current quota or campaign admission.',
    safety: 'read',
    jsonShape: 'ResourceGenerationRuntimeCheck',
  },
  {
    usage: 'ashlr universe campaign run|resume <id> [--root <path>] [--resource-runtime <private-absolute.json>] [--deliver-branch codex/<name> --deliver-base <full-seed-commit>] --json',
    description: 'Execute generations and evaluators in the foreground within the original campaign budget; resume does not reset limits. Resource-pool execution requires the explicit private runtime and can consume provider/model usage. Paired delivery flags select the best strict measured improvement after completion for an idempotent local branch; repeat them on retry. No merge, push, checkout or service activation. Exit 0 can include withheld/no-strict-improvement; inspect campaign and delivery outcomes, not only the exit code.',
    safety: 'append',
    jsonShape: 'UniverseCampaignSummary without delivery flags; UniverseCampaignDeliveryResult {campaign, delivery} with paired flags',
  },
  {
    usage: 'ashlr universe campaign supervise <id> [id ...] --root <absolute> --max-duration-ms <N> [--max-concurrent <1..4>] [--poll-interval-ms <50..60000>] [--resource-runtime <private-absolute.json>] [--delivery-plan <private-absolute.json>] --json',
    description: 'Supervise a fixed explicit queue of 1-32 registered campaigns in this foreground invocation, retaining original budgets and resource admission checks. Does not automatically resume held, interrupted or failed work or enroll new campaigns. Can consume provider/model usage. Optional private mode-0600 delivery plan names campaign IDs, codex/ branches and full pinned seed commits; completed planned campaigns reconcile local delivery without rerunning workers. No merge, push, checkout or service activation. One final JSON report: inspect outcomes[].delivery separately; attempted tracks campaign execution, not delivery replay. Exit 0 all campaigns completed (not project success), 1 incomplete/failed/timed-out, 2 invalid arguments, 130 caller cancellation.',
    safety: 'append',
    jsonShape: 'UniverseCampaignSupervisorResult',
  },
  {
    usage: 'ashlr universe deliver <id> --trial <elite-trial-id> --branch codex/<name> [--root <path>] --json',
    description: 'Explicitly materialize an exact current elite as a local commit and branch in the pinned seed repository; writes delivery receipts. Does not change checkout, index or HEAD, merge, push or deploy. Unlike campaign delivery, this selects the named current elite, not a campaign strict-improvement winner. Unchanged artifacts create no branch. Exit 0 delivered/unchanged, 1 failed/pending/degraded, 2 invalid arguments; a branch is not production acceptance.',
    safety: 'append',
    jsonShape: 'UniverseDeliveryReceipt',
  },
  {
    usage: 'ashlr universe deliveries <id> [--root <path>] --json',
    description: 'Read and verify recorded local delivery receipts without changing the repository or dispatching work. Inspect sourceState and each receipt status; pending is not completed delivery and degraded evidence is not verified. Exit 1 for pending/degraded evidence, 0 otherwise (including no receipts), 2 invalid arguments. Local receipts do not prove merge, push, deployment or acceptance.',
    safety: 'read',
    jsonShape: 'UniverseDeliveryReport',
  },
  {
    usage: 'ashlr orient [--repo <path>] --json',
    description: 'Session-start context: genome hits, health, backlog, pending proposals, attention. Run once when starting work.',
    safety: 'read',
    jsonShape: 'OrientResult',
  },
  {
    usage: 'phm context read [--section NAME] [--max-tokens N] [--json]',
    description: 'Read a bounded digest of current company context; default budget 1024, maximum 16000.',
    safety: 'read',
    jsonShape: '{schema:company.context.v1, digest, maxTokens, truncated}',
  },
  {
    usage: 'phm context write --section NAME --text TEXT --source SOURCE [--id ID] [--expires ISO] [--json]',
    description: 'Locked append of plain company context. Duplicate IDs are unchanged; keys and credentials are refused.',
    safety: 'append',
    jsonShape: '{id, appended}',
  },
  {
    usage: 'phm channels status [--json]',
    description: 'Per-channel rollup: configured, credential custody, pairing, received, pendingOutbound, lastSeenAt. Counts are measured or "unknown", never fabricated. Exit 0 success/help, 2 bad usage.',
    safety: 'read',
    jsonShape: 'ChannelsStatus {v:1, at, inbox, channels[]}',
  },
  {
    usage: 'phm channels add <telegram <chat-id>|email <inboxDir> --from <a> [...]|mobile|cli|desktop|page> [--json]',
    description: 'Writes channel configuration only — no transport, pairing, or credential IO. Credentials stay in existing custody (TELEGRAM_BOT_TOKEN, PHANTOM_OPERATOR_SECRET, private files) and are never accepted or printed. Exit 0 success/help, 1 error, 2 bad usage.',
    safety: 'append',
    jsonShape: 'ChannelAddResult {ok, kind, changed, credential, next}',
  },
  {
    usage: 'phm channels slack status [--json]',
    description: 'Offline Slack-bridge rollup: agent-network.toml parse state, bridge and workspace ids, phm_ reference names (never values), journal counts and the next step. No socket, API call or credential IO. Exit 0 report, 2 bad usage.',
    safety: 'read',
    jsonShape: 'SlackBridgeStatus {v:1, config, slackSection, bridge, credentials, mappings, teamIdentities, comms, journal, ready, next}',
  },
  {
    usage: 'phm channels slack map [--topic <topic>] [--snapshot <file>] [--json]',
    description: 'Dry-run the Slack bridge mapping: topic/channel table, one topic\'s route, and (with a saved conversations.info/members snapshot) the audience gates and send-policy verdict. Never sends. Exit 0 report, 1 input error, 2 bad usage.',
    safety: 'read',
    jsonShape: 'SlackMapReport {v:1, dryRun:true, mappings[], route?, audience?, sendPolicy?, comms, note}',
  },
  {
    usage: 'phm channels slack probe [--json]',
    description: 'Authenticate the configured Slack workspace and bot through host-injected credentials. No sends or token output; reports actual identity and observation time.',
    safety: 'read',
    jsonShape: '{ok, teamId?, userId?, botId?, observedAt, reason?}',
  },
  {
    usage: 'phm channels slack run --seconds <1-300> [--json]',
    description: 'Run a bounded authenticated Slack Socket Mode session on the existing durable bus. Requires approved team audience; persists outbound intent before sending and reconciles uncertain sends. Private iMessage/email bodies stay local.',
    safety: 'append',
    jsonShape: '{ok, mode?, sent, duplicate, uncertain, refused, observedAt, reason?}',
  },
  {
    usage: 'ashlr ask "<question>" [--json] | ashlr ask status [--jobs <path>] [--json]',
    description: 'Local RAG over the indexed portfolio; cites repo/file:line. Local models only unless --allow-cloud. status prints the ask.status.v1 stream derived from the metrics jobs ledger.',
    safety: 'read',
    jsonShape: 'AskResult | ask.status.v1 (JSONL)',
  },
  {
    usage: 'ashlr recall "<query>" [--json]',
    description: 'Search shared genome memory for prior decisions/conventions/learnings.',
    safety: 'read',
    jsonShape: 'RecallHit[]',
  },
  {
    usage: 'ashlr learn "<text>" [--title t] [--project p] [--tags a,b]',
    description: 'Append a learning to shared memory (append-only, hub store under ~/.ashlr/).',
    safety: 'append',
    jsonShape: 'GenomeEntry (created)',
  },
  {
    usage: 'ashlr backlog [--repo <path>] [--limit N] --json',
    description: 'Top scored work items from the persisted portfolio backlog (read; refresh is a separate human step).',
    safety: 'read',
    jsonShape: 'Backlog',
  },
  {
    usage: 'ashlr health [<repo>] --json',
    description: 'Quality score for an enrolled repo (tests/docs/deps/security/debt) or the latest portfolio report.',
    safety: 'read',
    jsonShape: 'HealthScore | HealthReport',
  },
  {
    usage: 'ashlr status',
    description: 'Attention board: dirty/stale repos + ecosystem summary.',
    safety: 'read',
    jsonShape: '(human-oriented; use orient --json)',
  },
  {
    usage: 'ashlr skills list [--status <s>] [--limit N] [--json]',
    description: 'List skills learned from merged PRs (newest revision each; counts are real or "unknown").',
    safety: 'read',
    jsonShape: 'SkillListReport',
  },
  {
    usage: 'ashlr skills audit <pack-path> [--json]',
    description: 'Quarantine-audit an external skill pack without executing or importing its content.',
    safety: 'read',
    jsonShape: 'ExternalSkillAuditReport',
  },
  {
    usage: 'ashlr knowledge impact <target> [--json]',
    description: 'References + dependents of a file/symbol within and across enrolled repos.',
    safety: 'read',
    jsonShape: 'ImpactResult',
  },
  {
    usage: 'ashlr signals [--json]',
    description: 'Read repository adoption signals; unavailable sources print no source.',
    safety: 'read',
    jsonShape: 'Repository signals (schemaVersion 1)',
  },
  {
    usage: 'phm friction [--runs-dir <dir>] [--no-record] [--json] | phm friction note <item-id> --status <s> [--owner <o>] [--json]',
    description: 'Mine ~/.ashlr-runs for recurring dispatch->merge friction; appends a scan row to friction/ledger.jsonl when counts change. note records an operator status/owner. Exit 0, 1 unreadable ledger, 2 usage.',
    safety: 'append',
    jsonShape: 'FrictionReport (phm.friction.v1) | {ok, appended}',
  },
  {
    usage: 'ashlr pulse [--window 1d|7d|30d] --json',
    description: 'Token/cost/activity roll-up (sessions, tokens, est. cost, commits).',
    safety: 'read',
    jsonShape: 'ActivityRollup',
  },
  {
    usage: 'ashlr inbox --json',
    description: 'List proposals in the approval inbox. LISTING ONLY for agents — approve/reject is human-only.',
    safety: 'read',
    jsonShape: 'Proposal[]',
  },
  {
    usage: 'ashlr inbox approve|reject <id>',
    description: 'HUMAN-ONLY: the single gate through which every outward action passes. Agents must never run this.',
    safety: 'human-gate',
    jsonShape: 'ApplyResult',
  },
  {
    usage: 'ashlr invent [<repo>] [--n N] [--direction <text>] [--emit] [--json]',
    description: 'Generative engine: invent bold, net-new features for a repo using a frontier model. --emit files them into the backlog.',
    safety: 'read',
    jsonShape: 'WorkItem[]',
  },
];

/** Render the cheat sheet as plain text (llms.txt-style; no ANSI). */
export function agentDocsText(): string {
  const lines: string[] = [
    '# Phantom — agent contract (CLI-first; phm or compatible ashlr)',
    '',
    'Phantom is a local-first command center: portfolio memory (genome), local RAG,',
    'work discovery (backlog), repo health, and a human-gated approval inbox.',
    'Selected CLI discovery metadata follows; this is not an exhaustive command list',
    'or execution permission. JSON output is ANSI-free. Check each command description',
    'and help for result/exit semantics: exit 0 need not mean ready, delivered or accepted.',
    'Campaign supervision additionally returns 130 for caller cancellation.',
    '',
    'Legacy safety labels describe command categories, not authorization:',
    'read = inspection-oriented · append = writes or executes work (not append-only) ·',
    'proposal = creates a PENDING inbox item (never applies) · human-gate = NEVER',
    'run from an agent; the human approves via `ashlr inbox`.',
    'Descriptions and explicit inputs determine effects, scope and resource use.',
    'Use an explicit private --root for Universe work; never infer provider readiness',
    'or permission to resume from recorded evidence or a valid resource configuration.',
    '',
  ];
  for (const c of AGENT_COMMANDS) {
    lines.push(`## ${c.usage}`);
    lines.push(`safety: ${c.safety} · json: ${c.jsonShape}`);
    lines.push(c.description);
    lines.push('');
  }
  lines.push('Private profile metadata tools: phm_proactive_agents_list, phm_proactive_agents_create,');
  lines.push('phm_proactive_agents_update and phm_proactive_agents_delete. These save profiles and');
  lines.push('planning preferences, not provider connections or verified dispatch capability.');
  lines.push('phm_task_context reads current and historical task evidence for exact outcomeId and');
  lines.push('taskId; inspect coverage, omitted counts and observation time before treating it as complete.');
  lines.push('phm_agent_roster reads the unified live session roster. Unknown sources stay unknown.');
  lines.push('Team tools (docs/architecture/teams.md): phm_team_register, phm_team_publish,');
  lines.push('phm_team_view, phm_team_claim, phm_team_handoff, phm_team_context_add and');
  lines.push('phm_team_context_get. Claims are leases; consequential handoffs wait for human approval.');
  lines.push('Equivalent MCP tools (when wired via `ashlr wire`): ashlr_orient,');
  lines.push('ashlr_ask, ashlr_recall, ashlr_learn, ashlr_backlog, ashlr_health,');
  lines.push('ashlr_status, ashlr_impact, ashlr_pulse, ashlr_inbox_list,');
  lines.push('ashlr_inbox_propose. Fleet-state read tools (M129): ashlr_fleet_status,');
  lines.push('ashlr_scorecard, ashlr_oversight, ashlr_routing.');
  lines.push('Elite fleet-state read tools (M169): ashlr_north_star (north-star metric,');
  lines.push('7d window), ashlr_self_heal (self-heal queue summary), ashlr_racing');
  lines.push('(model-racing distillation stats), ashlr_comms (comms channel status),');
  lines.push('ashlr_comms_thread (owner thread) and ashlr_comms_send_owner (owner replies only).');
  lines.push('Fleet command tools: phantom_agent_bus_read, phantom_agent_bus_status,');
  lines.push('phantom_agent_bus_post, phantom_fleet_drop_job, phantom_fleet_job_reassign,');
  lines.push('phantom_fleet_planner_run, phantom_fleet_apps_ensure, phantom_fleet_apps_changes,');
  lines.push('phantom_fleet_apps_status, phantom_fleet_apps_await, phantom_fleet_needs,');
  lines.push('phantom_fleet_orders, phantom_fleet_graph, phantom_fleet_session, phantom_fleet_doctor.');
  lines.push('Tool discovery is not authorization. phantom_fleet_doctor only reads fleet health.');
  lines.push('Read-only observation tools: world_model, phantom_observe, phantom_observe_session,');
  lines.push('phantom_spend_budget, phm_context_brief, phm_claim_acquire, phm_claim_release,');
  lines.push('phantom_leader_status, phantom_leader_org, phantom_leader_inbox, phantom_leader_ask,');
  lines.push('phantom_leader_assign, ashlr_comms_agent_status, ashlr_comms_agent_drafts,');
  lines.push('ashlr_comms_agent_run. Unknown evidence stays unknown and grants no send or spend.');
  lines.push('Desktop operator tools: desktop_list_apps, desktop_windows, desktop_read,');
  lines.push('desktop_screenshot, desktop_doctor, desktop_focus, desktop_scroll, desktop_type,');
  lines.push('desktop_click. Reads do not post to the bus. Focus, scroll, type and click post');
  lines.push('a bus intent first. KILL and comms pause block those writes.');
  lines.push('App recovery observation tools: phantom_fleet_apps_history,');
  lines.push('phantom_fleet_apps_follow, phantom_fleet_apps_recovery_wait,');
  lines.push('phantom_fleet_apps_recovery_check, phantom_fleet_apps_recovery_batch.');
  lines.push('These read retained local evidence only; they never query or launch apps.');
  lines.push('Website tools: ashlr_website_status reads publication mode, phase and holds;');
  lines.push('ashlr_website_publish requests the exact normally merged website revision with');
  lines.push('profile=phantom-public-web and expectedMerge=<40-hex SHA>. The commissioned host');
  lines.push('checks signed scope, source, build and live aliases before publishing. A request');
  lines.push('is not a deployment receipt; inspect status and production evidence. These tools');
  lines.push('do not create credentials or commission publishing. Inbox approval stays human-only.');
  lines.push('');
  return lines.join('\n');
}

/** Ready-to-paste CLAUDE.md block (for `ashlr wire --claude-md`). */
export function claudeMdSnippet(): string {
  return [
    '## Phantom (portfolio command center; phm or compatible ashlr)',
    '',
    'This machine runs Phantom — local-first portfolio memory, RAG, and work',
    'discovery. Use it via Bash:',
    '',
    '- **Session start:** `ashlr orient --repo <repo> --json` — prior decisions,',
    '  repo health, top backlog items, pending proposals. Read it before working.',
    '- **Questions about any repo:** `ashlr ask "<question>" --json` (cites file:line).',
    '- **Search prior learnings:** `ashlr recall "<query>" --json`.',
    '- **Save a learning** (architecture decision, gotcha, convention):',
    '  `ashlr learn "<text>" --project <name>` — append-only, safe.',
    '- **Find work:** `ashlr backlog --repo <repo> --json`.',
    '- **NEVER run** `ashlr inbox approve|reject` or `ashlr enroll` — those are',
    '  human-only gates.',
    '',
  ].join('\n');
}

function printDocsHelp(): void {
  const c = makeColors(isTty());
  console.log('');
  console.log(c.bold('  ashlr docs') + c.dim(' — generated documentation surfaces'));
  console.log('');
  console.log(`    ${c.cyan('ashlr docs --agent')}          ${c.dim('agent cheat sheet (llms.txt-style, plain text)')}`);
  console.log(`    ${c.cyan('ashlr docs --agent --json')}   ${c.dim('the same registry as JSON')}`);
  console.log(`    ${c.cyan('ashlr wire --claude-md')}      ${c.dim('CLAUDE.md snippet for agent configs')}`);
  console.log('');
}

export async function cmdDocs(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const agent = args.includes('--agent');

  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printDocsHelp();
    return 0;
  }

  if (!agent) {
    if (json) {
      // --json never prints the human help: one JSON object, same exit code.
      process.stdout.write(JSON.stringify({
        ok: false,
        error: 'ashlr docs needs a surface; pass --agent --json',
        surfaces: [
          { command: 'ashlr docs --agent', description: 'agent cheat sheet (llms.txt-style, plain text)' },
          { command: 'ashlr docs --agent --json', description: 'the same registry as JSON' },
          { command: 'ashlr wire --claude-md', description: 'CLAUDE.md snippet for agent configs' },
        ],
      }, null, 2) + '\n');
      return 2;
    }
    printDocsHelp();
    return 2;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ commands: AGENT_COMMANDS }, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(agentDocsText());
  return 0;
}

/** Human-facing summary table for `ashlr docs` discoverability surfaces. */
export function renderAgentTable(): string {
  const c = makeColors(isTty());
  const w = Math.max(...AGENT_COMMANDS.map((x) => x.usage.length));
  return AGENT_COMMANDS
    .map((x) => `    ${c.cyan(pad(x.usage, w))}  ${c.dim(`[${x.safety}]`)} ${x.description}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// M32: topic-grouped help — `ashlr help [<topic>] [--search <term>] [--all]`
// ---------------------------------------------------------------------------

export type HelpTopic =
  | 'core' | 'run' | 'swarm' | 'memory' | 'knowledge' | 'autonomy'
  | 'observability' | 'integrations' | 'safety' | 'web' | 'scaffold';

export interface HelpEntry {
  cmd: string;
  desc: string;
  topic: HelpTopic;
}

const TOPIC_LABELS: Record<HelpTopic, string> = {
  core: 'Core — index, navigate, configure',
  run: 'Run — local-first agent runs',
  swarm: 'Swarm — specs + multi-agent fleets',
  memory: 'Memory — shared genome',
  knowledge: 'Knowledge — portfolio RAG + graph',
  autonomy: 'Autonomy — enrollment, backlog, daemon, inbox, goals',
  observability: 'Observability — cost, telemetry, audit',
  integrations: 'Integrations — MCP, GitHub, Vercel, editors',
  safety: 'Safety — sandboxes, invariants, activation',
  web: 'Surfaces — TUI + web dashboard',
  scaffold: 'Scaffold — new projects + shipping',
};

/** The full command table (the former inline cmdHelp list), topic-tagged. */
export const HELP_ENTRIES: HelpEntry[] = [
  { cmd: 'constitution check [--root <repo>] [--json] [paths...]', desc: 'Check constitution rule definitions and references in prompts and templates (read-only).', topic: 'core' },
  { cmd: 'tune <prepare|evaluate>', desc: 'Prepare scrub-gated local model datasets or evaluate paired evidence.', topic: 'core' },
  { cmd: 'jobs empty [--since 24h] [--json]', desc: 'Explain empty jobs from local notes and logs.', topic: 'observability' },
  { cmd: 'metrics idle --status <snapshot.json> --jobs <jobs.jsonl> [--json]', desc: 'Estimate idle slot-minutes and flag long-running jobs from local snapshots.', topic: 'autonomy' },
  { cmd: 'graph nodes|edges|status [--json]', desc: 'Read-only GRAPH-1 nodes, edges, and availability; unavailable data exits 1. See phm graph --help.', topic: 'knowledge' },
  { cmd: 'radar list|run|diff [--json]', desc: 'Public docs observation: list sources, run independent fetches, and diff local snapshots. HTTPS GET only, no credentials. See docs/RADAR.md.', topic: 'observability' },
  { cmd: 'observe [--json]', desc: 'Human observe snapshot: roster, sensor headroom, pull headlines, bottlenecks, and human steps. Unknown stays unknown. See docs/OBSERVE.md.', topic: 'observability' },
  { cmd: 'context --for-agent <lane> [--json]', desc: 'Compact under-4KB brief for one lane: claims, open pulls, bottlenecks, blind spots, and pacing. See docs/WORLD.md.', topic: 'observability' },
  { cmd: 'claim acquire <work-key> --lane <lane> [--json]', desc: 'Claim a work key before starting. Refuses a live claim or open pull on that key and returns the holder.', topic: 'observability' },
  { cmd: 'claim release <work-key> --lane <lane> --reason open|merge|abandon [--json]', desc: 'Release this lane claim when a pull opens, merges, or is abandoned.', topic: 'observability' },
  { cmd: 'growth [--json] [--range 1H|1D|1W|1M] [--prs <file>]', desc: 'Growth chart series from local ledgers. A missing source is no-data-source and a world-model blind spot. See docs/GROWTH.md.', topic: 'observability' },
  { cmd: 'world [--json] [--refresh]', desc: 'Cached ashlr.world-model/v1 for the scheduler and leaders. blindSpots lists each unknown field by path with a stable id. See docs/WORLD.md.', topic: 'observability' },
  { cmd: 'world get <path> [--json]', desc: 'Read one node from the cached world model. A missing path is unknown, not zero.', topic: 'observability' },
  { cmd: 'chain verify [--json]', desc: 'Synthetic in-memory chain checks. Does not verify live transports.', topic: 'observability' },
  { cmd: 'incident report|receipts [--json]', desc: 'Turn a production signal into one bounded fix job, or send receipts for finished incidents.', topic: 'observability' },
  { cmd: 'router rank --tier <local|mid|frontier> [--routes FILE] [--slots pool=count ...] [--json]', desc: 'Rank supplied router decisions by pool budget reset; advisory, no writes.', topic: 'observability' },
  { cmd: 'router-calibration --jobs <jobs.jsonl> [--posthog <runs.json>] [--json]', desc: 'Compare recorded router predictions with outcomes and usage.', topic: 'observability' },
  { cmd: 'index [--refresh]',            desc: 'Build or refresh the desktop index; show counts by category.', topic: 'core' },
  { cmd: 'go [query] [--open|--cd]',     desc: 'Find a repo or item; open in editor (--open) or print path for cd (--cd).', topic: 'core' },
  { cmd: 'status [--json]',              desc: 'Attention board: dirty, off-sync, and stale repos; ecosystem summary.', topic: 'core' },
  { cmd: 'ls [category]',                desc: 'List all indexed items, optionally filtered by category.', topic: 'core' },
  { cmd: 'open [query]',                 desc: 'Open the best match in your editor; no query opens an interactive picker.', topic: 'core' },
  { cmd: 'tidy [--apply]',               desc: 'Show (or apply) tidy moves for loose Desktop files.', topic: 'core' },
  { cmd: 'config [list|get <k>|set <k> <v>]', desc: 'Read/write a config value. `list` prints a summary; no args prints the path.', topic: 'core' },
  { cmd: 'config effective [--json]',     desc: 'Read-only effective autonomy/daemon/foundry/backend settings.', topic: 'core' },
  { cmd: 'config set <k> --json <v>',    desc: 'Set a structured (array/object) config value as JSON.', topic: 'core' },
  { cmd: 'config path',                  desc: 'Print the path to config.json.', topic: 'core' },
  { cmd: 'doctor',                       desc: 'One-glance health check: config, phantom, providers, ecosystem.', topic: 'core' },
  { cmd: 'init [--yes]',                 desc: 'Idempotent onboarding: ensure config, detect phantom + models, set editor.', topic: 'core' },
  { cmd: 'desktop install [--apply]', desc: 'Inspect original signed app/CLI artifacts; explicitly install only on an empty macOS arm64 installation after Stop/drain. Does not resume authority.', topic: 'core' },
  { cmd: 'desktop list-apps|windows|focus|read|scroll|type|click|screenshot|doctor [--json]', desc: 'Operate macOS desktop apps through the desktop-operator helper. Reads are free. focus, scroll, type and click post a bus intent first. KILL and comms pause block writes.', topic: 'core' },
  { cmd: 'apps list|open|quit|focus|status [<app>] [--json]', desc: 'Manage desktop apps named in ~/.ashlr/apps-allow.json (empty by default). Logged to the feed; quit with unsaved work goes to needs-you.', topic: 'core' },
  { cmd: 'desktopctl capabilities|status|run <resource> [--json]', desc: 'Drive Claude, Codex, Devin and a browser as interchangeable desktop resources. Flag-gated by ~/.ashlr/desktopctl.json; reports missing TCC grants, never prompts. Logged to the feed.', topic: 'core' },
  { cmd: 'desktop-update inspect|apply --stage <32hex> --json', desc: 'Verify signed paired updates; apply after native exit, Stop/drain and unchanged active grant. Never resumes the resident.', topic: 'core' },
  { cmd: 'app update status [--json]', desc: 'Inspect local desktop update status without downloading or installing. Read-only: reports current stage, available version, deferred reason, running job counts. Exit 0 success, 2 bad usage.', topic: 'core' },
  { cmd: 'update [--check] [--json]',    desc: 'Self-update; mutation requires service registration proven absent and not running. --check remains read-only.', topic: 'core' },
  { cmd: 'self-swap [--plan | --apply --supervised] [--json]', desc: 'Plan a versioned install swap; apply builds, probes, flips current and drains the old supervised process.', topic: 'core' },
  { cmd: 'upgrade [--check] [--json]',   desc: 'Same as update.', topic: 'core' },
  { cmd: 'runtime install --store <absolute> --artifact <absolute> --sha256 <hash> --revision <sha> --version <version>', desc: 'Install exact offline candidate bytes into a private store; not production qualification or service activation.', topic: 'core' },
  { cmd: 'runtime status|rollback --store <absolute> [--json]', desc: 'Verify local candidate selection or explicitly restore the previous verified installation.', topic: 'core' },
  { cmd: 'runtime run --store <absolute> -- universe <args>', desc: 'Run Universe in the foreground using the verified installed candidate; operational commands require explicit absolute --root.', topic: 'core' },
  { cmd: 'orient [--repo <r>] [--json]', desc: 'Session-start context: genome hits, health, backlog, pending proposals, attention (read-only).', topic: 'core' },
  { cmd: 'docs --agent [--json]',        desc: 'Agent cheat sheet: the CLI-first contract (commands, safety classes, JSON shapes).', topic: 'core' },
  { cmd: 'check [--base <ref>] [--json]', desc: 'Run incremental typechecks, cached lint and affected tests from a Phantom checkout; development feedback only.', topic: 'core' },
  { cmd: 'completions zsh|bash',         desc: 'Print a shell completion script to stdout.', topic: 'core' },
  { cmd: 'plugins init|list|info|enable|disable', desc: 'Scaffold + manage plugins (~/.ashlr/plugins/) — default-off, integrity-pinned, audited (see docs/PLUGINS.md).', topic: 'core' },
  { cmd: 'x <name> [args...]',           desc: "Run an enabled plugin's command.", topic: 'core' },
  { cmd: 'help [<topic>|--all|--search <term>]', desc: 'Topic-grouped help; --all prints every command; --search <term> filters.', topic: 'core' },
  { cmd: 'version',                      desc: 'Print the installed ashlr version (aliases: --version, -v).', topic: 'core' },

  { cmd: 'run "<goal>" [opts]',          desc: 'Decompose goal into tasks; execute via local model (Ollama/LM Studio).', topic: 'run' },
  { cmd: 'run show <id>',                desc: 'Print a past run in detail.', topic: 'run' },
  { cmd: 'runs [--json]',                desc: 'List past runs (newest first).', topic: 'run' },
  { cmd: 'models [--json]',              desc: 'List local models (Ollama/LM Studio); marks the active one.', topic: 'run' },
  { cmd: 'models verify [--json]',       desc: 'Check registry model IDs against official provider documentation.', topic: 'run' },
  { cmd: 'models pull <name> [--yes]',   desc: 'Explicitly pull an Ollama model (large download; confirm first).', topic: 'run' },
  { cmd: 'models start',                 desc: 'Best-effort start a locally-installed Ollama (never downloads).', topic: 'run' },
  { cmd: 'local-runtime <status|start|stop|restart|reshape|logs|resolve-model>', desc: 'Supervise the loopback llama-server serving runtime (parallel local fleet engine); manual and attended.', topic: 'run' },
  { cmd: 'local-runtime install|uninstall', desc: 'Add or remove the opt-in launch agent that keeps llama-server up across logout/crashes; install is refused while the kill switch is engaged.', topic: 'run' },

  { cmd: 'spec new "<goal>" [--project]', desc: 'Author a versioned end-state spec artifact (local-first model).', topic: 'swarm' },
  { cmd: 'spec list [--project <path>]', desc: 'List all spec artifacts, newest version per spec.', topic: 'swarm' },
  { cmd: 'spec show <id>',               desc: 'Print a spec artifact in full.', topic: 'swarm' },
  { cmd: 'spec refine <id> "<note>"',    desc: 'Produce a new version of a spec incorporating the note.', topic: 'swarm' },
  { cmd: 'swarm "<goal>" [opts]',        desc: 'Decompose goal into a contracts-first DAG; run a fleet of agents.', topic: 'swarm' },
  { cmd: 'swarm <specId> [opts]',        desc: 'Run a swarm against an existing spec artifact.', topic: 'swarm' },
  { cmd: 'swarm show <id>',              desc: 'Print a past swarm run in detail.', topic: 'swarm' },
  { cmd: 'swarms [--json]',              desc: 'List past swarm runs (newest first).', topic: 'swarm' },

  { cmd: 'memory add|list|search|forget [--json]', desc: 'Persistent agent memory: add, list, search, and forget entries (preference|doctrine|fact). Refuses secret-shaped text. See docs/MEMORY.md.', topic: 'memory' },
  { cmd: 'recall "<query>"',             desc: 'Search shared genome memory; return top relevant entries with scores.', topic: 'memory' },
  { cmd: 'learn "<text>" [opts]',        desc: 'Append a note to shared genome memory (local-first, append-only).', topic: 'memory' },
  { cmd: 'genome',                       desc: 'Genome status/health: entry count, projects covered, store size.', topic: 'memory' },

  { cmd: 'knowledge build',              desc: 'Index enrolled repos locally (read-only, secret-scrubbed) for portfolio RAG.', topic: 'knowledge' },
  { cmd: 'ask "<question>"',             desc: 'Local RAG across the indexed portfolio; cites repo/file:line. --allow-cloud opt-in. `ask status` prints the ask.status.v1 stream from the metrics jobs ledger.', topic: 'knowledge' },
  { cmd: 'knowledge impact <target>',    desc: 'Show references + dependents of a file/symbol within and across enrolled repos.', topic: 'knowledge' },
  { cmd: 'knowledge graph',              desc: 'Print the portfolio knowledge graph (repos/modules/deps + cross-repo findings).', topic: 'knowledge' },
  { cmd: 'wiki build [repo] [--all]',    desc: 'Private architecture wiki per repo (local models; cited, verified file:line). Only stale pages rebuild.', topic: 'knowledge' },
  { cmd: 'wiki ask "<question>"',        desc: 'Answer from the wiki + index + genome with verified file:line citations, or say "not found".', topic: 'knowledge' },
  { cmd: 'wiki status [repo]',           desc: 'Wiki freshness: generated at <commit>, N pages stale.', topic: 'knowledge' },

  { cmd: 'enroll list',                  desc: 'List enrolled repos + kill switch state.', topic: 'autonomy' },
  { cmd: 'enroll add <repo> [--locus-firm]', desc: 'Enroll a repo for autonomous work. First enroll soft-offers locus.firm when locus CLI is present; --locus-firm / ASHLR_LOCUS_FIRM=1 enable without prompt (default off).', topic: 'autonomy' },
  { cmd: 'enroll remove <repo>',         desc: 'Remove a repo from the enrollment registry.', topic: 'autonomy' },
  { cmd: 'enroll kill on|off',           desc: 'Toggle the global autonomous kill switch.', topic: 'autonomy' },
  { cmd: 'backlog',                      desc: 'Scored work queue across enrolled repos (issues, TODOs, tests, deps, docs, security, plugins, goals, hygiene, invention).', topic: 'autonomy' },
  { cmd: 'select [--json] [--dry-run] [--top <n>]', desc: 'Rank candidates by value x leverage / (time + usage), fund the top 5 as READY lines, record picks with predicted value.', topic: 'autonomy' },
  { cmd: 'backlog refresh',              desc: 'Re-scan all enrolled repos and rebuild the backlog.', topic: 'autonomy' },
  { cmd: 'release-articles status|enable|disable|import|sync [--json]', desc: 'Configure release-backed article task handoffs; sync verifies public GitHub/npm evidence and never publishes directly.', topic: 'autonomy' },
  { cmd: 'release status [--json] [--file <release-state.json>]', desc: 'Show release tags, assets, unreleased commits and updater status for Ashlr repositories. Use --file to read release train state.', topic: 'autonomy' },
  { cmd: 'backlog --source <src>',       desc: `Filter backlog by source: ${BACKLOG_SOURCE_FILTER_HELP}.`, topic: 'autonomy' },
  { cmd: 'backlog --repo <path>',        desc: 'Filter backlog to a specific enrolled repo.', topic: 'autonomy' },
  { cmd: 'backlog --limit <n>',          desc: 'Show only the top N items.', topic: 'autonomy' },
  { cmd: 'backlog --json',               desc: 'Emit raw JSON backlog.', topic: 'autonomy' },
  { cmd: 'inbox',                        desc: 'Approval inbox: list pending proposals (the outward-action gate).', topic: 'autonomy' },
  { cmd: 'drafts list|show|approve|reject [--json]', desc: 'Outbound drafts waiting for owner approval; approve records, never sends. See docs/DRAFTS.md.', topic: 'autonomy' },
  { cmd: 'comms-agent status|run|drafts [--json]', desc: 'Comms role under the Leader. Triage archives bulk and bot mail and drafts replies. Sends need an owner standing approval. No lane is hard-coded. See docs/COMMS-AGENT.md.', topic: 'autonomy' },
  { cmd: 'inbox show <id>',              desc: 'Full detail of a proposal incl. diff (read-only).', topic: 'autonomy' },
  { cmd: 'inbox approve <id>',           desc: 'Confirm + apply an approved proposal to its dedicated local branch.', topic: 'autonomy' },
  { cmd: 'inbox approve <id> --yes',     desc: 'Approve without interactive prompt (non-TTY safe).', topic: 'autonomy' },
  { cmd: 'inbox submit <id>',            desc: 'Caller-confirm, freshly verify, and hand one signed frontier proposal to a protected PR; never merges main.', topic: 'autonomy' },
  { cmd: 'inbox submit <id> --yes',      desc: 'Records non-interactive caller intent, not an authenticated human receipt; all verification and remote gates remain.', topic: 'autonomy' },
  { cmd: 'inbox reject <id>',            desc: 'Discard a pending proposal; applies nothing.', topic: 'autonomy' },
  { cmd: 'inbox --json',                 desc: 'Emit JSON for inbox list, show, approve, submit, or automerge results.', topic: 'autonomy' },
  { cmd: 'drive [--once --dry-run] [--tick <seconds>]', desc: 'Supervise the Mac queue through an installed host bridge; dry-run plans only. See docs/DRIVE.md.', topic: 'autonomy' },
  { cmd: 'daemon start --once',          desc: 'Currently refuses before effects because compiled daemon trust roots are empty; use owner-invoked run/swarm or the dry-run form.', topic: 'autonomy' },
  { cmd: 'daemon start --once --dry-run', desc: 'Plan only: which backlog items WOULD be worked (no swarm/proposal).', topic: 'autonomy' },
  { cmd: 'daemon start --once --drain diagnostic-reslices --limit 3', desc: 'Dormant non-dry diagnostic drain; compiled daemon trust roots are empty.', topic: 'autonomy' },
  { cmd: 'daemon stop',                  desc: 'Halt the daemon: set kill switch + clear running state.', topic: 'autonomy' },
  { cmd: 'daemon status',                desc: "Daemon roll-up: running?, today's spend vs cap, pending proposals.", topic: 'autonomy' },
  { cmd: 'daemon activation-preflight --request <path> [--json]', desc: 'Read-only verification of operator-custodied signed candidate and rollback artifacts; grants no service authority.', topic: 'safety' },
  { cmd: 'daemon activate --request <path> --authorize <digest> --confirm <digest> [--json]', desc: 'Dormant permit-gated 3.2.7 selection; preserves loaded=false and the exact disabled bit, and never starts a service.', topic: 'safety' },
  { cmd: 'daemon service-status',        desc: 'Read-only OS service state; remains available during the resident-mutation restriction.', topic: 'autonomy' },
  { cmd: 'daemon uninstall',             desc: 'Remove an existing OS service; remains available during the resident-mutation restriction.', topic: 'autonomy' },
  { cmd: 'daemon install',               desc: 'Temporarily unavailable: install/reinstall/repair/restart authority is withheld.', topic: 'autonomy' },
  { cmd: 'daemon recover-state --dry-run|--execute', desc: 'Preview or explicitly execute one exact quarantine of a malformed daemon state (the fix when `daemon status` shows a state issue).', topic: 'autonomy' },
  { cmd: 'daemon resolve-state --dry-run|--execute', desc: 'Preview or explicitly resolve one exact quarantine, restoring daemon state after `daemon recover-state`.', topic: 'autonomy' },
  { cmd: 'worker setup',                 desc: 'Temporarily unavailable and fail-closed before config, enrollment, queue, wizard, or service mutation.', topic: 'autonomy' },
  { cmd: 'prs triage [--repo ashlrai/<name>] [--limit N] --json', desc: 'Read-only classification of open pull requests.', topic: 'autonomy' },
  { cmd: 'worklog [--since 24h] [--repo <repo>] [--lane <lane>] [--json]', desc: 'Show merged pull requests from the jobs ledger.', topic: 'observability' },
  { cmd: 'library list [--json]', desc: 'List leader files. Read-only.', topic: 'observability' },
  { cmd: 'fleet status [--json]',        desc: 'Read-only fleet snapshot: daemon, per-backend dispatches+quota, queue, proposals, merges, paused state.', topic: 'autonomy' },
  { cmd: 'fleet evidence doctor <source>', desc: 'Bounded read-only diagnosis for one decisions, judge, action, dispatch, manifest, or candidate ledger.', topic: 'autonomy' },
  { cmd: 'fleet direction [--json]',     desc: 'Read-only autonomous direction report: mode, resource posture, guard blocks, and next actions.', topic: 'autonomy' },
  { cmd: 'fleet automerge-canary status|prepare-shadow|activate-shadow|halt', desc: 'Prepare or operate the bounded observation-only shadow canary; enforce mode remains unsupported.', topic: 'autonomy' },
  { cmd: 'fleet xreview run|decide --request <file>', desc: 'Cross-model review on another pool (no tools, no credentials) and the deterministic SHA-bound auto-merge decision; never merges.', topic: 'autonomy' },
  { cmd: 'fleet pause',                  desc: 'Pause the fleet: engage the global kill switch (idempotent).', topic: 'autonomy' },
  { cmd: 'fleet resume',                 desc: 'Resume the fleet: release the global kill switch (idempotent).', topic: 'autonomy' },
  { cmd: 'recovery list|inspect',         desc: 'Inspect bounded metadata-only prepared/committed tool-effect evidence.', topic: 'autonomy' },
  { cmd: 'recovery attest|abandon',       desc: 'Record an exact interactive terminal no-replay disposition for one prepared effect.', topic: 'autonomy' },
  { cmd: 'goals add <objective>',        desc: 'Register a high-level OBJECTIVE (goal); decomposed into ordered milestones (local, no LLM by default).', topic: 'autonomy' },
  { cmd: 'goals plan <id>',              desc: 'Decompose a goal into ordered milestones + author/link each milestone spec (LOCAL-FIRST; --allow-cloud to use cloud).', topic: 'autonomy' },
  { cmd: 'goals advance <id>',           desc: 'Advance the next actionable milestone via a SANDBOXED, proposal-only swarm (ENROLLED repos only; emits a PENDING proposal).', topic: 'autonomy' },
  { cmd: 'goals status [id]',            desc: 'Read-only roll-up of goal/milestone progress + linked swarm/proposal state (mutates nothing).', topic: 'autonomy' },
  { cmd: 'goals recover-stale',           desc: 'Reset stale proposal-less in-progress goal lanes back to pending so the fleet can advance them again.', topic: 'autonomy' },
  { cmd: 'goals repair-timestamps',        desc: 'Linux/macOS-only dry-run or exact-plan repair for stale goal updatedAt values (offline, byte-surgical, backed up).', topic: 'autonomy' },
  { cmd: 'roadmap <run|resume|status>',  desc: 'Goal Loop: run a roadmap of milestone files, one FRESH agent process per milestone; resumable from state.json (LOCAL-FIRST; --allow-cloud for API engines).', topic: 'autonomy' },
  { cmd: 'setup',                        desc: 'Temporarily unavailable: refuses before config or wizard effects; use owner-invoked run/swarm or daemon dry-run while compiled runtime roots are empty.', topic: 'core' },
  { cmd: 'goal "<objective>"',           desc: 'Live owner-invoked objective → plan → one sandboxed proposal-only advance; never resident or unattended authority.', topic: 'autonomy' },
  { cmd: 'goal "<objective>" --direct',  desc: 'One owner-invoked proposal-only run with bounded --json output; no unattended authority or verification proof.', topic: 'autonomy' },
  { cmd: 'loop',                         desc: 'Dormant non-dry conductor loop: compiled conductor trust roots are empty; use loop --dry-run.', topic: 'autonomy' },
  { cmd: 'loop leases [clear <task-id>] [--dry-run]', desc: 'List simple-conductor leases needing reconciliation; clear one only when its owner is provably not running.', topic: 'autonomy' },
  { cmd: 'conductor-permit request|mint|inspect|stage', desc: 'Dormant signed one-shot goal-conductor permit operator; fail-closed while source trust roots are empty.', topic: 'autonomy' },
  { cmd: 'website status|auto|pause|off', desc: 'Inspect or pause automatic phm.dev publication; Auto resumes within its existing signed website scope.', topic: 'autonomy' },
  { cmd: 'website prepare --image <digest>', desc: 'Qualify the fixed website publisher and a real offline Linux x64 production build before one-time commissioning.', topic: 'autonomy' },
  { cmd: 'authority status [--json]',     desc: 'Standing authority: grant state, autonomy switch, Stop, rollout stage, ledger chain and custody (read-only).', topic: 'autonomy' },
  { cmd: 'authority switch <off|propose|autonomous>', desc: 'Lower autonomy instantly; raise it only up to what the signed grant allows (past it needs Touch ID).', topic: 'autonomy' },
  { cmd: 'authority stop|clear-stop',     desc: 'Engage Stop (~/.ashlr/KILL: halts running agents, cancels armed merges) or clear it; stopping never asks, clearing is ledgered first.', topic: 'autonomy' },
  { cmd: 'authority grant|re-approve [--yes]', desc: 'Sign a standing grant (or its continuation) with Touch ID via ashlr-custody and install it; fail-closed while compiled trust roots are empty.', topic: 'autonomy' },
  { cmd: 'authority revoke [--reason <text>]', desc: 'Engage Stop, switch autonomy off and require a new signed grant (Touch ID) to resume.', topic: 'autonomy' },
  { cmd: 'authority ledger verify|tail',  desc: 'Verify or read the hash-chained authority ledger (~/.ashlr/authority/ledger.jsonl).', topic: 'autonomy' },
  { cmd: 'authority protect --print|--apply', desc: 'Print (or apply after confirmation) the GitHub rulesets for the grant\'s server-enforced repos.', topic: 'autonomy' },
  { cmd: 'authority setup [--dry-run [--json]]', desc: 'Guided Phase 0: custody key, trust-root PR, GitHub App, Claude token, canary, rulesets, first grant, switch, daemon service — asks before every step; --dry-run --json prints the checklist as JSON.', topic: 'autonomy' },
  { cmd: 'feed [--json] [--limit N]', desc: 'Read recent fleet events, newest first; unavailable sources remain unknown.', topic: 'autonomy' },
  { cmd: 'leader show|run|tick|veto',     desc: 'The Leader (Visionary): show the latest memo and actions, run it now, apply due class-B actions (tick), veto an action or a whole memo (--memo).', topic: 'autonomy' },
  { cmd: 'org show|join|plan [--file <org.toml>] [--json]', desc: 'Declarative co-founder org model: show members and lanes, opt your own machine into lanes with join, or propose queue assignments with plan. Nothing is sent on join.', topic: 'autonomy' },
  { cmd: 'leader status|ask|org|assign [--json]', desc: 'Digital co-founder: world-backed status, owner ask, declarative org chart, and RQ assignment. Escalates only for secrets, money, outside sends, and owner-data destruction. KILL stops it. No new model spend.', topic: 'autonomy' },
  { cmd: 'leader seat|inbox [--json]', desc: 'Inspect admitted model tiers and failover seats, or the durable CEO inbox/outbox; inbox --text records a policy-checked message.', topic: 'autonomy' },
  { cmd: 'leader say|thread|answer|approve|directives', desc: 'Talk to the Leader in the one thread Phantom and Telegram share: say something, read the thread, answer a memo question, approve a pending action (applied only if the grant allows), add or retire standing directives.', topic: 'autonomy' },
  { cmd: 'leader oversight-plist --print', desc: 'Print (never install) the nightly ai.ashlr.oversight LaunchAgent that runs `ashlr leader tick --wait` instead of the legacy Strategist; install by hand per docs/AUTHORITY.md.', topic: 'autonomy' },
  { cmd: 'cloud launch "<task>" [--repo o/n] [--base b]', desc: 'Start a Claude Code cloud session that delivers a draft PR (spends Claude credits; never merges). Repo defaults to this folder\'s GitHub origin.', topic: 'autonomy' },
  { cmd: 'playbook list|show|new|edit|run <id>', desc: 'Versioned task templates every lane runs under (`!fix-bug` in any task text): list them, show one with per-version outcomes, write a new version in $EDITOR, or run one in the cloud / Devin lane (`--repo o/n --lane cloud|devin`).', topic: 'autonomy' },
  { cmd: 'openai-agents sessions|inspect|turns [session-id] [--json]', desc: 'Read bounded managed OpenAI Agents API metadata. API access is separate from subscriptions; no execution qualification or mutations.', topic: 'autonomy' },
  { cmd: 'agents bus channels list|test <id> [--json]', desc: 'List registered channel adapters and probe the local bus or handoff store.', topic: 'autonomy' },
  { cmd: 'agents bus contract [--json]', desc: 'Print the Agent Bus v2 contract: schema version, providers, body kinds, work statuses, claim key forms. Read-only.', topic: 'autonomy' },
  { cmd: 'agents roster [--json]', desc: 'Unified live session roster. One probe per source, about 5s each, unknown on timeout or an unverified command. Read-only.', topic: 'autonomy' },
  { cmd: 'bus thread|task <verb> [--peer <id>] [--json]', desc: 'Shared task board: local threads plus task claim, handoff, renew and release tied to fenced fleet queue claims. Cooperative labels only; no execution authority.', topic: 'autonomy' },
  { cmd: 'metrics ingest --jobs <file> --status <file>', desc: 'Read local lane and tier merge metrics and advisory routing priors; always JSON.', topic: 'autonomy' },
  { cmd: 'metrics levers [--window <7d|30d>] [--json]', desc: 'Rank three opportunity proxies from local activity and fleet rollups.', topic: 'autonomy' },
  { cmd: 'benchmark run|--compare-reports', desc: 'Explicit local-agent benchmark trials, or offline matched-receipt comparison; real checkers and private traces.', topic: 'autonomy' },
  { cmd: 'devin connect [--org org-…]',   desc: 'Connect Devin (Cognition): paste the API key at a hidden prompt; it is verified and stored in the macOS Keychain, never in a file.', topic: 'autonomy' },
  { cmd: 'devin launch "<task>" [--repo o/n] [--base b]', desc: 'Start a Devin session that delivers a PR on ashlr-devin/<id> through the standing gates (spends ACUs, hard-capped per session; never merges).', topic: 'autonomy' },
  { cmd: 'automations list|templates|add|enable|disable|remove', desc: 'Automations: labelled issues, a red default branch, RRULE schedules, a local webhook or Telegram /task become tasks for the fleet, cloud, Devin or review — with queue, per-day, concurrency and spend limits.', topic: 'autonomy' },
  { cmd: 'automations fire <id> [--dry-run]', desc: 'Check one automation\'s trigger now and dispatch what it finds through the lane\'s own gates (grant, KILL, budgets); --dry-run shows what would happen and writes nothing.', topic: 'autonomy' },
  { cmd: 'jev status [--json]',          desc: 'Jev (TypeSafe) typed decisions today: on/keyed, decisions by kind, avg confidence, fallback rate, est. cost, latency. Reads the local ledger only.', topic: 'autonomy' },
  { cmd: 'jev test "<text>" [--kind intent|task-class|engine-error|lane|claim|triage]', desc: 'One live Jev decision on the text (one paid call when keyed): shows the label, confidence and whether Jev or the deterministic rule won.', topic: 'autonomy' },
  { cmd: 'devin status|list|refresh|message|budget|fleet', desc: 'Devin connection and readiness, tasks and their PRs, a status refresh, replies to waiting sessions, the ACU budget, and whether the fleet may launch sessions.', topic: 'autonomy' },
  { cmd: 'cloud list|refresh|improve|budget|backlog', desc: 'Cloud tasks and their PRs, a GitHub refresh, self-improvement launches (--count N), the credit budget (an estimate; flags update it) and the backlog.', topic: 'autonomy' },
  { cmd: 'mirror list|add|sync|path|remove|reconcile', desc: 'The fleet\'s own mirror clones under ~/.ashlr/fleet/mirrors (your checkouts are never touched); reconcile plans enrollment from the grant (--apply).', topic: 'autonomy' },
  { cmd: 'vision <show|review|preview|shadow|approve|reconcile|set>', desc: 'Mission OS: inspect strategy, preview a bounded DAG, record observation-only shadow evidence, or explicitly adopt planning state.', topic: 'autonomy' },
  { cmd: 'manager [--apply-rejects]',    desc: 'Frontier judge scorecard over pending proposals (shadow mode by default; never merges).', topic: 'autonomy' },
  { cmd: 'best-of-n [--repo --title -n]', desc: 'Generate N candidate diffs (multi-model), critic-select, file the winner as a proposal (M142/M333).', topic: 'autonomy' },
  { cmd: 'context read | write [--json]', desc: 'Read current company context or save a sourced note.', topic: 'run' },
  { cmd: 'comms <status|thread|send-owner|cycle|digest>',  desc: 'Operator comms. status --json, thread and send-owner are the one owner thread; replies go only to the configured owner. KILL halts adapters.', topic: 'autonomy' },
  { cmd: 'connectors add|list|remove|show|import [--json]', desc: 'Manage credential-free connector profiles and import safe client metadata; vault references only.', topic: 'autonomy' },
  { cmd: 'channels add <kind> | status [--json] | slack status|map [--json]', desc: 'Bring a channel up (config only, credentials stay in custody), read the per-channel rollup, or inspect the Slack bridge mapping offline.', topic: 'autonomy' },
  { cmd: 'imessage doctor|poll [--apply] [--json]', desc: 'iMessage intake: doctor checks permissions and config; poll counts waiting messages (dry run), --apply receipts them. Never prints message text.', topic: 'autonomy' },
  { cmd: 'director',                     desc: 'Retired — the Leader handles this (see `ashlr leader`). Still prints the read-only fleet god-view; sends nothing.', topic: 'autonomy' },
  { cmd: 'invent',                       desc: 'Generative backlog invention — propose novel high-value work items.', topic: 'autonomy' },
  { cmd: 'universe <demo|init|run|status|archive>', desc: 'Local experiment evolution: run competing code variants, measure them, and reuse winning artifacts.', topic: 'autonomy' },
  { cmd: 'universe console --root <absolute> [--port N] [--json]', desc: 'Foreground read-only Universe console on loopback; explicit root, ephemeral port by default, no service activation.', topic: 'autonomy' },
  { cmd: 'universe graph <id> [--node <node-id>]', desc: 'Read-only experiment evidence graph: trace selected parents, feedback, campaigns, and local branch receipts.', topic: 'autonomy' },
  { cmd: 'universe compare <baseline> <challenger>', desc: 'Compare explicit campaign outcomes and resource coverage; read-only local evidence, not production acceptance.', topic: 'autonomy' },
  { cmd: 'universe portfolio <plan|run> --manifest <file.json>', desc: 'Plan or run explicit campaign dependencies with foreground invocation bounds; completed campaigns are not accepted artifacts.', topic: 'autonomy' },
  { cmd: 'universe integration plan --manifest <private-absolute.json>', desc: 'Read-only composition of pinned local deliveries: inspect exact-path overlays and conflicts, without writing Git or claiming combined acceptance.', topic: 'autonomy' },
  { cmd: 'universe integration evaluate --manifest <private-absolute.json>', desc: 'Evaluate one pinned combined candidate locally; durable private evidence and confirmed-settlement replay, no model generation or Git publication.', topic: 'autonomy' },
  { cmd: 'universe integration inspect --manifest <private-absolute.json>', desc: 'Read and verify an existing evaluation receipt and digest; never starts missing work.', topic: 'autonomy' },
  { cmd: 'universe integration deliver --manifest <private-absolute.json>', desc: 'Deliver an explicitly pinned passing combination to a new local branch, without rerunning its evaluator or advancing an existing branch.', topic: 'autonomy' },
  { cmd: 'universe integration inspect-delivery --manifest <private-absolute.json>', desc: 'Verify a completed combined delivery and read its receipt digest without creating or reconciling branches.', topic: 'autonomy' },
  { cmd: 'universe integration handoff --manifest <private-absolute.json>', desc: 'Register a new explicit downstream experiment from the verified combined commit, with source lineage and a fresh comparator; no execution.', topic: 'autonomy' },
  { cmd: 'universe controller run --manifest <private-absolute.json>', desc: 'Run an explicitly enrolled campaign DAG with a persisted deadline and dispatch checkpoints across restarts; never retry uncertain work.', topic: 'autonomy' },
  { cmd: 'universe controller status <id>', desc: 'Read controller deadline, outcomes and unsettled dispatches without execution or recovery writes.', topic: 'autonomy' },
  { cmd: 'universe campaign <init|status|run|resume|pause|stop>', desc: 'Register, inspect, execute or request control of bounded campaigns; run/resume can pair --deliver-branch with --deliver-base for local-only delivery.', topic: 'autonomy' },
  { cmd: 'universe campaign check <id> --root <absolute> [--json]', desc: 'Read recorded recovery evidence only; exit 0 can include held or terminal snapshots and never grants permission to resume.', topic: 'autonomy' },
  { cmd: 'universe resources check --resource-runtime <private-absolute.json> [--json]', desc: 'Check explicit local resource configuration without provider contact; validity is not authentication, quota or campaign admission.', topic: 'autonomy' },
  { cmd: 'universe preparation-measurement --input <absolute-report.json> [--json]', desc: 'Read reported preparation checks and counts from one explicit file; diagnostic only, not a score or acceptance evidence. No store discovery, execution or provider calls.', topic: 'autonomy' },
  { cmd: 'universe preparation-measurement-calibrate <id> --root <absolute> --capture <id1> --capture <id2> --capture <id3> --expected-source-digest <sha256> [--json]', desc: 'Calibrate three retained diagnostic captures against their frozen seed; no execution or acceptance.', topic: 'autonomy' },
  { cmd: 'universe preparation-measurement-compare <id> --root <absolute> --capture <id> --calibration <absolute-json> [--json]', desc: 'Compare a captured candidate with full artifact scope and region regression checks; diagnostic only.', topic: 'autonomy' },
  { cmd: 'universe campaign supervise <id> [id ...] --root <absolute> --max-duration-ms <N> [--delivery-plan <private-absolute.json>]', desc: 'Bounded foreground supervision of a fixed queue; optional plan reconciles completed local branch deliveries without rerunning workers.', topic: 'autonomy' },
  { cmd: 'universe deliver <id> --trial <elite-trial-id> --branch codex/<name>', desc: 'Explicitly write the exact current elite to a local branch; no checkout change, merge, push or deployment.', topic: 'autonomy' },
  { cmd: 'universe deliveries <id> [--root <path>] [--json]', desc: 'Read local delivery receipts; pending/degraded evidence is not completed or verified delivery.', topic: 'autonomy' },
  { cmd: 'eval [--limit N]',             desc: 'Local-agent eval harness: adaptive prompts OFF vs ON, steps/done/tokens (M44).', topic: 'run' },
  { cmd: 'eval attention [--window 1d|7d|30d]', desc: 'Metadata-only fleet attention report: context pressure, retrieval, yield, routing, and traces.', topic: 'run' },
  { cmd: 'skills list [--status <s>] [--limit N] [--json]', desc: 'List skills learned from merged PRs (newest revision each; counts are real or "unknown").', topic: 'run' },
  { cmd: 'eval prompts --dataset <jobs.jsonl>', desc: 'Per-class prompt-variant A/B replay; promotes a variant only on a significant lift.', topic: 'run' },
  { cmd: 'skills audit <pack-path> [--json]', desc: 'Read-only quarantine audit for external skill structure, trigger routing, collisions, and behavioral fixtures.', topic: 'run' },
  { cmd: 'reflect [--since <Nd>]',       desc: 'Score your OWN past runs/swarms locally; report effectiveness/cost deltas (read-only).', topic: 'autonomy' },
  { cmd: 'reflect playbooks [--persist]', desc: 'Distill repeatable playbooks from past swarms (report-only; --persist writes them to the genome).', topic: 'autonomy' },
  { cmd: 'reflect propose',              desc: 'Emit routing/policy/prompt tuning suggestions as PENDING inbox proposals (never auto-applies).', topic: 'autonomy' },
  { cmd: 'health',                       desc: 'Score every ENROLLED repo on quality (tests/docs/deps/security/debt/CI/conventions); ranked, read-only.', topic: 'autonomy' },
  { cmd: 'health <repo>',                desc: 'Per-repo health detail with the per-dimension breakdown + worst offenders (ENROLLED only).', topic: 'autonomy' },
  { cmd: 'health propose',               desc: 'Emit deterministic safe-fix advisories as PENDING inbox proposals (never auto-applies).', topic: 'autonomy' },
  { cmd: 'sweep report [--repo <dir>]', desc: 'Write a local weekly deletion review report from a Phantom checkout.', topic: 'autonomy' },
  { cmd: 'digest',                       desc: 'Write an ORG-LEVEL portfolio digest (health, goals, costs, today) to ~/.ashlr/digests/ (LOCAL-FIRST; reads only).', topic: 'autonomy' },
  { cmd: 'digest --notify',              desc: 'Also deliver the digest via a configured Slack/Discord webhook (OPT-IN; no-op when unconfigured).', topic: 'autonomy' },

  { cmd: 'queue report --events <file> [--json]', desc: 'Local per-station lambda, mu, rho, W and bottleneck; queue --help describes event input.', topic: 'observability' },
  { cmd: 'queue add|claim|done|block|replay|list|import|export', desc: 'Local job queue with atomic claims, JSON snapshots and a read-only Markdown mirror.', topic: 'autonomy' },
  { cmd: 'issues [--retry] [--dir <queue-directory>] [--json]', desc: 'Group failed queue jobs by error; --retry queues one READY retry per failed job without duplicates.', topic: 'autonomy' },
  { cmd: 'signals [--json]', desc: 'Read real repository adoption signals.', topic: 'observability' },
  { cmd: 'radar list|run|diff [--json]', desc: 'Observe public docs and package metadata; GET only, six-hour per-source floor.', topic: 'observability' },
  { cmd: 'observe session <id> [--json]', desc: 'Read one roster session. Transcript stays unknown until desktop-operator registers a reader.', topic: 'observability' },
  { cmd: 'friction [--json]', desc: 'Mine the runs dir for recurring dispatch→merge friction; ledger keeps before/after metrics.', topic: 'observability' },
  { cmd: 'memory add|list|search|forget [--json]', desc: 'Durable markdown memory under ~/.phantom/memory; secret-shaped text refused.', topic: 'memory' },
  { cmd: 'app update status [--json]', desc: 'Read the local signed desktop-update stage and deferral counts; never downloads or installs.', topic: 'core' },
  { cmd: 'pulse [--window 1d|7d|30d]',   desc: 'Local observability dashboard: tokens, cost, sessions, commits.', topic: 'observability' },
  { cmd: 'pulse --json',                 desc: 'Machine-readable ActivityRollup (+ additive .forecast field; Raycast Pulse view).', topic: 'observability' },
  { cmd: 'pulse --project <name>',       desc: 'Restrict pulse rollup to a single project.', topic: 'observability' },
  { cmd: 'pulse-export',                 desc: 'Fleet→pulse OTLP backfill/manual export.', topic: 'observability' },
  { cmd: 'pulse-test',                   desc: 'Fleet→pulse connectivity + auth probe (read-only).', topic: 'observability' },
  { cmd: 'resource [--json] [--directory <fleet-directory>]', desc: 'Refresh the shared resource.v1 view in fleet.json from recorded inputs.', topic: 'observability' },
  { cmd: 'resources [--json] [--watch]', desc: 'Per-backend resource control plane: availability/used%/cap/resets-in (read-only god-view).', topic: 'observability' },
  { cmd: 'capacity publish [--json]', desc: 'Refresh local subscription usage metadata once with this node’s local authentication.', topic: 'observability' },
  { cmd: 'estates [--json] [--repo <repo-id>]', desc: 'Per-repo estate cards: health, CI, security. Read-only portfolio view.', topic: 'observability' },
  { cmd: 'main blame --good <sha> --check "<cmd>" [--bad <sha>] [--repo <path>] [--json]', desc: 'Name the first merge that turned the default branch red. Bisects in a temp worktree; read-only.', topic: 'observability' },
  { cmd: 'ci-metrics [--json]', desc: 'Per-repo daily turn-time (red to green) metrics; writes ~/.ashlr/ci-metrics.json.', topic: 'observability' },
  { cmd: 'daily-fix validate|filter|dispatch|parse-fixup [--json]', desc: 'Daily CI re-run helper: validate dispatch inputs against the allowlist, preview the job/test filter, emit the gh workflow command, or aggregate fixup-queue lines.', topic: 'observability' },
  { cmd: 'budget <show|add> [--json]', desc: 'Per-pool remaining budget: show the ledger, or record a manual reading or parsed CLI/log output. Manual readings override automatic ones until their reset; raw output is never stored.', topic: 'observability' },
  { cmd: 'budget get [--json]', desc: 'Read the owner spend budget in USD. A missing provider is 0 for the month. This does not change the budget.', topic: 'observability' },
  { cmd: 'budget set --provider <id> --period day|week|month --usd <n> [--json]', desc: 'Owner-only spend budget change from an interactive terminal, with one audit line. An amount above 0 stays ineffective until a Security pin-chain or owner signature root exists. Agents and non-TTY calls are refused. The committed default stays 0.', topic: 'observability' },
  { cmd: 'usage',                        desc: 'Frontier usage table: per-engine calls/tokens/cost + window state.', topic: 'observability' },
  { cmd: 'usage sensors [--json] [--refresh] [--file <snapshot>]', desc: 'Per-lane usage readings with age and stale status. A reading at or after staleAfter is unknown and is not headroom. Refresh uses official APIs and CLIs only.', topic: 'observability' },
  { cmd: 'route explain [--json]', desc: 'Read dispatcher pools and route-moves-per-hour.', topic: 'autonomy' },
  { cmd: 'pool admission [--json]', desc: 'Read-only load gate: loadavg, ncpu, running cap, install-lock holder and admit true/false with the reason.', topic: 'autonomy' },
  { cmd: 'queue dedupe [--file <router-queue.md>] [--apply] [--json]', desc: 'Find repeated READY jobs; preview by default, or mark repeats superseded with --apply.', topic: 'autonomy' },
  { cmd: 'queue stats [--json] [--window <seconds>]', desc: 'Sliding-window arrival/service rates, occupancy, wait and Little’s law drift.', topic: 'observability' },
  { cmd: 'repos rank [proposals] [--json] [--recompute]', desc: 'Repository scheduling rank from seed priority, local merged-PR recency and autonomy leverage (daily ceiling); proposals are read-only.', topic: 'observability' },
  { cmd: 'telemetry [status]',           desc: 'M19: endpoint+PAT configured (bool), sink mode, local JSONL count, governance.', topic: 'observability' },
  { cmd: 'telemetry test',               desc: 'Emit a synthetic metadata-only test span; report sink+ok.', topic: 'observability' },
  { cmd: 'audit [N] [--team <id>] [--json] [--action <verb>] [--result <r>] [--since <when>]', desc: 'Tail the append-only audit trail; --team lists workspace actions (read-only).', topic: 'observability' },
  { cmd: 'receipt list|status|show <run>|verify <run>|timeline <run> [--json]', desc: 'Read and verify signed run receipts (same as fleet receipt); timeline lists custody spawns in the run window, value-free (read-only).', topic: 'observability' },

  { cmd: 'mcp',                          desc: 'Run the MCP aggregation gateway on stdio (point any agent here; includes the native ashlr_* tools; list them with tools/list).', topic: 'integrations' },
  { cmd: 'checkpoint save <source> <destination> <worktree> [--json]', desc: 'Save a handoff with a Git worktree inventory. See docs/AGENT-CHECKPOINT.md.', topic: 'integrations' },
  { cmd: 'checkpoint resume <file> [--json]', desc: 'Validate and print a structured agent checkpoint for a fresh session. See docs/AGENT-CHECKPOINT.md.', topic: 'integrations' },
  { cmd: 'trail claim|beat|release <claim-key> [--json]', desc: 'Stigmergic work-item markers: claim a key, heartbeat progress, release. File-based coordination; no execution authority. See docs/STIGMERGY.md.', topic: 'autonomy' },
  { cmd: 'trail list|show|resume|sweep|save [--json]', desc: 'Read claim markers, pick up a stalled claim with its saved checkpoint, or evaporate expired markers. See docs/STIGMERGY.md.', topic: 'autonomy' },
  { cmd: 'sessions list|revoke <id> [--json]', desc: 'See running MCP gateway sessions and block one; every gateway call is logged (caller, tool, verdict) with arguments redacted, kept 14 days.', topic: 'integrations' },
  { cmd: 'sessions create|show|resume|terminate [sesn_id] [--json]', desc: 'Resumable agent sessions: agent profile id and version, environment id and an append-only event log; each turn is one phm queue job. Statuses idle, running, rescheduling, terminated.', topic: 'autonomy' },
  { cmd: 'mcp list',                     desc: 'List native ashlr tools + discovered MCP servers with per-server tool counts.', topic: 'integrations' },
  { cmd: 'mcp doctor',                   desc: 'Per-server MCP health: does it start? how many tools?', topic: 'integrations' },
  { cmd: 'autopilot <pr> [--apply] [--watch]', desc: 'Drive one of Phantom\'s own PRs to green: fix red CI and review feedback with an agent, merge a conflicting or behind base, re-run infra failures once, re-verify; stops and says why when a failure is not the PR\'s. Plan only unless --apply; never force-pushes or merges the PR.', topic: 'integrations' },
  { cmd: 'metrics <summary|dashboard|record|recommend|ingest|levers>', desc: 'Local telemetry: value-weighted PRs shipped per token/second/$, leaderboards, UCB1 allocation, HTML dashboard, router-metrics ingest and opportunity proxies.', topic: 'integrations' },
  { cmd: 'improve propose [--open-pr --repo <dir>]', desc: 'Self-improvement loop: evidence-backed proposals ranked by realized leverage; --open-pr opens DRAFT PRs from an isolated worktree.', topic: 'integrations' },
  { cmd: 'improve register|measure|outcomes|promote|sync-backlog|discover|observe|lessons', desc: 'Record a proposal\'s deterministic metric, measure it at the PR\'s exact merge base and head, record merges and the reverts that cancel their credit, compare proposers against the deterministic baseline, register cloud backlog PRs that declare a metric, add backlog items from member issues, a red default branch and proposals, compare cloud runs served lessons against the holdout run without them, and queue auto-merge only when checks are green and the metric improved.', topic: 'integrations' },
  { cmd: 'steward disk [--apply] [--json]', desc: 'Measure Codex/Claude/Phantom log roots against retention + quota; dry run unless --apply (deletes oldest eligible files only).', topic: 'integrations' },
  { cmd: 'lanes fit --lane <lane> [--json]', desc: 'Show job kinds to send or avoid from measured PR rates.', topic: 'observability' },
  { cmd: 'lanes health [--json]', desc: 'Per-lane calls, error rate, p50 latency and deployed commit over 12 h; flags runs stuck past their phase timeout.', topic: 'observability' },
  { cmd: 'team <view|join|invite|role|link|approve|claim|release|say>', desc: 'Local-first team bus: presence, repo/branch/path claims, handoffs and human approval of consequential agent actions.', topic: 'integrations' },
  { cmd: 'companions [--json] [--root <dir>] [--bin-dir <dir>]', desc: 'Read-only Secrets/Locus/Lexicon executable identity and version inventory; no runtime readiness or activation.', topic: 'integrations' },
  { cmd: 'mcp install <claude|ashlrcode>', desc: 'Add the ashlr gateway to a target mcpServers config (backs up first).', topic: 'integrations' },
  { cmd: 'gh <pr|issue|ci>',             desc: 'Read GitHub open PRs, issues, or CI status for the current repo (read-only).', topic: 'integrations' },
  { cmd: 'gh pr create',                 desc: 'Create a PR via gh CLI — explicit + confirm-gated (the only gh mutation).', topic: 'integrations' },
  { cmd: 'vercel <ls|logs>',             desc: 'Read recent Vercel deployments or latest build logs (read-only).', topic: 'integrations' },
  { cmd: 'wire [claude|codex|cursor|all]', desc: 'Wire ashlr MCP gateway into editor config(s); defaults to detected editors.', topic: 'integrations' },
  { cmd: 'wire status [claude|codex|cursor|gemini|all]', desc: 'Read-only report of whether each editor is wired to the ashlr gateway.', topic: 'integrations' },
  { cmd: 'wire --claude-md',             desc: 'Print a CLAUDE.md snippet teaching agents the CLI-first ashlr usage (read-only).', topic: 'integrations' },
  { cmd: 'notify test',                  desc: 'Send a test ping to the configured webhook(s); no-op if none are set.', topic: 'integrations' },
  { cmd: 'stack [status|list|providers|recommend|scan|doctor|add|apply]', desc: 'Ecosystem `stack` tool surface: read-only status/list/recommend, confirm-gated add/apply (real provisioning).', topic: 'integrations' },
  { cmd: 'ecosystem doctor [--json] [--deep]', desc: 'Read-only sibling-repository health scan across the ecosystem.', topic: 'integrations' },

  { cmd: 'worktrees prune [--dry-run | --apply] [--json]', desc: 'Preview or remove clean, inactive worktrees for finished jobs.', topic: 'safety' },
  { cmd: 'worktrees report [--dir <path>] [--json]', desc: 'Report worktree age, size, last log time and job state.', topic: 'safety' },
  { cmd: 'disk [--wt-dir <abs>] [--json]', desc: 'Read-only disk report for agent worktrees: sizes, lifecycle state, and the bytes safe to reclaim.', topic: 'safety' },
  { cmd: 'disk-maint [--apply] [--json] [--only <class>] [--allow <class>]', desc: 'Standing disk maintenance: rotate/compress quiet logs, prune dead session leftovers, stale staging and recovery dirs, and remove merged worktrees. Dry run unless --apply; protect-list never touches ~/.codex*, model weights, Docker, client trees or secrets.', topic: 'safety' },
  { cmd: 'node join|beat|enqueue|plan|pull|complete|status [--json]', desc: 'Join this computer to the node router: caps, owner-scoped jobs, fenced per-job leases.', topic: 'safety' },
  { cmd: 'node bootstrap --dry-run [--json]', desc: 'Plan a persistent Linux node; registry integration is a stub, no provisioning.', topic: 'safety' },
  { cmd: 'sandbox list',                 desc: 'List active git-worktree sandboxes (M21 safety foundation).', topic: 'safety' },
  { cmd: 'sandbox diff <id>',            desc: 'Show diff of a sandbox vs its base HEAD.', topic: 'safety' },
  { cmd: 'sandbox cleanup <id>',         desc: 'Remove a sandbox worktree and scratch branch.', topic: 'safety' },
  { cmd: 'sandbox gc',                   desc: 'Reclaim STALE orphan sandboxes (crash leftovers); H5 explicit human repair surface for the orphan sweep.', topic: 'safety' },
  { cmd: 'seams',                        desc: 'Cloud-ready seam diagnostic: every v2 store, active=local, cloud=gated (read-only).', topic: 'safety' },
  { cmd: 'seams status',                 desc: 'Same as `seams`: list seams + active impl; proves local-first + cloud gated on Mason.', topic: 'safety' },
  { cmd: 'test --changed [--base <ref>] [--json]', desc: 'Run tests related to changed files, or the full suite when unknown.', topic: 'safety' },
  { cmd: 'verify change --worktree <path> [--checks typecheck,unit,lint,secrets]', desc: 'Run trusted worktree checks; JSON verdict and ten-line handoff.', topic: 'safety' },
  { cmd: 'engineering-receipt --events <file.jsonl> [--claims <file>] [--task <text>] [--json]', desc: 'Engineering receipt from tool events (Evidence) vs model statements (Claims); needs PHANTOM_RECEIPTS=1.', topic: 'safety' },
  { cmd: 'verify-safety',                desc: 'Read-only self-check of the hard safety invariants (enrollment/kill-switch/daemon/scrub/cloud-gate); mutates nothing.', topic: 'safety' },
  { cmd: 'verify-pr',                    desc: 'Verify an explicitly reviewed maintainer PR through the host-owned App check; no merge or deploy.', topic: 'safety' },
  { cmd: 'preflight [--json]',           desc: 'Read-only first-activation readiness check: ready=true|false + blockers/warnings (model/enrollment/kill/daemon/writeable/sandbox/git/phantom/locus); mutates nothing.', topic: 'safety' },
  { cmd: 'onboard [--locus-firm]',       desc: 'Guided first safe activation: preflight → enroll ONE repo → optional Locus firm soft-offer → dry-run PLAN → point at `ashlr inbox`. TTY-aware; --yes/non-TTY prints steps (firm only with --locus-firm or ASHLR_LOCUS_FIRM=1). NEVER auto-applies.', topic: 'safety' },
  { cmd: 'onboard --rollback <repo>',    desc: 'One-command undo of a first activation: unenroll + sweep orphan sandboxes + optional --kill. Inward cleanup only; H6-audited.', topic: 'safety' },
  { cmd: 'demo [--no-cleanup] [--json]', desc: 'Watch the FULL autonomous chain run on a DISPOSABLE tmp repo (isolated tmp ~/.ashlr; proposal-only; auto-cleans). NEVER touches your portfolio or applies anything.', topic: 'safety' },

  { cmd: 'goals [--json]', desc: 'Show dispatcher throughput, empty rates and resource resets.', topic: 'observability' },
  { cmd: 'top [--once] [--json]', desc: 'Read-only per-pool capacity and reset pressure snapshot.', topic: 'web' },
  { cmd: 'tui [--once]',                 desc: 'Interactive terminal dashboard (alias: dash). --once renders one frame and exits.', topic: 'web' },
  { cmd: 'dash [--once]',                desc: 'Alias of `tui` — interactive terminal dashboard.', topic: 'web' },
  { cmd: 'dashboard [--stop|--status]',  desc: 'Open the persistent fleet dashboard service (ai.ashlr.serve); --status/--stop inspect or unload it (no install/repair — resident mutation is withheld).', topic: 'web' },
  { cmd: 'serve [--port N]',             desc: 'Start local web dashboard + JSON API on 127.0.0.1 (default port 7777).', topic: 'web' },
  { cmd: 'serve --open',                 desc: 'Start dashboard and open browser automatically.', topic: 'web' },
  { cmd: 'serve --allow-dispatch',       desc: 'Enable guarded POST /api/run + web inbox approve/reject (prints session token).', topic: 'web' },
  { cmd: 'verse [--port N] [--no-open]', desc: 'Open the Phantom console at /verse/ for connected coding resources. Runs use account readiness and authority; prints read + mutation tokens.', topic: 'web' },

  { cmd: 'new <name> [opts]',            desc: 'Scaffold a project from a template (next-app, node-cli, mcp-server, minimal).', topic: 'scaffold' },
  { cmd: 'ship [path] [opts]',           desc: 'Pre-ship gate (lint/test/build) + optional confirm-gated deploy.', topic: 'scaffold' },
];

/** Per-topic example blocks (relocated from the former inline cmdHelp). */
const TOPIC_EXAMPLES: Partial<Record<HelpTopic, string[]>> = {
  run: [
    'ashlr run "list all open GitHub issues in this repo"',
    'ashlr run "summarize recent commits" --budget 8000 --max-steps 5',
    'ashlr run "audit TODOs" --no-memory          # skip genome injection',
    'ashlr run show <id>                          # inspect a past run',
    'ashlr run "x" --estimate                     # predict cost before running',
  ],
  swarm: [
    'ashlr spec new "build a REST API with auth and tests"',
    'ashlr swarm "build a REST API with auth" --dry-run   # plan only',
    'ashlr swarm spec-abc123 --budget 40000 --parallel 3',
    'ashlr swarm "refactor auth module" --background      # detached',
  ],
  memory: [
    'ashlr recall "how does the orchestrator work"',
    'ashlr learn "prefer bge-m3 for embeddings" --tags embeddings,ollama',
    'ashlr learn "ashlr-hub uses NodeNext ESM" --project ashlr-hub',
  ],
  scaffold: [
    'ashlr new my-app --template next-app',
    'ashlr new my-tool --template node-cli --category dev-tools',
    'ashlr ship --deploy vercel --confirm                 # gate + REAL deploy',
  ],
  autonomy: [
    'ashlr enroll add ~/code/my-repo && ashlr backlog refresh',
    'ashlr daemon start --once --dry-run                  # plan only',
    'ashlr run "<goal>"                                   # owner-invoked one-shot work',
    'ashlr swarm "<goal>"                                 # owner-invoked multi-agent work',
    'ashlr fleet direction --json                         # resource-aware mode recommendation',
    'ashlr inbox && ashlr inbox approve <id>',
  ],
};

/** Flag reference lines printed with `help run` / `help swarm` / `help --all`. */
const FLAG_LINES: Partial<Record<HelpTopic, string[]>> = {
  run: ['--budget N  --max-steps N  --parallel N  --engine builtin|ashlrcode|aw|claude|codex  --allow-cloud  --no-tools  --no-memory  --resume <id>  --estimate  --json  --over-budget'],
  swarm: ['--budget N  --parallel N (positive safe integer; default 3)  --background  --resume <id>  --dry-run  --estimate  --allow-cloud  --project <path>  --over-budget'],
};

const TOPICS: HelpTopic[] = [
  'core', 'run', 'swarm', 'memory', 'knowledge', 'autonomy',
  'observability', 'integrations', 'safety', 'web', 'scaffold',
];

function renderEntries(entries: HelpEntry[]): string {
  const c = makeColors(isTty());
  const w = Math.max(...entries.map((e) => e.cmd.length));
  return entries.map((e) => `    ${c.cyan(pad(e.cmd, w))}  ${e.desc}`).join('\n');
}

/** All command entries tagged with a given topic (single source of truth). */
function entriesForTopic(topic: HelpTopic): HelpEntry[] {
  return HELP_ENTRIES.filter((e) => e.topic === topic);
}

function renderTopic(topic: HelpTopic): void {
  const c = makeColors(isTty());
  const entries = entriesForTopic(topic);
  console.log('');
  console.log('  ' + c.bold(TOPIC_LABELS[topic]));
  console.log('');
  console.log(renderEntries(entries));
  const flags = FLAG_LINES[topic];
  if (flags) {
    console.log('');
    for (const f of flags) console.log('  ' + c.bold('flags:') + ' ' + c.dim(f));
  }
  const examples = TOPIC_EXAMPLES[topic];
  if (examples) {
    console.log('');
    console.log('  ' + c.bold('Examples:'));
    for (const ex of examples) console.log(`    ${c.cyan(ex)}`);
  }
  console.log('');
}

function renderSummary(): void {
  const c = makeColors(isTty());
  console.log('');
  console.log(c.bold('  Phantom') + c.dim(' — phm, the CLI for agentic engineers (ashlr remains compatible)'));
  console.log('');
  for (const topic of TOPICS) {
    const entries = entriesForTopic(topic);
    const headliners = entries.slice(0, 3).map((e) => e.cmd.split(' ')[0]);
    const unique = [...new Set(headliners)].join(', ');
    console.log(`    ${c.cyan(pad(topic, 14))}  ${TOPIC_LABELS[topic]} ${c.dim(`(${unique}, …)`)}`);
  }
  console.log('');
  console.log('  ' + c.dim('phm init') + ' · ' + c.dim('phm doctor') + ' · ' + c.dim('phm verse') + '  start here: onboard, health check, console');
  console.log('  ' + c.dim('phm help <topic>') + '      full table for one topic');
  console.log('  ' + c.dim('phm help --search <t>') + ' find a command by keyword');
  console.log('  ' + c.dim('phm help --all') + '        every command (the legacy full table)');
  console.log('  ' + c.dim('phm docs --agent') + '      the agent contract cheat sheet');
  console.log('');
}

function renderAll(): void {
  const c = makeColors(isTty());
  console.log('');
  console.log(c.bold('  Phantom') + c.dim(' — every command (phm or ashlr)'));
  for (const topic of TOPICS) {
    console.log('');
    console.log('  ' + c.bold(TOPIC_LABELS[topic]));
    console.log(renderEntries(entriesForTopic(topic)));
  }
  console.log('');
  for (const [t, lines] of Object.entries(FLAG_LINES)) {
    for (const f of lines ?? []) console.log('  ' + c.bold(`${t} flags:`) + ' ' + c.dim(f));
  }
  console.log('');
}

/** `ashlr help [<topic>] [--search <term>] [--all]` — exit 0, except 2 for an unknown topic. */
export async function cmdHelp(args: string[]): Promise<number> {
  const c = makeColors(isTty());

  if (args.includes('--all')) {
    renderAll();
    return 0;
  }

  const searchIdx = args.indexOf('--search');
  if (searchIdx !== -1) {
    const term = (args[searchIdx + 1] ?? '').toLowerCase();
    if (!term) {
      console.log(c.dim('usage: ashlr help --search <term>'));
      return 0;
    }
    const hits = HELP_ENTRIES.filter(
      (e) => e.cmd.toLowerCase().includes(term) || e.desc.toLowerCase().includes(term),
    );
    console.log('');
    if (hits.length === 0) {
      console.log(c.dim(`  no commands match "${term}" — try \`ashlr help --all\``));
    } else {
      console.log(renderEntries(hits));
    }
    console.log('');
    return 0;
  }

  const topicArg = args.find((a) => !a.startsWith('-'));
  if (topicArg) {
    if ((TOPICS as string[]).includes(topicArg)) {
      renderTopic(topicArg as HelpTopic);
      return 0;
    }
    // `phm help doctor` names a command, not a topic: show that command's rows.
    const wanted = topicArg.toLowerCase();
    const commandHits = HELP_ENTRIES.filter((e) => e.cmd.split(/\s+/)[0]?.toLowerCase() === wanted);
    if (commandHits.length > 0) {
      console.log('');
      console.log(renderEntries(commandHits));
      console.log('');
      console.log('  ' + c.dim(`phm help ${commandHits[0]!.topic}`) + '  more commands in this topic');
      console.log('');
      return 0;
    }
    // Unknown topic is a usage error (exit 2, like an unknown command) so agents can tell a typo from success.
    console.error(`Unknown help topic "${topicArg}".`);
    const { didYouMean } = await import('./completions.js');
    const lower = topicArg.toLowerCase();
    const guess = TOPICS.find((t) => t.startsWith(lower)) ?? didYouMean(lower, TOPICS);
    if (guess) console.error(`Did you mean ${c.cyan(`phm help ${guess}`)}?`);
    console.error(c.dim(`Topics: ${TOPICS.join(', ')}. Run \`phm help\` for the list.`));
    return 2;
  }

  renderSummary();
  return 0;
}
