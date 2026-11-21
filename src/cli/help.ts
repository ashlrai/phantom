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
  { usage: 'phm fleet empties [--since 24h] [--jobs <jobs.jsonl>] [--runs-dir <directory>] [--human | --json]', description: 'Read EMPTY finishes, evidence-only causes, empty rates and top five job families. JSON by default; unknown evidence stays unknown. Exit 1 unreadable metrics, 2 invalid arguments.', safety: 'read', jsonShape: 'fleet.empties.v2' },
  { usage: 'phm sessions threads [--lane <lane>] [--repo <repo>] [--live] [--json]', description: 'Every agent session as a short conversation in one read: the summary `phm sessions thread <id>` builds and the newest 3 messages of each, what Mason wrote to it in the Leader inbox, the jobs the Leader routed each message to and the last 3 lines a running session wrote to its log included, leader first, then each worker followed by its helpers. Up to 40 sessions; message text is cut at 400 characters. --live shows only running ones. Exit 0 read, 1 session list unreadable, 2 usage.', safety: 'read', jsonShape: 'SessionThreadsV1 {schema:fleet.session-threads.v1,generatedAt,filter:{lane,repo,live},counts:{sessions,shown,states:{running,quiet,idle,done,failed,unknown}},threads:[{session:{id,kind,agent,lane,model,repo,jobId,parentId,state,startedAt,ageSeconds,lastMessageAt,lastMessageAgeSeconds,prUrl,computer,helpers},summary:[string],messages:[{key,kind,side,label,at,text,format,truncated}],messageCount,sources,gaps,reply:{to,mention,hint}}],sources:{sessions,bus,owner,replies,orders},gaps}' },
  { usage: 'phm sessions tail <id> [--follow] [--lines N] [--json]', description: 'What one session is doing now, the same stream the map side panel shows: lane, model, start and PR, then its last N log lines (1..200, default 200), every line redacted. --follow streams new lines until it finishes. The id is the job id `phm sessions` shows. Exit 0 read, 1 unreadable, 2 usage or unknown id.', safety: 'read', jsonShape: 'One object per line: {ts,source:log|event|status,text}; the first is the status line with status, detail:{state,lane,tier,model,launchedAt,prUrl,repo,tokens} and controls:{available,reason}' },
  { usage: 'phm sessions thread <id> [--json]', description: 'One session as a conversation: a summary assembled from its records, then its brief, recorded steps, commands, changed files, notes, the agent bus messages about it, the messages Mason wrote to it in the Leader inbox, where those messages were routed (the job, its lane, its state and its PR, from the order trace), the last 12 lines it wrote to its log (redacted) and its last message, then where a message written to it goes. The id is leader, a job id or a subagent id from `phm sessions`. Nothing is written by a model; a part that could not be read is named in gaps. Exit 0 read, 1 session list unreadable, 2 usage or unknown id.', safety: 'read', jsonShape: 'SessionThreadV1 {schema:fleet.session-thread.v1,generatedAt,id,session:{id,kind,agent,lane,model,repo,jobId,parentId,state,startedAt,ageSeconds,lastMessageAt,lastMessageAgeSeconds,prUrl,computer,helpers:{below,running,failed}}|null,summary:[string],messages:[{key,kind,side,label,at,text,format}],sources:{sessions,activity,bus,owner,replies,orders,output},gaps,reply:{to,mention,hint}}' },
  { usage: 'phm sessions reconcile [--json]', description: 'Reconcile local runs with process observations and attempt-scoped job metrics. Old heartbeats alone never prove a run ended. Read-only; exit 0 report, 2 usage.', safety: 'read', jsonShape: 'SessionReconciliation {schema:fleet.session-reconciliation.v1,readOnly:true,generatedAt,runsDirPresent,sources,dispatcher,truncated,malformed,counts:{live,finished,unknown},runs:[{job,repo,lane,status,live,pid,startedAt,lastOutputAt,finishedAt,exitCode,state,reason}]}' },
  { usage: 'phm bots list|seats|handoffs|handoff --seat <id> [--apply]|show <id>|explain <id>|create --dry-run --id <id> --outcome <text> --profile <id> [--json]', description: 'Inspect bot metadata and seat quota; handoffs plans every seat\'s pending draining work, handoff --seat plans or applies one (dry run unless --apply). Live creation refused.', safety: 'append', jsonShape: 'phantom-bot.v1, phantom-bot-seats.v1, phantom-bot-handoffs-plan.v1 or phantom-bot-handoff-plan.v1' },
  { usage: 'phm release notes [--since <tag-or-date>] [--repo <name>] [--json] [--markdown] [--write]', description: 'Draft local mainline release notes. --markdown prints plain words for a reader: a three-sentence summary, then short lists under plain headings. --write updates only the generated Unreleased changelog block. With --repo <name> (needs --since <tag>) it reads merged PR titles and bodies from GitHub instead and groups them Added, Changed, Fixed, Security; internal-only PRs are dropped and --markdown prints a CHANGELOG section. Exit 0 success, 1 unavailable history/write failure, 2 usage.', safety: 'append', jsonShape: 'phantom.release-notes.v1 (or phantom.release-notes-prs.v1 {repo,since,summary,sections:{Added,Changed,Fixed,Security:[{text,prs}]},skipped,unknown,complete} with --repo) {since,head,summary,headline[],sections:[{heading,lines:[{text,count,prs}]}],groups:{New,Improved,Fixed,Internal}}; group entries: {text,prs,commits}' },
  { usage: 'phm releases [--json]', description: 'Which Ashlr repo is due a release. Per repo: latest tag, age in days, PRs merged since, a verdict (fresh, due, no release yet, unknown) and one plain line. Due means over 7 days or over 50 merged PRs. recentPrs lists up to 5 merged PR titles per repo (number and title), null when unknown. next names the single most overdue repo. The morning leader brief ends with one line: Release due: <repo>, <N> PRs since <tag>, <D> days. Reads local clones only; never tags or publishes. Exit 0 report, 2 usage.', safety: 'read', jsonShape: 'phantom.releases.v1 {version,checkedAt,dueWhen,counts,repos:[{repo,latestTag,taggedAt,ageDays,mergedPrsSince,recentPrs:[{number,title}]|null,verdict,suggestion}],next}' },
  { usage: 'phm release cadence [--repos <a,b>] [--json]', description: 'How stale is each repo\'s latest release (phantom, phantom-secrets, ashlr-plugin, ashlr-stack, locus, lexicon, ashlr-md), read from public GitHub. fresh: under 6 hours old or nothing merged since. due: 6 to 24 hours with merges since. stale: over 24 hours with merges since. has_assets is false for a release with 0 assets. Unreadable values print as unknown. fleet pulse --alerts raises release_stale from the same read. Never tags or publishes. Exit 0 report, 2 usage.', safety: 'read', jsonShape: 'phantom.release-cadence/v1 {schema,as_of,repos:[{repo,latest_tag,published_at,has_assets,hours_since,merged_since,status}]}' },
  { usage: 'phm log [--since 6h] [--lane <lane>] [--repo <repo>] [--json]', description: 'What the fleet did, one row per job, newest first: when, lane, model, repo, goal, result in plain words (merged PR N, closed, no change, failed: reason, still running) and time to merge, under a one-line summary and one line per lane. Reads the same ledger projection as phm worklog. Anything not recorded is null in JSON and unknown in text. Exit 0 report, 1 read failure, 2 bad usage.', safety: 'read', jsonShape: 'joblog.v1 {version,hours,headline,summary:{jobs,merged,noChange,noChangeRate,medianMergeSeconds,lanes:[{lane,jobs,merged,noChange,noChangeRate,medianMergeSeconds}]},jobs:[{job,at,lane,model,repo,goal,result,text,pr,url,mergeSeconds}],sources:{jobs:{state,reason?}},malformedLines}' },
  { usage: 'phm worklog [--hours 6] [--kind merged|launched|finished|empty|leader|incident] [--repo <repo>] [--lane <lane>] [--json]', description: 'One feed of what the fleet did, newest first: merges, launches, finishes, empty jobs, leader replies and incidents, one plain-words line each. An unreadable source is reported as unknown with a reason. Exit 0 report, 1 read failure, 2 bad usage.', safety: 'read', jsonShape: 'worklog.v3 {hours,rows:[{at,kind,job,lane,repo,text,url,count}],sources:{jobs,events,leader:{state,reason?}},entries:[{kind,at,job,repo,lane,model,mergedAt,openToMergeSeconds,url}],malformedLines}' },
  { usage: 'phm decide --question <text> --options <a,b,c> [--context <file>] [--json]', description: 'Ask one question with a fixed list of answers. The router picks its cheapest verified model; the reply is checked against the options and retried once. Prints an option, or unknown instead of a guess. Logs one metrics event line without the question or context. Exit 0 chosen, 1 unknown, 2 bad usage.', safety: 'append', jsonShape: '{version: 1, choice: <an option>|unknown, confidence: 0..1, reason, model, latency_ms}' },
  { usage: 'phm queue wait [--events <file>] [--json]', description: 'Show the oldest recorded queued PR and why it is waiting. Read-only; required checks stay enforced. Exit 0 known, 1 unknown, 2 usage.', safety: 'read', jsonShape: 'queue.wait.v1 {state:queued|empty|unknown,oldestQueued:{repo,pr,enqueuedAt,waitingSeconds,reason,reasonSince}|null}' },
  { usage: 'phm queue batches [--runs <directory>] [--json]', description: 'Read batch sessions and per-line PR, empty, failed or unknown results. Local receipts only; never launches or publishes.', safety: 'read', jsonShape: 'phantom.queue-batches.v1 {evidence,sessions:[{id,repo,area,outcomes:[{job,outcome,pr,reason,autoMerge}]}],totals,gaps}' },
  { usage: 'phm queue visits-sync [--jobs <path>] [--queue <path>] [--journal <path>] [--apply] [--json]', description: 'Fold the jobs ledger and live router queue into station visits for the visit journal that queue stats reads. Dry run unless --apply; derived visits use recorded timestamps only, missing boundaries stay open or absent. Exit 0 ok, 1 unreadable input, 2 usage.', safety: 'append', jsonShape: 'queue.visits-sync.v1 {applied,jobs,queue,journal,derived,plan:{append,unchanged,regression,appended}}' },
  { usage: 'phm fleet vitals [--runs-dir <directory>] [--json]', description: 'Read first-minute launch process and sampled CPU costs, plus the top three causes of empty jobs in 24 hours. Missing or incomplete evidence stays unknown or partial; no launches or writes.', safety: 'read', jsonShape: 'fleet.vitals.v1 {status,disk,launch,launchCost:{source,state,launches},emptyCauses:{total,top},stuck:{count,oldestAgeSeconds}}' },
  { usage: 'phm app restart --json', description: 'Report held restart: UI-owned sessions, PTYs and computer-use workers require runtime migration. Does not restart or replace the app. Exit 1 held, 2 usage.', safety: 'read', jsonShape: '{schema: phantom-app-restart/v1, state: held, restarted: false, reason, blockers}' },
  { usage: 'phm fleet feedback scan [--apply] [--days 1..30] [--runs-dir <absolute>] [--json]', description: 'Collect and triage feedback; preview by default. Apply stages at most five deduplicated jobs through existing drop admission. Never merges. Exit 1 for incomplete evidence or failure, 2 for usage.', safety: 'append', jsonShape: 'fleet.feedback.v1 {sources,candidates,queued,deferred,errors}' },
  { usage: 'phm fleet feedback digest [--json]', description: 'Read the trailing twelve hours of merged PRs, jobs needing review, failures and last recorded launches. No sends or writes.', safety: 'read', jsonShape: 'fleet.feedback.v1 {sources,digest}' },
  { usage: 'phm amplify status|goal [--json] [--limit 1..100 (goal only)]', description: 'Offline objective snapshot and recent leader decisions. Missing or stale measurements are unknown. Exit 0 report, 1 IO failure, 2 usage.', safety: 'read', jsonShape: 'amplify.status.v1 | amplify.goal.v1' },
  { usage: 'phm amplify tick [--json]', description: 'One advisory iteration: appends ADVISORY actions to metrics/amplify.jsonl; never changes fleet state. Exit 0 recorded, 1 IO failure, 2 usage.', safety: 'append', jsonShape: 'amplify.status.v1; journal amplify.tick.v1' },
  {
    usage: 'phm onboard --ecosystem [--json] | phm onboard --ecosystem --grant --plan <planId> --select <id,id> [--json]',
    description: 'Detect existing capabilities, then grant one reviewed integration bundle. Names/state only; imports and locked-vault access stay in a trusted terminal. --yes never grants. Exit 0 preview/complete, 1 incomplete wiring, 2 refusal.',
    safety: 'append',
    jsonShape: 'EcosystemPlan {schemaVersion:1,phase:"preview",planId,capabilities[]} | EcosystemReceipt {schemaVersion:1,phase,grantId,planId,results[]} | {ok:false,error}',
  },
  {
    usage: 'phm bus send --from <label> --to <label> --body <json> [--id <id>] [--priority P0|P1|P2|P3] [--ttl <ms>] --json',
    description: 'Append one local durable mailbox message. Same ID and identical envelope deduplicate without renewing TTL. Labels grant no identity or authority; no remote dispatch or engine execution. Exit 0 accepted/replayed, 1 operational refusal, 2 usage.',
    safety: 'append',
    jsonShape: '{ok:true,id,replayed} or {ok:false,error:{code,message}}',
  },
  {
    usage: 'phm bus inbox --to <label> [--limit <1..1000>] --json',
    description: 'Read pending, unexpired local mailbox messages in priority/acceptance order; does not acknowledge. hasMore reports truncation. Unreadable/incomplete storage refuses; missing storage is empty. Exit 0 read, 1 operational refusal, 2 usage.',
    safety: 'read',
    jsonShape: '{ok:true,messages:BusEnvelope[],hasMore} or {ok:false,error:{code,message}}',
  },
  {
    usage: 'phm bus recent [--since 5m] --json',
    description: 'Agent-to-agent messages from the last 5 minutes (or --since 10m, 2h, 1d), newest first, each with a plain summary of at most 100 characters; "No messages yet." when none. Read-only. Exit 0 read, 1 bus unreadable, 2 usage.',
    safety: 'read',
    jsonShape: 'bus.recent.v1 {schema,as_of,messages:[{at,from,to,kind,summary}]|null}',
  },
  {
    usage: 'phm bus ack <id> --to <label> --json',
    description: 'Append an idempotent local mailbox acknowledgment after checking the stored recipient. Same-user routing labels are not authenticated identities. Exit 0 acknowledged/replayed, 1 operational refusal or missing message, 2 usage.',
    safety: 'append',
    jsonShape: '{ok:true,id,acknowledged:true,replayed} or {ok:false,error:{code,message}}',
  },
  {
    usage: 'phm constitution check [--root <repo>] [--json] [prompt-or-template-path ...]',
    description: 'Validate constitution rule IDs and prompt/template references. Read-only; exit 0 valid, 1 invalid or unreadable input, 2 bad usage.',
    safety: 'read',
    jsonShape: '{ ok, ruleCount, referenceCount, filesChecked, diagnostics: [{ path, line, id, kind }] }',
  },
  { usage: 'phm commands [--json]', description: 'List every user-facing command with its description, argument forms and whether it changes state. Unclassified commands report changesState true. Read-only; exit 0, 2 usage.', safety: 'read', jsonShape: 'phantom.commands.v1 {schema,commands:[{name,description,arguments:[form],changesState,needsInput}]}' },
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
    usage: 'phm connectors config --client claude|cursor|codex --lane <lane> [--project <dir>] [--json]',
    description: 'Print client MCP entries whose servers launch through phm connectors exec (credentials come from phantom exec as session tokens, never in the entry). Every entry passes the secret-shape gate; writes nothing. Exit 0, 1 skipped entries, 2 invalid.',
    safety: 'read',
    jsonShape: '{client, lane, format, servers, skipped, config} | {ok:false,error}',
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
  { usage: 'phm publish resume --branch <codex-bridge/job|job> [--repo <name>] [--json]', description: 'Finish a half-done publish: open the PR for a pushed fork branch and turn on auto-merge through the merge queue. Exit 0 done, 1 branch missing or GitHub unavailable, 2 bad usage.', safety: 'append', jsonShape: 'publish.resume.v1 {status:opened|already-open|already-merged|already-on-main|missing,pr_url,branch,repo,auto_merge?:{on,detail}} | publish.error.v1 {ok:false,error}' },
  { usage: 'phm publish orphans [--repo <name>] [--json]', description: 'List your fork codex-bridge/ branches from the last 48 hours that have no PR. Read-only.', safety: 'read', jsonShape: 'publish.orphans.v1 {repo,window_hours:48,orphans:[{branch,sha,pushed_at,age_hours}]} | publish.error.v1' },
  { usage: 'phm fleet republish [--dry-run] [--runs-dir <dir>] [--json]', description: 'Preview recovery of fork pushes followed by a publish abort. Read-only; exit 0 complete, 1 unknown evidence, 2 bad usage.', safety: 'read', jsonShape: 'fleet.republish.v1 {readOnly:true,status,jobs:[{job,status,reason,head,sha,readyLine,pr_state:none|open|merged|closed|unknown}]} | {status:unknown,reason,jobs:null}' },
  { usage: 'phm fleet deploy-plan --since <sha> [--repo <path>] [--bin <path>] [--json]', description: 'Find committed fleet scripts without matching live copies. Read-only; pinned or unknown files need Security review. Exit 0 compared, 1 unreadable live file, 2 invalid input or unavailable evidence.', safety: 'read', jsonShape: 'FleetDeployPlan {schema:fleet.deploy-plan.v1,since,head,checked,inSync,files:[{repoPath,livePath,repoSha256,liveSha256,shaPinned,status,action}]} | {schema,error}' },
  { usage: 'phm fleet restock plan [--json]', description: 'Check READY candidates before grouping 6–10 items per repo. Read-only; exclusions and small groups remain visible.', safety: 'read', jsonShape: 'RestockPlan {schema:fleet.restock-plan.v1,jobs,excluded,held,invalid}' },
  { usage: 'phm fleet drive [--once] [--root <directory>] [--json]', description: 'Refresh the local Masbot relay status from driver snapshots and the fleet digest. No model calls or message delivery. Exit 1 if inputs cannot be read.', safety: 'append', jsonShape: 'DriveReport plus fleet digest; schemaVersion 1' },
  { usage: 'phm fleet drive jobs --bin <absolute-phm-path> [--root <absolute-directory>]', description: 'Print restockable Mac launchd job definitions. Does not install or activate them.', safety: 'read', jsonShape: '[{label,plist}]' },
  { usage: 'phm route explain [--json]', description: 'Read persisted dispatcher pools and accepted route moves in the trailing hour.', safety: 'read', jsonShape: '{available, route-moves-per-hour: number|null, lines}' },
  { usage: 'phm route failover --input <file|-> --failed-lane <lane> --failure <quota|5xx|timeout|near_reset> [--attempted a,b] [--root <directory>] [--record] --json', description: 'Plan an inert fallback chain; optionally append a failover receipt. No dispatch or model calls. Exit 2 on refusal.', safety: 'append', jsonShape: '{lane,entry?,reason_code?,reason_codes?,plan:route.fallback.v1}' },
  { usage: 'phm admission explain [--json]', description: 'Explain the adaptive launch interval from existing admission inputs. Read-only advisory; does not launch jobs.', safety: 'read', jsonShape: 'phantom.admission-explain.v1' },
  { usage: 'phm route decide --input <file|-> [--root <directory>] --json', description: 'Advisory typed route from local snapshots; optional mode selects capability class with reset-first spend order. Fusion pairs lead/sidekick. No launch changes.', safety: 'read', jsonShape: 'RouteReport {schema:route.decision.v1,advisory:true,lane,model,mode_tier,requested_mode,capacity,effort,speed_tier,reason_codes,path,duration_ms,attempts,candidate_count} | route.pairing.v1 {mode_tier:fusion,lead,sidekick,reason_codes}' },
  { usage: 'phm pools [--text]', description: 'Zero-waste view of the resource ledger: one row per resource, most at risk of unused quota first. Stale or missing readings are unknown with a reason, never zero. Read-only.', safety: 'read', jsonShape: 'PoolsViewV1 {schema:pools.v1,generatedAt,staleAfterMinutes,pools:[{id,kind,usedPct,state(measured|refilled|unknown),resetAt,hoursLeft,elapsedPct,burnPctPerHour,burnBasis,burn:{samples,window_h,method},projectedUnusedPct,projectedEmptyAt,verdict,wasteRisk,asOf,reason,summary}],gaps}' },
  { usage: 'phm pools waste [--json]', description: 'Which pool is about to waste included usage and the one fix in plain words ("sign in to Gemini once: run gemini in a terminal", "queue more work for Claude", "lane held: <reason>"). Flags a pool resetting within 12 hours with waste risk high or at least 25% projected unused; unknown usage is listed as unknown, never flagged. A fix that needs you is also put on the phone Asks card. Text by default.', safety: 'append', jsonShape: 'pools.waste.v1 {schema,generated_at,window_hours,unused_pct_threshold,alerts:[{pool,label,fix_kind,fix,needs_mason,used_pct,projected_unused_pct,hours_to_reset,reset_at,waste_risk,summary}],top,unknown:[{pool,label,reason}],ok,gaps}' },
  { usage: 'phm sessions [--lane <lane>] [--repo <repo>] [--json] [--live]', description: 'Every agent session as one tree: leader, then workers, then their subagents. Each row has model, repo, state, when it last spoke (quiet after 10 minutes without output), its last message, PR link and computer. Finished sessions stay for an hour; --live shows only running ones. Unknown fields read "unknown" with a reason. Exit 0 read, 2 usage.', safety: 'read', jsonShape: 'LiveSessionsV1 {schema:fleet.live-sessions.v1,generatedAt,quietAfterMinutes,filter:{lane,repo},counts:{sessions,quiet,lanes,otherComputers},sessions:[{job,lane,model,repo,tier,status,startedAt,ageSeconds,lastOutputAt,lastOutputAgeSeconds,quiet,prUrl,computer,thisComputer,unknown}],gaps,live,tree:{schema:fleet.session-tree.v1,version,generatedAt,line,counts,roots:[{id,parentId,agent,lane,model,repo,jobId,state,startedAt,lastMessageAt,lastMessage,kind,lastMessageAgeSeconds,counts:{below,running,failed},children}]}}' },
  { usage: 'phm map [--json] [--lane <lane>] [--repo <repo>] [--state <running|waiting|done|failed|unknown>]', description: 'The whole fleet as one graph, or only the agents matching --lane, --repo and --state ("unknown" finds unreported ones): leader, lanes, running jobs, computers and pool resources, with reports-to, runs-on, uses-resource and messaged-in-last-15-min edges. Stable ids and order; unknown facts are null or "unknown" and listed in gaps. Exit 0 read, 2 usage.', safety: 'read', jsonShape: 'FleetLiveMap {schema:fleet.live-map.v1,generatedAt,windowMinutes,pulseSeconds,nodes:[{id,kind,level,label,provider,status,detail,live,lane?,repo?,state?}],edges:[{id,kind,from,to,messages,lastMessageAt,pulse}],counts,sources,unmappedMessages,gaps,planners?:[{id,label,state,doing}],filter?:{lane,repo,state,matched,total},orgLayout:{schema:fleet.org-layout3d.v1,positions:[{id,role,label,parent,depth,x,y,z}],labels:[{id,label,running,unknown,hidden,text,depth,x,y,z}],hidden,radius,height}}' },
  { usage: 'phm messages [--since <15m|2h|1d|ISO>] [--agent <name|lane>] [--limit <n>] [--text]', description: 'Agent-to-agent messages on the local agent bus, newest first, with kind (ask, reply, handoff, status, blocker), a scrubbed one-line summary and the related job or PR. Damaged records are skipped and counted. Exit 0 read, 1 bus unreadable, 2 usage.', safety: 'read', jsonShape: 'AgentMessages {schema:agent-messages.v1,source,messages:[{id,ts,from:{name,lane},to:{name,lane},kind,summary,conversation,job,pr}],matched,skipped}' },
  { usage: 'phm inventory [--kind channel|connector|plugin|skill|tool] [--json]', description: 'Everything this install can use in one list: messaging channels, connectors, plugins, skills and tools. Each item has a state in plain words (ready, needs setup, off, error, unknown); an item that needs setup names one next step with a command to copy. Ends with lane parity: which tools and connectors each lane can use and lacks. A source that cannot be read is unknown, never guessed. Read-only; never prints a credential. Exit 2 on bad usage.', safety: 'read', jsonShape: 'Inventory {schema:phantom.inventory.v1,version:1,at,kind,counts:{ready,"needs setup",off,error,unknown},kinds:[{kind,label,total,counts}],items:[{kind,id,name,state,detail,lastChecked,usedByLanes,next:{text,command}|null}],parity:{compared,widestGap,lanes:[{lane,has,lacks,unknown,gap}]}}' },
  { usage: 'phm tools [--json] [--lane <lane>]', description: 'Which lane has which tool: MCP servers, CLIs, skills, plugins, GitHub, web search, browser and computer use, each yes/no/unknown with the source it was read from, a parity score per lane and the top 3 gaps with one fix each. Read-only; never installs or enables a tool. Exit 2 for an unknown lane.', safety: 'read', jsonShape: 'ToolMatrix {schema:tools.matrix.v1,parity,lanes,rows:[{need,kind,label,cells:{<lane>:{value,source}}}],scores:[{lane,score,yes,no,unknown}],topGaps:[{need,label,state,lanes,fix}],sources}' },
  { usage: 'phm tools parity [--json] [--lane <lane>]', description: 'One row per lane, one column per tool family (MCP servers, CLI on PATH, skills, plugins, web search, browser, computer use, gh). Each cell is present, missing or unknown with the source it was read from (router, connector profile, <runs>/queue/lane-tools.json); a missing cell names the one line to add. Unknown is never shown as missing. Read-only. Exit 2 for an unknown lane.', safety: 'read', jsonShape: 'LaneParityMatrix {schema:tools.parity.v2,version:2,parity:full|gaps|unknown,families:[{id,label}],lanes:[{lane,cells:{<family>:{state:present|missing|unknown,source,has?,lacks?,fix?}}}],counts:{present,missing,unknown},sources}' },
  { usage: 'phm tools requires --needs <need,...> [--text]', description: 'Lanes that can run a job with these needs. Exit 0 when some lane is not declared to lack a need, 1 when every lane is, 2 bad usage.', safety: 'read', jsonShape: 'ToolRequiresReport {schema:tools.requires.v1,needs,can,unproven:[{lane,unknown}],cannot:[{lane,lacks}]}' },
  { usage: 'phm route fit --input <file|-> [--worktree <directory>] --json', description: 'Check that a lane can do a job before launch: reads {job,lane,prompt,candidates?,gh_context?}, infers what the prompt needs (gh, network, browser, files outside the worktree) and refuses a lane declared to lack it. With gh_context and --worktree it writes the read-only gh context pack into the worktree. No launch changes.', safety: 'append', jsonShape: 'RouteFit {schema:route.fit.v1,job,lane,needs,decision:route|route_with_pack|route_skip,code,unknown,next_lane,pack_would_fix,line,pack}' },
  { usage: 'ashlr router rank --tier <local|mid|frontier> [--routes FILE] [--slots pool=count ...] [--json]', description: 'Rank eligible lanes by forecast exhaustion, then nearest reset; missing slots or budgets exclude a lane. No dispatch or state writes.', safety: 'read', jsonShape: '{ schema: fleet.lane-rank.v1, tier, lanes: RankedLane[] }' },
  { usage: 'phm router pick --model auto|<lane:model> [--task T] [--difficulty D] [--json]', description: 'Show which seats a routed call would try, in order, and why. Calls no model and writes no decision log. Exit 0 routable, 1 no route, 2 bad request.', safety: 'read', jsonShape: 'RouterPlan {schema:"router.plan.v1", ok, steps[], ruledOut[], decision, reason}' },
  { usage: 'phm run --model auto|<lane:model> "<prompt>" [--json]', description: 'One routed completion through the router gateway. Spends included usage of the chosen seat. Exit 0 answered, 1 no route or every seat failed, 2 bad request.', safety: 'append', jsonShape: 'RoutedCompletionResult {schema:"router.completion.v1", ok, text|reason, seatId, model, attempts[]}' },
  { usage: 'phm router catalog refresh [--json] [--apply] [--include-seats] [--out-dir DIR]', description: 'Discover models and write review-only report and patch; apply explicitly.', safety: 'append', jsonShape: '{schema:"router.catalog-refresh.v1", additions, unseen, unknown}' },
  { usage: 'phm router catalog schedule [--install] [--hour 0-23]', description: 'Print or install weekly review-only catalog refresh user units.', safety: 'append', jsonShape: 'Human-readable user service units; no JSON mode.' },
  { usage: 'phm router serve [--port N] [--json]', description: 'Start the loopback-only OpenAI-compatible endpoint (127.0.0.1; bearer token in ~/.ashlr/router/token). Runs until stopped.', safety: 'append', jsonShape: '{schema:"router.gateway.v1", url, port, config, tokenFile}' },
  { usage: 'phm router-calibration --jobs <jobs.jsonl> [--posthog <runs.json>] [--json]', description: 'Compare recorded router predictions with matched outcomes and usage offline.', safety: 'read', jsonShape: 'CalibrationReport (schemaVersion 1)' },
  { usage: 'phm router outcomes [--json] [--runs-dir <dir>] [--lane <lane>] [--limit <1..1000>]', description: 'Read-only per-job outcome records folded from the newest bounded tail of metrics/jobs.jsonl: merge state, CI first pass, review findings, cost, wall time, finish verdicts (empty, exit_code, failure_class) and the advisory pass^k join. Newest first; truncated=true when older rows were not read; unknown fields stay null. Exit 0 report (missing ledger included), 1 unreadable/non-file ledger, 2 usage.', safety: 'read', jsonShape: 'router.outcomes.v1 {schema,state,path,eval_state,total,returned,limit,malformed_rows,unattached_rows,ambiguous_urls,truncated,outcomes:RouterOutcome[]}' },
  {
    usage: 'phm context --for-agent <lane> --json',
    description: 'Compact under-4KB brief for one lane from the world model, roster claims, open pulls, bottlenecks, blind spots, and that lane pacing. Read-only. Exit 0 brief, 2 bad usage.',
    safety: 'read',
    jsonShape: 'ashlr.context-brief/v1',
  },
  {
    usage: 'phm context pack <goal-text|prompt-file> [--max-files 12] [--json]',
    description: 'Starting pack under 4 KB for one job: top repo files by keyword and path match with one-line reasons, related commands from the CLI reference, and recent merged job titles that overlap ("possibly already done"). Offline and read-only. Says unknown when nothing matches. Exit 0 pack, 2 bad usage.',
    safety: 'read',
    jsonShape: 'phantom.context-pack.v1 {schema,verdict:found|unknown,keywords,files:[{path,score,reason}],commands,possiblyDone}',
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
    usage: 'phm wb locus [--json]',
    description: 'Read Locus custody health through its credential-free fleet feed.',
    safety: 'read',
    jsonShape: '{v:1, state, reason, custody, sessionOk}',
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
    usage: 'phm job pause|resume|stop|move <id> [--lane <lane>] [--dry-run] [--json]',
    description: 'Steer one fleet job. Appends one idempotent request to queue/job-control.jsonl for the dispatcher; a live stop and a queued move apply at once. move refuses a held or full lane. Exit 0 requested or applied, 1 refused, unknown or unavailable, 2 usage.',
    safety: 'append',
    jsonShape: 'fleet.job.control.v1 { schema, action, job, lane, status: requested|applied|refused|unknown, reason, requestId, at, dryRun, duplicate }',
  },
  {
    usage: 'phm job say <id> "<text>" [--dry-run] [--json]',
    description: 'Send one note to a running job, e.g. "also update the docs". The note is timestamped and appended to the job\'s steering record (queue/job-notes.jsonl); a worker reads new notes between steps where its runner supports it, and every note shows as "Notes sent" in the job window. A finished job refuses the note. Up to 500 characters; the same note twice in a row is sent once. Exit 0 sent, 1 refused, unknown or unavailable, 2 usage.',
    safety: 'append',
    jsonShape: 'fleet.job.say.v1 { schema, job, status: sent|refused|unknown, reason, note: { id, at, text, by } | null, dryRun, duplicate }',
  },
  {
    usage: 'phm job notes <id> [--json]',
    description: 'List the notes sent to one job, oldest first (the newest 50). Exit 0 listed, 1 unreadable, 2 usage.',
    safety: 'read',
    jsonShape: 'fleet.job.notes.v1 { schema, job, count, notes: [{ id, at, text, by }] }',
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
  { usage: 'phm jobs retry-empty --dry-run|--apply [--file <router-queue.md>] [--json]', description: 'Preview or queue one scoped retry per eligible empty job.', safety: 'append', jsonShape: 'jobs.retry-empty.v1 {applied,lines}' },
  { usage: 'phm jobs gaps [--since 24h] [--propose] [--max N] [--json]', description: 'Turn the gaps that finished jobs list (no-change jobs: notes or final message; jobs that opened a PR: a Remaining gaps / Not done / Follow-ups list in the notes or the last 80 log lines) into new work: one candidate per gap (title, repo, source job, why), minus gaps already in an open idea, the queue or a recent merge. --propose queues the rest as drop jobs (the same queue as phm ideas queue); at most --max N per run, default 3 or ASHLR_GAPS_MAX; a gap naming a gh command goes to codex-personal for repos with a drop queue and lists the others as skipped with a reason. The fleet self-tick runs this once per tick. Unreadable sources are unknown.', safety: 'append', jsonShape: 'jobs.gaps.v1 {schema,sinceHours,known,unknownSources,jobsScanned,publishedScanned,bySource:{no-change,published},jobsWithoutGaps,candidates:[{title,repo,sourceJob,why,source}],dropped:[{title,repo,sourceJob,why,reason,matched}],proposed:[{title,repo,sourceJob,why,jobId,queued,skipped,path,refused}]|null} (path = written file or null; refused = plain-words contract reason or null)' },
  { usage: 'phm jobs stranded [--since 24h] [--runs-dir <dir>] [--json]', description: 'Finished jobs that pushed their branch but opened no PR because publishing aborted afterwards (e.g. ABORT default-fetch): one row per job with repo, branch, age, files changed (unknown when the log has none) and one next step; jobs whose PR was created later are listed as recovered. Reads the local publish logs only; never pushes, opens PRs or deletes. An unreadable log is unknown and exits 1.', safety: 'read', jsonShape: 'jobs.stranded.v1 {schema,sinceHours,readOnly,status,branches:[{job,branch,shape,reason,repo,ageHours,filesChanged,next,recover}],recovered:[{job,branch,pr}],unreadable:[job]}' },
  { usage: 'phm mobile check [--json]', description: 'Render every registered desktop view 390 px wide in the web UI test renderer and report, per view, content wider than the screen, tap targets under 44 px and text under 12 px, worst view first. Needs a source checkout. A size no stylesheet rule states is counted as unknown. Exit 1 on measured failures and 3 when a size is unknown or the views could not be rendered.', safety: 'read', jsonShape: 'mobile.check.v1 {schema,version,widthPx,minTapPx,minTextPx,state,note,totals:{views,failing,overflow,smallTaps,smallText,unknown}|null,views:[{id,title,rendered,overflow,smallTaps,smallText,unknown,findings:[{kind,element,detail}]}]}' },
  { usage: 'phm shipped --since 24h [--json]', description: 'Fleet-wide merged PRs, newest first, with job, lane, open-to-merge seconds, per-repo counts and totals. Reads GitHub and local job metrics; incomplete totals are null. Existing day-based product reports remain available.', safety: 'read', jsonShape: 'FleetShippedReport (fleet.shipped.v1)' },
  { usage: 'phm shipped [--since 7d] [--repo <name>] [--from <file>] [--json|--md|--site]', description: 'What shipped, in plain words: merged changes grouped by product area (desktop app, mobile, CLI, fleet, channels, plugins, docs) under one top line. Tests, chores, fixups and reverts count as maintenance; pull requests on the same feature fold into one line. Reads local git history, or with --from a JSON list of merged pull requests from several repositories. --md writes docs/SHIPPED.md; --site writes site/shipped.json and the website page site/shipped.html. An unreadable source prints as unknown and exits 1.', safety: 'append', jsonShape: 'shipped.v1 {schema,version,generatedAt,since,days,source,note,repo,headline,repos,biggest,total,maintenance,areas:[{id,label,count,lines:[{text,number,mergedAt,repo,prs}]}]}' },
  { usage: 'phm empties [--since 24h] [--text] [--metrics <file>] [--runs-dir <directory>] [--notes-dir <directory>]', description: 'Why jobs finished with no change, grouped by reason, with share of all finishes, tokens, and one next step each. Families rank by empty rate and wasted tokens; recommend suppression above 60% with at least five finishes. JSON by default; unmeasured values are null. Exit 1 when the metrics file is unreadable.', safety: 'read', jsonShape: 'empties.v1 {since_hours,metrics_path,metrics,finishes,empties,empty_share,tokens,tokens_unknown_jobs,malformed_lines,notes_missing,top_families:[{name,count}],reasons:[{reason,label,count,share_of_finishes,tokens,tokens_unknown_jobs,lanes,prefixes,examples,next_step}],families:[{name,finishes,empties,empty_rate,wasted_tokens,tokens_unknown_jobs,recommendation}]}' },
  { usage: 'phm home [--json] [--leader-seen <time>]', description: 'Is the fleet healthy and moving, in one glance: merged PRs, median time to merge, main per repo, running jobs per lane, the resource most at risk of going unused, the last 5 work-log items, unread Leader replies and what needs you with its one-word answers. The desktop and phone Home screens show exactly this. A missing source prints as unknown with the reason.', safety: 'read', jsonShape: 'home.v1 {health,headline,mergedLastHour,merged24h,medianMergeSeconds,main,running,atRisk,worklog,unreadLeaderReplies,needsYou:[{id,shortId,kind,request,ageSeconds,answers}]}' },
  { usage: 'phm subagent spawn --parent <id> --tier fast|mid|work|frontier --task <text> [--tools a,b] [--write-scope p1,p2] [--max-tokens N] [--max-cost-class local|included|metered] [--task-class <class>] [--repo <repo>] [--dry-run|--apply] [--json] | phm subagent list --parent <id> [--json] | phm subagent result <id> [--json]', description: 'Plan bounded cross-provider children through deterministic routing. Dry-run writes nothing; apply stores a held record only, never dispatches or enqueues.', safety: 'append', jsonShape: 'subagent.spawn.v1 {ok,dry_run,applied:false,record,parent,routing,reason_codes,next_step} | subagent.list.v1 | subagent.result.v1' },
  { usage: 'phm needs-you [--json] | phm needs-you resolve --auto [--dry-run] [--json] | phm needs-you batch [--json] | phm needs-you log [--json]', description: 'What truly waits on Mason: secrets, money, a send outside the team, deleting data, or a password/2FA/device approval (hard_limit). Everything else is auto; resolve --auto takes each auto item\'s forward action and writes an audit record {item, action, at, reason}; --dry-run changes nothing; batch is one message listing every hard_limit item with a one-word reply each. Same JSON as GET /api/needs-you.', safety: 'append', jsonShape: 'phantom.needs-you.v1 {ledger,counts:{hardLimit,auto},hardLimit:[{id,ref,title,class,limit,reason,answers,forward,answer}],auto:[...]}; batch: phantom.needs-you.batch.v1 {ledger,count,message,items:[{n,id,ref,title,reason,answers}]}; resolve: phantom.needs-you.resolve.v1 {dryRun,ledger,resolved:[{item,action,at,reason}],failed,hardLimit}' },
  { usage: 'phm asks [--json] | phm asks answer <id> <reply> [--json] | phm asks add password|2fa|device|payment|outreach|usage|approval <request> [--subject <name>] [--unblocks <text>] [--expires <UTC time>] [--json] | phm asks usage [<pool>] [--json] | phm asks sync [--dry-run] [--json]', description: 'Things only Mason can do (password, 2FA, device approval, payment, a message to someone outside the team, his usage percent for a lane, a yes or no on spending a credit), each answered with one word or one number. Lists open asks soonest expiry first (unknown expiry last, expired ones hidden) with allowed replies and what each unblocks; answer records the reply once with source, channel and time in the answers ledger (a usage percent becomes a source=mason reading, an approval is a record only: nothing is spent); a reply the ask does not accept records nothing; any other kind is refused: the fleet decides this itself. sync raises one ask per pool that needs a one-time sign-in or has a credit ending unused (expiring at its reset), adds nothing on a re-run, closes the ask when the pool clears, and reports an unreadable ledger as unknown; it never signs in or spends.', safety: 'append', jsonShape: 'asks.v1 {asOf,ledger,count,asks:[{id,shortId,kind,request,replies,replyHint,unblocks,subject,created,ageSeconds,expires}],fleetDecides,expiredHidden}; answer: asks.answer.v1 {status,id,kind,answer,source,answeredAt,reason}; usage: asks.usage.v1 {pool,reading:{pctUsed,source,channel,fetchedAt,ageMs}|null}; sync: asks.sync.v1 {asOf,dryRun,status,reason,raised,kept,resolved:[{pool,kind,text,replies,expires,askId}],unknown:[{pool,reason}]}' },
  { usage: 'phm decisions [--json] | phm decisions answer <code> yes|no|later [--json]', description: 'What only Mason can do (password, 2FA, device approval, payment, a message to someone outside the team), one word each. Lists waiting decisions; answer records yes, no or later once from the local human only (y and n work too). Same ledger as phm approvals; nothing is paid or sent.', safety: 'append', jsonShape: 'decisions.v1 {schema,version,as_of,ledger,waiting,decisions:[{id,code,kind,question,asked_at,source,expires_at,state,answer,answered_by}],ignored:[{channel,sender_id,text,at,reason}],hint}; answer: approvals.answer.v1' },
  { usage: 'phm metrics [--hours N] [--json]', description: 'How well the self-improving loop is running, in one glance: PRs merged per hour (last 1, 6 and 24 hours), median publish-to-merge time, empty rate, per-lane jobs, merged, empty rate and merge rate, merge rate by tier and spend-down per pool. The desktop Metrics view shows exactly this. Missing or stale values are unknown (null), never zero. Exit 1 only when neither source gives a reading.', safety: 'read', jsonShape: 'metrics.glance.v1 {version,as_of,hours,sources:{jobs,status,status_as_of},headline,merged_per_hour:{last_1h,last_6h,last_24h,window},merged,median_publish_to_merge_s,empty_rate,pools_at_risk,lanes:[{name,jobs,merged,empty_rate,merge_rate,empty_high}],tiers,pools:[{pool,used_pct,hours_to_reset,projected_unused_pct,waste_risk,at_risk,reason}]}' },
  { usage: 'phm spend [--json]', description: 'Are we spending every pool before it resets or expires: one sentence naming the pool that will waste the most, then one line per pool (codex-personal, codex-cmp, claude, claude-api gift, devin, zai, local) with used percent, burn per hour, projected unused, time left and one status word: on-pace, behind, exhausted or unknown. Behind pools come first, largest projected waste on top. Unknown stays unknown, never zero. The desktop Resources Spend card shows the same snapshot. Also spelled phm usage spend and phm fleet spend.', safety: 'read', jsonShape: 'usage.spend.v1 {schema,v,asOf,headline,pools:[{pool,unit,status,verdict,reason,usedPercent,resetAt,hoursLeft,resetsIn,burnPerHour,projectedUnusedPercent,projectedUsedPercent,remainingUsd,projectedUnusedUsd,summary}]}' },
  { usage: 'phm merges latency [--since 24h] [--by lane|repo] [--json] [--metrics <file>] [--runs-dir <directory>]', description: 'How long PRs really take to merge: median and p90 for open to merge (the PR\'s own created and merged times, the true time) next to publish to observed (the old time, which includes the polling delay), each with the share of merged PRs it covers, and the same split by lane or repo. A PR whose own times were not recorded is unknown for the true time, never guessed. phm merges alone is the same. Plain words by default; exit 1 when the metrics file is unreadable.', safety: 'read', jsonShape: 'merges.latency.v1 {as_of,since,hours,by,metrics_path,metrics,malformed_lines,basis:{open_to_merge,publish_to_observed},merged,open_to_merge:{known,unknown,coverage_pct,p50_s,p90_s},publish_to_observed:{...},headline,groups:[{name,merged,open_to_merge,publish_to_observed}]}' },
  { usage: 'phm throughput [--hours 24] [--by lane|repo|tier] [--text] [--metrics <file>] [--runs-dir <directory>]', description: 'What the fleet produced hour by hour: jobs launched, PRs published, PRs merged, empty jobs and the median publish-to-merge time, with totals, a headline and whether main is green. JSON by default; unmeasured values are null. Exit 1 when the metrics file is unreadable.', safety: 'read', jsonShape: 'throughput.v1 {as_of,since,hours,by,metrics_path,metrics,malformed_lines,main,headline,totals,buckets:[{start,launched,published,merged,finished,empty,empty_rate,median_publish_to_merge_s,merge_time_unknown}],groups:[{name,totals,buckets}]}' },
  { usage: 'phm jobs yield [--since 24h] [--metrics <jobs.jsonl>] [--stop-list | --stop-file [--ttl-hours N] [--out PATH] [--dry-run]] [--json]', description: 'Which kinds of jobs are worth launching: per job kind (job id minus its trailing counter; one-test filler by repo) launches, empty, skipped before launch, merged and merged per launch, with a keep, watch or stop verdict and the five kinds to stop first. Run phm jobs yield --stop-list to print every kind to stop, one per line; no matches prints nothing. With --json, the full report is unchanged. Run phm jobs yield --stop-file to write those kinds to the job stop file the fleet reads before any model call (--out PATH, else ASHLR_JOBS_STOP_FILE; unset is unknown and writes nothing): one anchored pattern per kind, live for --ttl-hours (default 24, at most 72), hand-written rows kept, expired tool rows removed, --dry-run writes nothing, JSON jobs.stop-file.v1. A kind with a merge in its last 3 launches is never stop. The desktop Metrics view shows the same report and the stopped families. Unreadable metrics are unknown; --stop-list without --json reports the error on stderr and exits 1.', safety: 'append', jsonShape: 'jobs.yield.v1 {version,window_hours,known,launches,merged,empty,skipped,stop_slots,summary,families:[{family,launches,running,empty,skipped,prs,merged,merged_per_launch,verdict,reason}],stop_first:[{family,slots,merged,reason}]}' },
  { usage: 'phm self drift [--json] [--repo <phantom clone>]', description: 'Is the installed phm the fleet runs behind the latest release and master, and which merged fleet capabilities (recut-check, yield-stop-list, stop-file, pulse, decisions, leader-replies, model-check) are not live in it yet. A capability is live when the installed phm answers its --help with exit 0 within 5 s and shows the proving flag or verb. Home shows the same line as Running build. Unreadable facts print as unknown. Exit 0 report, 2 usage.', safety: 'read', jsonShape: 'phantom.self-drift.v1 {schema,version,checkedAt,installed:{version,revision},latestRelease:{tag,at},master:{revision,at},behindReleases,behindCommits,oldestUnshippedMergeAt,liveFeatures,missingFeatures,unknownFeatures,features:[{name,command,state}],line}' },
  { usage: 'phm recut check [--json] [--ref <branch>] [--base master] [--metrics <jobs.jsonl>] <area-or-job-id>', description: 'Should the next recut or red-fix job launch? Give an area (core, webui) or a job id. Skips when its job kind is on the phm jobs yield --stop-list list, when a live row in the job stop file matches it, when its last 3 jobs ended empty and master has no new commits in that area since, or when --ref is already on master. Unreadable yield data launches with reason yield unknown. fleet recut-sweep runs the same check before it writes a job. Exit 0 launch, 1 skip, 2 usage.', safety: 'read', jsonShape: 'recut.check.v1 {schema,version,target,family,area,emit,code,reason,facts:{yield,on_stop_list,last_jobs:[{job,empty,ended_at}],since,area_paths,master_touched,base,ref,diff_contained,stop_file_row}}' },
  { usage: 'phm jobs producers [--since 6h] [--metrics <jobs.jsonl>] [--queue <router-queue.md>] [--json]', description: 'Who queued the jobs that started: launches per producer (the src= tag on the job queue line; no tag is unknown) and per hour over the last 6 hours. Unreadable queue leaves producers unknown; unreadable metrics exit 1.', safety: 'read', jsonShape: 'jobs.producers.v1 {version,window_hours,known,queue_known,starts,hourly:[n],producers:[{producer,starts,jobs,hourly:[n]}],summary}' },
  { usage: 'phm jobs cost [--since 24h] [--by lane|model] [--metrics <jobs.jsonl>] [--json]', description: 'What finished jobs cost: jobs, merged PRs, tokens per merged PR and measured coverage, by lane or model. Reads finish-row tokens_total, else the usage Claude Code (result block) or Codex (tokens used line) printed at the end of the job log. A job with no usage is unknown, never zero; unreadable metrics exit 1.', safety: 'read', jsonShape: 'jobs.cost.v1 {schema,version,window_hours,by,known,total,rows:[{key,jobs,measured,coverage,merged,merged_measured,tokens_total,input_tokens,output_tokens,cache_tokens,cost_usd,tokens_per_merged_pr}]}' },
  { usage: 'phm jobs tokens (--lane <lane> | --coverage) [--since 24h] [--metrics <jobs.jsonl>] [--json]', description: 'Token use of finished jobs in one lane, and how many were measured. Reads finish-row tokens_total, else the Claude Code result object (json or stream-json) at the end of the job log. A job with no usage is unmeasured, never zero; unreadable metrics exit 1.', safety: 'read', jsonShape: 'jobs.tokens.v1 (--coverage: jobs.coverage.v1 {schema,version,window_hours,known,total,lanes:[{lane,jobs,measured,unknown,coverage,merged,merged_measured}]}) {schema,version,lane,window_hours,known,jobs,measured,coverage,tokens_total,cost_usd,merged,merged_measured,tokens_per_merged_pr}' },
  { usage: 'phm jobs empty-why [--since 24h] [--metrics <jobs.jsonl>] [--json]', description: 'Explain EMPTY finishes and rank job families by recorded wasted tokens. The yield view shows the same report. Unknown tokens stay null; unreadable metrics exit 1.', safety: 'read', jsonShape: 'jobs.empty-why.v1 {version,window_hours,known,total,jobs,families:[{family,empty,wasted_tokens,tokens_unknown_jobs,reasons}]}' },
  { usage: 'phm recut plan [--json] [--prs <dirty-landed.json>] [--base master] [--metrics <jobs.jsonl>] [<area>...]', description: 'Which recut areas should get a job this cycle? Per area (default all 13): emit or skip with one plain reason. Skips what phm recut check skips (stop list, a live stop-file row, an empty streak) and any area no eligible PR touches, counted from phm fleet dirty-landed (or --prs, a saved --json report) the way fleet recut-sweep filters. An unreadable PR list is unknown and never skips. Writes nothing. Exit 0, 2 usage.', safety: 'read', jsonShape: 'recut.plan.v1 {schema,version,generated_at,emit,skip,prs:{source,known,complete},stop_file,areas:[{area,family,emit,code,reason,eligible,prs}]}' },
  { usage: 'phm recut prompt <job-id> --lane <lane> --tier <tier> [--repo phantom] [--task <text>]', description: 'Read a recut prompt on stdin and print it with the standard task line first: <job-id> (P1, pool=<lane>, tier=<tier>, repo=<repo>): <task>. The launch precheck and stop list only see a job through that line. The task is --task, else the prompt first line without # or Goal:. The rest is unchanged. Exit 0, 2 usage.', safety: 'read', jsonShape: 'none: prints the prompt text' },
  { usage: 'phm jobs empty [--since 24h] [--family F] [--by-family [--apply [--dry-run] [--ttl-hours N] | --undo <family>]] [--json]', description: 'Explain empty jobs from log tails and publish records. --by-family gives one row per job family and lane with an action: stop, recut, reroute or keep. --apply writes the still-READY exact ids of each stop family to the fleet retired-ids file and a lane-avoid hint for each reroute family, for 48 hours by default; --dry-run only shows them; --undo <family> removes them. FIXUP- and RELEASE families are never stopped. Self-tick applies hourly unless fleet config empty_stop.off is 1.', safety: 'append', jsonShape: 'jobs.empty.v1 {hours,total,counts,jobs,diagnosis:{jobs,families,lanes}}; --by-family: jobs.empty.by-family.v1 {hours,total_empty,families:[{family,lane,launches,empty,empty_rate,top_reasons:[{reason,count}],action}]}; --apply: jobs.empty.apply.v1 {version,dry_run,written,known,error,ttl_hours,retired_file,avoid_file,rows:[{family,lane,action,ids,until,reason}],expired_removed}; --undo: jobs.empty.undo.v1 {family,known,error,removed_ids,removed_hints}' },
  {
    usage: 'phm metrics ingest --jobs <jobs.jsonl> --status <status.json> [--json]',
    description: 'Read local job snapshots into deterministic lane and tier metrics and advisory priors. No network, writes or operational steering.',
    safety: 'read',
    jsonShape: 'MetricsFeed (schemaVersion 1); unknown measurements are null; refused input exits 2',
  },
  {
    usage: 'phm nodes [--json] [--can-take <lane>]',
    description: 'One row per known computer: reachable or not, whether Phantom is running there, free memory, load, heartbeat age, CPU headroom, lanes, free slots, running jobs and a plain-words state; a computer silent for over 5 minutes is offline. Prints "Only this Mac." when no other computer is known. --can-take lists ready computers and recommends a remote computer, falling back to this computer when ready. Unknown facts stay unknown with a reason. Exit 0, 2 bad usage.',
    safety: 'read',
    jsonShape: '{schema:"phantom.nodes-view.v1", schemaVersion:1, asOf, self, registry, nodes:[{name,isSelf,reachable,lastSeen,heartbeatAgeSeconds,phantom,freeMemoryBytes,freeMemoryPercent,load,cpuHeadroomPercent,lanes,jobsRunning,freeSlots,stateCode,state}], reasons, canTake?, placement?:{lane,node,target,reason,explanation}}',
  },
  {
    usage: 'phm nodes pool [--json]',
    description: 'Your Macs as one pool, this Mac first: online, offline or unknown, free slots, running jobs, load, free memory and disk, whether offload is on, when it was last seen, and a total line such as "2 Macs, 11 free slots". Offload is known only for this Mac. The desktop and phone Home show the same as a Machines card. Unknown facts say unknown and stay out of the total. Read only. Exit 0, 2 bad usage.',
    safety: 'read',
    jsonShape: '{schema:"phantom.nodes-pool.v1", schemaVersion:1, asOf, nodes:[{name,isSelf,status:online|offline|unknown,freeSlots,jobsRunning,load,freeMemoryBytes,freeMemoryPercent,freeDiskGb,offload:on|off|unknown,lastSeen,state}], total:{macs,online,freeSlots,slotsUnknown,jobsRunning,line}, reasons}',
  },
  {
    usage: 'phm nodes plan [--json]',
    description: 'A plan for spreading queued jobs over your computers: for each one, online or not, free memory, load, lanes and how many more jobs it could take now (0 when offline or held, "unknown" when not measured), plus which queued job fits which computer. Says "Tailscale is not installed here." when the Tailscale CLI is missing. It only plans: it launches, moves and stops nothing. Exit 0, 2 bad usage.',
    safety: 'read',
    jsonShape: '{schema:"phantom.nodes-plan.v1", as_of, nodes:[{name,online,free_mem_pct,load,lanes,suggested_slots,why}], assignable:[{job,node,why}], unassigned, reasons}',
  },
  {
    usage: 'phm nodes offload [--dry-run] [--json]',
    description: 'Opt-in, off by default. When this computer would hold a launch (over load, or the memory gate holds) and another computer passes `phm nodes doctor` with a free slot for the lane, a ready job is chosen for that computer and one event records why. Running jobs never move, a computer never gets more jobs than its free slots, and with no ready computer the job keeps waiting here. --dry-run only shows what would move. `phm nodes offload on|off` flips the setting.',
    safety: 'append',
    jsonShape: '{schema:"phantom.nodes-offload.v1", schemaVersion:1, asOf, enabled, mode:dry-run|live, host:{state:busy|fine|unknown,reasons:[load|memory],why}, moves:[{job,lane,node,reasons,why}], stays:[{job,lane,why}], recorded, summary, reasons}; event: phantom.nodes-offload-event.v1 {at,job,lane,from,to,reasons,why}',
  },
  {
    usage: 'phm node bootstrap --dry-run [--json]',
    description: 'Print persistent Linux node setup and future registry lease steps; no provisioning or registry calls. Exit 0 plan, 2 bad usage.',
    safety: 'read',
    jsonShape: 'schemaVersion 1; dryRun=true, executable=false, registry.status=stub, steps',
  },
  {
    usage: 'phm node join|beat|enqueue|plan|pull|renew|complete|list|status|leave|pool|watch|worker|rpc|light [flags] [--json]',
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
    usage: 'phm graph status --fleet <fleet.json> [--seats <seats.json>] [--json] | phm graph status --seats <seats.json> [--json]',
    description: 'Read declared fleet relationships and passive seat catalogs. No provider probes or execution authority. Exit 0 complete projection, 1 incomplete, 2 bad usage.',
    safety: 'read',
    jsonShape: 'RegistryGraph (schema graph.v1): sources, nodes, edges, issues, complete',
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
    usage: 'phm verify done --worktree <path> [--contract <path>] [--plan]',
    description: 'Evaluate a worktree\'s done-contract.v1 (DONE_CONTRACT.json or a BRIDGE_NOTES.md embed): floor checks, verify commands and attested acceptance items. No contract falls back to the notes-file expectation. JSON verdict on stdout, handoff on stderr; child output withheld. Exit 0 pass, 1 failed, 2 usage.',
    safety: 'append',
    jsonShape: '{pass,mode,job,source,notes_file,notes_present,checks:[{id,source,required,ok,secs,first_error}],acceptance:[{id,text,status,detail}],error}',
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
    jsonShape: '{dryRun, channels:[{id, adapterRegistered, healthy:true|false|"unknown"}]} | {id, dryRun, status, reason}',
  },
  {
    usage: 'ashlr agents bus contract [--json]',
    description: 'Print the Agent Bus v2 contract version, providers, body kinds, work statuses and claim key forms. Read-only; claims coordinate and grant no execution authority.',
    safety: 'read',
    jsonShape: '{schemaVersion, providers[], wakeKinds[], bodyKinds[], workStatuses[], claimKeyForms[], claimLeaseMs:{min,max}, claimsGrantExecutionAuthority:false}',
  },
  {
    usage: 'ashlr agents bus id register|list [<handle>] [--cli <cli>] [--model <m>] [--alias <label>] [--root <abs>] [--json]',
    description: 'Stable agent identity registry beside the local bus store: one agt_ id per handle across providers and models. Identities are routing names, never authentication.',
    safety: 'append',
    jsonShape: '{status:created|updated|unchanged, identity:{id, handle, aliases[], runtimes[]}} | {status:ok, identities[], channels[]}',
  },
  {
    usage: 'ashlr agents bus dm|handoff|channel <create|join|leave|post> ... [--priority P0..P3] [--wake|--no-wake] [--root <abs>] [--json]',
    description: 'Unified agent bus sends: DMs to agent:<handle>, member-only channel posts, worker handoffs. One append to the local bus store; P0 always wakes. No network, no engine runs.',
    safety: 'append',
    jsonShape: '{status:posted|duplicate, id, cursor, to, wake} | {status, reason}',
  },
  {
    usage: 'ashlr agents bus inbox|wakes|show|adapters [<agent|id>] [--after <n>] [--limit <n>] [--frame <cli>] [--since <ms>] [--root <abs>] [--json]',
    description: 'Read one identity inbox (DMs, handoffs, channels, legacy aliases; highest priority first), its wake hints, one retained envelope by wire id, or the claude/codex/devin/cursor/grok session adapters. Read-only.',
    safety: 'read',
    jsonShape: '{status:ok, agent, messages[], nextCursor} | {status:ok, agent, wakes[]} | {status:ok, id, message} | {status:not-found, id} | {adapters[]}',
  },
  {
    usage: 'ashlr agents messages [--since 1h] [--limit N] [--json]',
    description: 'Recent agent-to-agent messages from the agent bus with sender and recipient as map node ids (unknown when the map does not draw them), a 160-character summary, the thread when named, and per-line message counts with the last 5 summaries. Read only.',
    safety: 'read',
    jsonShape: 'agents.messages.v1 {schema, version, generatedAt, since, source, messages[{at, from, to, kind, summary, threadId?, fromName, toName}], pairs[{from, to, count, lastAt, recent[]}], matched, skipped}',
  },
  {
    usage: 'ashlr agents conversations [--agent <name>] [--waiting] [--json]',
    description: 'Agent-to-agent messages grouped into threads by reply chain: participants, latest subject, message count, last activity and one state (waiting for reply, answered, blocked or done). Longest-waiting first. An agent no label proves reads "unknown agent". Read only.',
    safety: 'read',
    jsonShape: 'agents.conversations.v1 {schema, version, generatedAt, source, conversations[{id, participants[], subject, messageCount, lastAt, state, stateText, waiting, links[], messages[]}], waiting, skipped}',
  },
  {
    usage: 'ashlr agents roster [--json]',
    description: 'Unified live session roster across Phantom jobs, Devin cloud, Devin Desktop, Codex, Claude, Cursor, Grok, Ollama and oMLX. Each probe times out in about 5s and degrades to unknown. Read-only; no secrets.',
    safety: 'read',
    jsonShape: 'agent-roster.v1 {schema, observedAt, latencyMs, sources[{source, ok, availability, sessions, error, observedAt, truncated}], sessions[], claims}',
  },
  {
    usage: 'ashlr agents mesh status [--root <absolute>] [--json]',
    description: 'Read the flat fleet mesh: every known identity, direct address, lane, last-seen and current task. No probes or writes.',
    safety: 'read',
    jsonShape: 'agent-mesh.v1 {status, asOf, agents[{agent, address, lane, lastSeen, currentTask, status, source}]}',
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
    usage: 'phm channels [--json]',
    description: 'One row per messaging channel (email, telegram, imessage, mobile, desktop, page, cli, slack): connected, not set up, failing or unknown: <reason>; last inbound/outbound, messages in 24 h, verified senders, masked address and the one next step. Failing first. Same JSON as GET /api/channels and the desktop Channels pane. Exit 0 success/help, 2 bad usage.',
    safety: 'read',
    jsonShape: 'ChannelsOverview {schema:"phantom.channels.v1", version:1, at, counts, channels[]}',
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
  { usage: 'phm agentnet peers read [--after <cursor>] [--json]', description: 'Read the authenticated session inbox; ignores raw bus envelopes without private admission evidence.', safety: 'read', jsonShape: '{status, messages, nextCursor}' },
  { usage: 'phm agentnet peers list [--json]', description: 'List host-enrolled callsigns and Slack identities; never prints session credentials.', safety: 'read', jsonShape: '{peers:[]}' },
  { usage: 'phm agentnet peers send <to|#channel-id> <kind> <text> [--reply-to <id>] [--thread <id>] [--json]', description: 'Authenticated team peer message; bounded hops and pair rate, approval-gated Slack broker. Exit 1 refused, 2 usage.', safety: 'append', jsonShape: 'PeerResult {status, reason?, id?, origin?, hopCount?, slack?}' },
  { usage: 'phm agentnet channels propose <name> [--apply] [--json]', description: 'Preview a private collaboration channel draft; --apply records it locally. Never creates a Slack channel.', safety: 'proposal', jsonShape: '{status, action, name, dryRun}' },
  { usage: 'phm agentnet identity register <callsign> [--json]', description: 'Record a stable callsign profile draft; never provisions credentials or grants a session binding.', safety: 'proposal', jsonShape: '{status, action, name, dryRun}' },
  {
    usage: 'phm mason thread [--since <dur>] [--json]',
    description: 'One thread with Mason across iMessage, Slack, Telegram, email and desktop: his messages and the leader\'s replies in time order, the same request on two channels shown once, each of his messages tagged Received, Assigned, Running, Blocked or Verified with its linked jobs. Default window 1d (15m, 2h, 1d, epoch ms or ISO). A source that cannot be read is named in gaps and a state that cannot be known is UNKNOWN. Read-only: sends nothing. Prints "Nothing yet." when empty. Exit 0 read, 2 usage.',
    safety: 'read',
    jsonShape: 'MasonThread {schema:"phantom.mason.thread.v1", as_of, since, items:[{at, dir:"in"|"out", channel, text, state:"RECEIVED"|"ASSIGNED"|"RUNNING"|"BLOCKED"|"VERIFIED"|"UNKNOWN"|null, job_ids, also_on}], gaps}',
  },
  {
    usage: 'phm channels reply-state <request-id> [--json]',
    description: 'The one state read before any fleet reply about a work item: RECEIVED, ASSIGNED, RUNNING, BLOCKED or VERIFIED with its as-of time and source, computed from the bus inbox and claim records. No record means RECEIVED, no owner yet. A repeat request in the same thread resolves to the first request id. Read-only. Exit 0 report, 2 bad usage.',
    safety: 'read',
    jsonShape: 'ReplyState {schema:"phantom.channels.reply-state.v1", requestId, id, duplicateOf, state, owner, claim, evidence, missing, asOf, source, records, text}',
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
    usage: 'ashlr skills list --all [--json]',
    description: 'Every skill fleet agents have (Claude Code, Codex, learned); unreadable sources say "unknown".',
    safety: 'read',
    jsonShape: 'InstalledPanel',
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
    usage: 'phm pulse merge-latency [--jobs <jobs.jsonl>] [--json]',
    description: 'Observed time waiting for checks, running checks and waiting to merge. Read-only; missing, reversed or ambiguous boundaries stay unknown.',
    safety: 'read',
    jsonShape: 'pulse.merge-latency.v1 {known,jobs,ignored_events,phases,top_wastes}; durations are total_seconds, unknown is null',
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
    'Job runners: run `phm bets check --from-prompt <prompt-file> --gate --json` first; exit 3 exists (stop), 2 partial (build only the suggested delta), 0 new (go), 1 error.',
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
  lines.push('phm_team_view, phm_team_claim, phm_team_handoff, phm_team_access_request,');
  lines.push('phm_team_context_add and phm_team_context_get. Claims are leases; consequential handoffs and access requests wait for human approval.');
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
  lines.push('phantom_fleet_needs_resolve, phantom_fleet_needs_wait, phantom_fleet_orders,');
  lines.push('phantom_fleet_graph,');
  lines.push('phantom_fleet_session, phantom_fleet_doctor, phantom_fleet_verbs.');
  lines.push('Tool discovery is not authorization. phantom_fleet_doctor only reads fleet health;');
  lines.push('phantom_fleet_verbs lists fleet verbs and never runs one.');
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
  lines.push('Intent evidence tools (local owner-directive ledger; tracking does not authorize action):');
  lines.push('intent_list and intent_get read. intent_stale is classified append: it previews stale directives by default, and');
  lines.push('apply=true refreshes local tracking only. intent_add, intent_update, intent_import, intent_link and intent_ship append local records;');
  lines.push('intent_link and intent_ship record caller-supplied merge or release evidence and never verify it.');
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
  console.log(`    ${c.cyan('phm docs cli [--check] [--json]')} ${c.dim('regenerate or check the CLI reference from the command registry')}`);
  console.log(`    ${c.cyan('ashlr docs --agent')}          ${c.dim('agent cheat sheet (llms.txt-style, plain text)')}`);
  console.log(`    ${c.cyan('ashlr docs --agent --json')}   ${c.dim('the same registry as JSON')}`);
  console.log(`    ${c.cyan('ashlr wire --claude-md')}      ${c.dim('CLAUDE.md snippet for agent configs')}`);
  console.log('');
}

export async function cmdDocs(args: string[]): Promise<number> {
  if (args[0] === 'cli') {
    const { cmdDocsCli, cliReferenceRows } = await import('./docs-cli.js');
    return cmdDocsCli(args.slice(1), cliReferenceRows(HELP_ENTRIES));
  }
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
        error: 'phm docs needs a surface; pass cli or --agent --json',
        surfaces: [
          { command: 'phm docs cli [--check] [--json]', description: 'generate or check the CLI reference from the command registry' },
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
  { cmd: 'bots list|show|create --dry-run|explain|seats|handoffs|handoff --seat <id> [--apply] [--json]', desc: 'Provider-neutral bot metadata, seat quota and draining handoffs. handoffs plans every seat; handoff --seat is dry-run unless --apply.', topic: 'autonomy' },
  { cmd: 'app restart --json', desc: 'Report a held restart while the native UI owns live runtime state; does not quit or update the app.', topic: 'core' },
  { cmd: 'caps list|validate|generate [--registry <path>] [--out <dir>] [--pin-stage] [--check] [--json]', desc: 'Capability registry: surfaces, models, hosting edges, account references and capabilities; validate it and generate pinned per-agent adapters to staging (never into live agent config dirs). See docs/CAPABILITY-REGISTRY.md.', topic: 'core' },
  { cmd: 'constitution check [--root <repo>] [--json] [paths...]', desc: 'Check constitution rule definitions and references in prompts and templates (read-only).', topic: 'core' },
  { cmd: 'tune <prepare|evaluate>', desc: 'Prepare scrub-gated local model datasets or evaluate paired evidence.', topic: 'core' },
  { cmd: 'mobile check [--json]', desc: 'Check every desktop view at 390 px: content wider than the screen, tap targets under 44 px, text under 12 px.', topic: 'observability' },
  { cmd: 'shipped [--since 7d] [--repo <name>] [--from <file>] [--json|--md|--site]', desc: 'What shipped, in plain words: one top line, then merged changes by product area. --md writes docs/SHIPPED.md; --site writes the website page.', topic: 'observability' },
  { cmd: 'empties [--since 24h] [--text]', desc: 'Why jobs finished with no change: reasons, share of finishes, tokens and one next step each. JSON by default.', topic: 'observability' },
  { cmd: 'home [--json]', desc: 'Is the fleet healthy and moving: merges, main, running jobs, the resource at risk, the work log and unread Leader replies in one summary.', topic: 'observability' },
  { cmd: 'subagent spawn|list|result [opts]', desc: 'Plan bounded cross-provider children; apply stores held records only, never dispatches.', topic: 'autonomy' },
  { cmd: 'needs-you [--json] | needs-you resolve --auto [--dry-run] | needs-you batch', desc: 'Only what truly needs Mason (secrets, money, outside sends, deleting data, sign-in approvals); the fleet resolves the rest with an audit record.', topic: 'observability' },
  { cmd: 'asks [--json] | asks answer <id> <reply> | asks sync [--dry-run]', desc: 'What only Mason can do (password, 2FA, device, payment, outreach, a usage percent, a credit approval) and a one-word or one-number answer for each.', topic: 'observability' },
  { cmd: 'decisions [--json] | decisions answer <code> yes|no|later', desc: 'What only Mason can do (password, 2FA, device, payment, outreach), answered with one word.', topic: 'observability' },
  { cmd: 'spend [--json]', desc: 'Is every pool spent before it resets or expires: used, burn, projected unused and one status word per pool, worst waste first.', topic: 'observability' },
  { cmd: 'merges latency [--since 24h] [--by lane|repo] [--json]', desc: 'Real open-to-merge median and p90 next to publish-to-observed, with coverage. Plain words by default.', topic: 'observability' },
  { cmd: 'throughput [--hours 24] [--by lane|repo|tier] [--text]', desc: 'Jobs launched, PRs published and merged, empty jobs and median publish-to-merge time per hour. JSON by default.', topic: 'observability' },
  { cmd: 'jobs yield [--since 24h] [--stop-list | --stop-file [--ttl-hours N] [--out PATH] [--dry-run]] [--json]', desc: 'Which kinds of jobs are worth launching: keep, watch or stop. Use --stop-list for only the kinds to stop, one per line, or --stop-file to write them to the job stop file; --json keeps the full report.', topic: 'observability' },
  { cmd: 'self drift [--json] [--repo <phantom clone>]', desc: 'Is the installed phm behind the latest release and master, and which merged fleet features are not live in it yet. Unreadable facts print as unknown.', topic: 'observability' },
  { cmd: 'publish resume --branch <codex-bridge/job|job> [--repo <name>] [--json]', desc: 'Finish a half-done publish: open the PR for a pushed fork branch and turn on auto-merge through the merge queue.', topic: 'observability' },
  { cmd: 'publish orphans [--repo <name>] [--json]', desc: 'List your fork codex-bridge/ branches from the last 48 hours that have no PR.', topic: 'observability' },
  { cmd: 'recut check [--json] [--ref <branch>] <area-or-job-id>', desc: 'Should the next recut or red-fix job launch? Exit 0 launch, 1 skip; the reason is one plain line.', topic: 'observability' },
  { cmd: 'recut plan [--json] [--prs <dirty-landed.json>] [<area>...]', desc: 'Per recut area, emit or skip this cycle with one plain reason. Writes nothing.', topic: 'observability' },
  { cmd: 'recut prompt <job-id> --lane <lane> --tier <tier>', desc: 'Print a recut prompt from stdin with the standard task line first.', topic: 'observability' },
  { cmd: 'jobs state <id> [--json]', desc: 'Show whether a job is running or done, with the evidence.', topic: 'observability' },
  { cmd: 'jobs empty [--since 24h] [--family F] [--lane L] [--by lane|reason] [--record] [--by-family [--apply | --undo <family>]] [--json]', desc: 'Why jobs ended empty, tagged already_done, pool_cap, blocked, no_change_needed or unknown. --by groups by lane or reason; --record stores each tag; --json has schema jobs.empty-tags.v1 under tags. --by-family: one action per job family; --apply retires stop families (dry run with --dry-run).', topic: 'observability' },
  { cmd: 'jobs producers [--since 6h] [--metrics <jobs.jsonl>] [--queue <router-queue.md>] [--json]', desc: 'Who queued the jobs that started, per hour over the last 6 hours.', topic: 'observability' },
  { cmd: 'jobs cost [--since 24h] [--by lane|model] [--json]', desc: 'Tokens per merged PR and measured coverage by lane or model; unknown where no usage was printed.', topic: 'observability' },
  { cmd: 'jobs tokens (--lane <lane> | --coverage) [--since 24h] [--metrics <jobs.jsonl>] [--json]', desc: 'Token use for one lane, or --coverage for measured vs unknown jobs in every lane.', topic: 'observability' },
  { cmd: 'jobs empty-why [--since 24h] [--metrics <jobs.jsonl>] [--json]', desc: 'Why jobs ended empty, ranked by recorded wasted tokens.', topic: 'observability' },
  { cmd: 'jobs gaps [--since 24h] [--propose] [--json]', desc: 'Turn gaps listed by no-change jobs into new work; --propose queues the new ones.', topic: 'observability' },
  { cmd: 'jobs stranded [--since 24h] [--runs-dir <dir>] [--json]', desc: 'Finished jobs that pushed a branch but opened no PR: job, repo, branch, age, files changed and one next step. Read-only; unknown stays unknown.', topic: 'observability' },
  { cmd: 'metrics idle --status <snapshot.json> --jobs <jobs.jsonl> [--json]', desc: 'Estimate idle slot-minutes and flag long-running jobs from local snapshots.', topic: 'autonomy' },
  { cmd: 'graph nodes|edges|status [--json]', desc: 'Read-only GRAPH-1 nodes, edges, and availability; unavailable data exits 1. See phm graph --help.', topic: 'knowledge' },
  { cmd: 'radar list|run|diff [--json]', desc: 'Public docs observation: list sources, run independent fetches, and diff local snapshots. HTTPS GET only, no credentials. See docs/RADAR.md.', topic: 'observability' },
  { cmd: 'observe [--json]', desc: 'Human observe snapshot: roster, sensor headroom, pull headlines, bottlenecks, and human steps. Unknown stays unknown. See docs/OBSERVE.md.', topic: 'observability' },
  { cmd: 'context --for-agent <lane> [--json]', desc: 'Compact under-4KB brief for one lane: claims, open pulls, bottlenecks, blind spots, and pacing. See docs/WORLD.md.', topic: 'observability' },
  { cmd: 'context pack <goal-text|prompt-file> [--max-files 12] [--json]', desc: 'Starting pack for one job: top files with reasons, related commands, and recent merged jobs that may already cover the goal. Offline.', topic: 'observability' },
  { cmd: 'claim acquire <work-key> --lane <lane> [--json]', desc: 'Claim a work key before starting. Refuses a live claim or open pull on that key and returns the holder.', topic: 'observability' },
  { cmd: 'claim release <work-key> --lane <lane> --reason open|merge|abandon [--json]', desc: 'Release this lane claim when a pull opens, merges, or is abandoned.', topic: 'observability' },
  { cmd: 'growth [--json] [--range 1H|1D|1W|1M] [--prs <file>]', desc: 'Growth chart series from local ledgers. A missing source is no-data-source and a world-model blind spot. See docs/GROWTH.md.', topic: 'observability' },
  { cmd: 'world [--json] [--refresh]', desc: 'Cached ashlr.world-model/v1 for the scheduler and leaders. blindSpots lists each unknown field by path with a stable id. See docs/WORLD.md.', topic: 'observability' },
  { cmd: 'world get <path> [--json]', desc: 'Read one node from the cached world model. A missing path is unknown, not zero.', topic: 'observability' },
  { cmd: 'chain verify [--json]', desc: 'Synthetic in-memory chain checks. Does not verify live transports.', topic: 'observability' },
  { cmd: 'incident report|receipts [--json]', desc: 'Turn a production signal into one bounded fix job, or send receipts for finished incidents.', topic: 'observability' },
  { cmd: 'router rank --tier <local|mid|frontier> [--routes FILE] [--slots pool=count ...] [--json]', desc: 'Rank supplied router decisions by pool budget reset; advisory, no writes.', topic: 'observability' },
  { cmd: 'router serve|models|pick|config [--json]', desc: 'Loopback OpenAI-compatible endpoint over routeSeat, its model list, a routing preview and the versioned config. See docs/ROUTER-GATEWAY.md.', topic: 'observability' },
  { cmd: 'router-calibration --jobs <jobs.jsonl> [--posthog <runs.json>] [--json]', desc: 'Compare recorded router predictions with outcomes and usage.', topic: 'observability' },
  { cmd: 'router outcomes [--json] [--runs-dir <dir>] [--lane <lane>] [--limit <1..1000>]', desc: 'Per-job outcome records folded from the metrics ledger: merge state, CI first pass, review findings, cost, wall time and advisory pass^k. Read-only.', topic: 'observability' },
  { cmd: 'metrics impact [--json] [--jobs path] [--queue path] [--overrides path]', desc: 'Versioned offline impact rewards, template ranking and advisory bandit recommendations from local PR and job evidence.', topic: 'autonomy' },
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
  { cmd: 'doctor merge-path --repo owner/name', desc: 'Read-only required-check sentinel for recent PR heads.', topic: 'core' },
  { cmd: 'doctor worktree [--repair] [--json]', desc: 'Can this checkout typecheck and lint? Reports node_modules, tsgo and eslint, with the one command that fixes each. Also shows the source checkout (branch, commits behind, lockfile) and its repair log; --repair runs npm ci in this worktree only.', topic: 'core' },
  { cmd: 'doctor build [--json]', desc: 'Is the phm running on this host the code the fleet merged? The running commit (embedded at build time, else HEAD of the directory phm runs from), its branch, and how many commits it is behind origin/master (local ref, no network), then one verdict line. Unknown stays unknown, with the reason. Reads only; never fetches, pulls or rebuilds.', topic: 'core' },
  { cmd: 'doctor supply [--json]', desc: 'Is self-supply landing jobs? Per source in the host ingest log: last ingest and jobs in 24 h; rejected drops by reason; whether the self-tick gap hook is on; the live build line and the last self-tick line; gap candidates now by source (no-change vs published); self-held lanes (3+ held launches, no finish in 60 min); the top EMPTY reason in 24 h; one verdict line. Gap jobs show as source gap. Missing files read as unknown with the path.', topic: 'core' },
