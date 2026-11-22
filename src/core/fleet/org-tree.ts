/**
 * The organization as one tree: the leader, each lane, and each lane's active
 * jobs. `phm org` prints it and the Fleet map renders it; both read this file.
 * Pure. A fact no source reported is `null` (shown as "unknown"), never 0.
 */
import type { FleetLaneState } from './fleet-types.js';
import { ORG_LANES, type FleetOrgMap } from './org-map.js';
import type { ProviderName } from './provider.js';
import type { ResourceLedgerV1 } from './runs-resource-ledger.js';
import type { FleetRunsDirState } from './runs-dir-state.js';
import type { LaneModelSnapshot } from './lane-models.js';
import type { LeaderSeatReport } from './leader-seat.js';
import type { LaneHealth } from './lane-badge.js';

/** A job or lane counts as live when something happened within this window. */
export const ORG_LIVE_WINDOW_MS = 5 * 60_000;
/** A planner is quiet after this long without a sign; the same 90 minutes `phm fleet brains` uses. */
export const ORG_PLANNER_QUIET_MS = 90 * 60_000;
type Health = 'healthy' | 'missing' | 'degraded' | 'unknown';
/** One word for every node. `done` is a job whose publish record already has a RESULT line. */
export type OrgState = 'running' | 'idle' | 'held' | 'done' | 'unknown';

export interface OrgTreeJob {
  id: string; repo: string | null; model: string | null; provider: ProviderName; status: string;
  /** Dispatch tier (frontier, work, ...); null when the dispatcher did not record one. */
  tier: string | null;
  /** Seconds since the job started, measured when the tree was built. */
  ageSeconds: number | null;
  /** The task title as one line; null when no source reported it (session rows never carry the prompt). */
  goal: string | null;
  state: OrgState;
  /** What the job is doing, in plain words. */
  doing: string;
  startedAt: string | null;
  prUrl: string | null;
  /** Newest dispatcher event naming the job, else its start. `kind` is the dispatcher's word (LAUNCH, PUBLISH_START) or `started`. */
  lastEvent: { at: string; kind: string } | null;
  /** Newest of the last event and, when a worker process was seen, the time the tree was built. */
  lastActivityAt: string | null;
}
export interface OrgTreeLane {
  lane: string; provider: ProviderName;
  /** The model its jobs share, else the lane's newest launch; null when neither is known. */
  model: string | null;
  state: OrgState; doing: string; heldReason: string | null;
  /** Running jobs reported by the dispatcher or resource ledger. */
  running: number | null; target: number | null; queued: number | null; held: boolean | null;
  /** Pool usage and when it was measured. */
  usage: { usedPct: number | null; asOf: string | null; resetAt: string | null };
  /** The lane's health badge (ok, held, starved, wasteful, drained) with its plain reason; null when the lanes read had no verdict for it. */
  health: LaneHealth | null;
  jobs: OrgTreeJob[];
}
export type OrgPlannerId = 'executor' | 'orchestrator' | 'guardian' | 'comms';
/** The layer between the leader and the lanes. Each reads only evidence the tree already has: dispatch events or agent messages. */
export interface OrgTreePlanner {
  id: OrgPlannerId; label: string;
  /** What this planner is for, in plain words. */
  role: string;
  /** `running` = a sign within 90 minutes, `idle` = an older sign, `unknown` = no sign in the window read. */
  state: OrgState; doing: string;
  lastActivityAt: string | null;
}
export interface FleetOrgTree {
  schema: 'fleet.org.v1';
  /** Bumped only when a field is removed or changes meaning; new fields do not bump it. */
  version: 1;
  leaderSeat?: LeaderSeatReport;
  generatedAt: string | null;
  /** `state` and `doing` describe the dispatcher the leader works through; the leader's own process, provider and model are not reported. */
  leader: { label: string; status: string; provider: ProviderName; model: string | null; state: OrgState; doing: string; dispatcher: { lastTick: string | null; paused: boolean | null } };
  /** Executor, Core orchestrator, main guardian and comms, always in that order. Optional only because older servers do not send it. */
  planners?: OrgTreePlanner[];
  lanes: OrgTreeLane[];
  /** False when no job source answered: an empty lane is then unknown, not idle. */
  jobsKnown: boolean;
  /** Agent-to-agent message lines in the window; null when the bus could not be read. */
  messages: { from: string; to: string; count: number | null; lastAt?: string }[] | null;
  messageWindowMinutes: number; unmappedMessages: number | null;
  sources: FleetOrgMap['sources'] & { lanes: Health; usage: Health };
}
export interface OrgTreeInputs {
  leaderSeat?: LeaderSeatReport;
  /** dispatchd's lane counts and recent events (`readFleetRunsDirState`). */
  runs?: FleetRunsDirState | null;
  /** Pool usage (`readResourceLedger`). */
  usage?: ResourceLedgerV1 | null;
  /** In-app engine lanes; used for a lane the dispatcher does not report. */
  engineLanes?: readonly FleetLaneState[] | null;
  /** Each lane's newest launch (`getLaneModelSnapshot`). */
  models?: LaneModelSnapshot | null;
  /** Each lane's health verdict (`getFleetLaneSnapshot`); a lane with none reads `health: null`. */
  laneHealth?: readonly { lane: string; health?: LaneHealth | null }[] | null;
}

const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: string | undefined): string | null => value && value !== 'unknown' ? value : null;
const newest = (...times: Array<string | null | undefined>): string | null =>
  times.filter((at): at is string => !!at && Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
function jobState(status: string, published: boolean | undefined): OrgState {
  return published ? 'done' : status === 'stale' || status === 'unknown' ? 'unknown' : 'running';
}
function jobDoing(state: OrgState, status: string, repo: string | null): string {
  if (state === 'done') return 'Published its result; waiting for cleanup';
  if (state === 'unknown') return status === 'stale' ? 'Dispatched, but no sign of life' : 'Unknown';
  return status === 'launching' ? 'Starting up' : status === 'publishing' ? 'Opening its pull request' : repo ? `Working in ${repo}` : 'Working';
}

/** Idle and held lanes say why in plain words. */
function laneDoing(state: OrgState, heldReason: string | null, target: number | null, queued: number | null, active: number): string {
  if (state === 'held') return heldReason ? `Held: ${heldReason}` : 'Held, reason not reported';
  if (state === 'running') return `${plural(active, 'job')} running`;
  if (state === 'unknown') return 'Unknown';
  if (target === 0) return queued ? `Turned off (0 seats), ${queued} queued` : 'Turned off (0 seats)';
  return queued ? `Idle, ${queued} queued` : queued === 0 ? 'Idle, nothing queued' : 'Idle';
}

const PLANNERS: { id: OrgPlannerId; label: string; role: string }[] = [
  { id: 'executor', label: 'Executor', role: 'Turns the leader\'s plan into queued jobs' },
  { id: 'orchestrator', label: 'Core orchestrator', role: 'Splits and routes work to lanes' },
  { id: 'guardian', label: 'Main guardian', role: 'Keeps each default branch green' },
  { id: 'comms', label: 'Comms', role: 'Carries messages between you and the fleet' },
];
/**
 * Planner state from evidence the tree already holds. Executor and orchestrator are attributed from
 * dispatch event kinds exactly as `phm fleet brains` does (LEADER, ORCH-*); guardian and comms from agent
 * messages that touch the guardian or a channel. That window is short, so no sign is unknown, never idle.
 */
function plannerRows(map: FleetOrgMap, runs: FleetRunsDirState | null | undefined): OrgTreePlanner[] {
  const at = map.generatedAt ? Date.parse(map.generatedAt) : NaN;
  const eventsRead = !!runs && (runs.sources.events === 'healthy' || runs.sources.events === 'degraded');
  const kinds: Partial<Record<OrgPlannerId, (kind: string) => boolean>> = { executor: kind => kind === 'LEADER', orchestrator: kind => kind.startsWith('ORCH-') };
  const kindOf = new Map(map.nodes.map(node => [node.id, node.kind]));
  const touches = (id: OrgPlannerId) => (node: string) => id === 'guardian' ? node === 'guardian' : kindOf.get(node) === 'channel';
  return PLANNERS.map(({ id, label, role }): OrgTreePlanner => {
    const match = kinds[id];
    const known = match ? eventsRead : map.sources.messages === 'available';
    const last = !known ? null : match ? runs!.events.find(event => match(event.kind))?.at ?? null
      : newest(...map.edges.filter(edge => edge.kind === 'message' && (touches(id)(edge.from) || touches(id)(edge.to))).map(edge => edge.lastAt));
    const quiet = last && Number.isFinite(at) ? at - Date.parse(last) > ORG_PLANNER_QUIET_MS : null;
    const state: OrgState = quiet === null ? 'unknown' : quiet ? 'idle' : 'running';
    const doing = !known ? (match ? 'Unknown: the dispatch log could not be read' : 'Unknown: agent messages could not be read')
      : !last ? (match ? 'Unknown: no sign in the recent dispatch log' : 'Unknown: no messages in this window')
      : state === 'running' ? 'Active' : state === 'idle' ? 'Quiet for over 90 minutes' : 'Unknown';
    return { id, label, role, state, doing, lastActivityAt: last };
  });
}

/** Oldest first; a job with no known start sorts last. */
const start = (job: OrgTreeJob) => job.startedAt ? Date.parse(job.startedAt) : Number.MAX_SAFE_INTEGER;

export function fleetOrgTree(map: FleetOrgMap, inputs: OrgTreeInputs = {}): FleetOrgTree {
  const { runs, usage } = inputs;
  const laneCounts = new Map(runs?.lanes.map(row => [row.lane, row]));
  const usageRows = new Map(usage?.lanes.map(row => [row.lane, row]));
  const engines = new Map(inputs.engineLanes?.map(row => [String(row.lane), row]));
  const label = new Map(map.nodes.map(node => [node.id, node.label]));
  const parent = new Map(map.edges.filter(edge => edge.kind === 'reports-to').map(edge => [edge.from, edge.to]));
  // Event text starts with the job id; match whole words so RQ-A never claims RQ-AB's event.
  const lastEvent = (job: string) => runs?.events.find(event => event.text.split(/[\s=,]+/).includes(job)) ?? null;

  const jobsKnown = map.sources.fleet === 'available' || map.sources.sessions === 'healthy' || map.sources.sessions === 'degraded';
  const healths = new Map(inputs.laneHealth?.map(row => [row.lane, row.health ?? null]));
  const launches = new Map(inputs.models?.lanes.map(row => [row.lane, row.lastLaunch?.model ?? null]));
  const lanes = map.nodes.filter(node => node.kind === 'lane').map((node): OrgTreeLane => {
    const row = laneCounts.get(node.label), pool = usageRows.get(node.label), engine = engines.get(node.label);
    const jobs = map.nodes.filter(job => job.kind === 'job' && parent.get(job.id) === node.id).map((job): OrgTreeJob => {
      const startedAt = job.startedAt ?? null, event = lastEvent(job.jobId!);
      const last = event ? { at: event.at, kind: event.kind } : startedAt ? { at: startedAt, kind: 'started' } : null;
      const state = jobState(job.status, job.published);
      return { id: job.jobId!, repo: text(job.repo), model: text(job.model), provider: job.provider, status: job.status,
        tier: job.tier ?? null, ageSeconds: job.ageSeconds ?? null, goal: job.goal ?? null, state, doing: jobDoing(state, job.status, text(job.repo)), startedAt,
        lastEvent: last, lastActivityAt: newest(last?.at, job.processLive === 'yes' ? map.generatedAt : null) };
    }).sort((a, b) => start(a) - start(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const live = jobs.filter(job => job.state === 'running').length;
    // Counts already exclude completed attempts upstream. Never subtract recent jobs again.
    const reported = row ? row.running : count(pool?.running);
    const running = reported === null ? count(engine?.busy) : reported;
    const held = row ? row.held : pool?.held ?? null, queued = row ? row.queued : null;
    const state: OrgState = held ? 'held' : (running ?? 0) > 0 || live > 0 ? 'running' : running === 0 || (jobsKnown && !jobs.length) ? 'idle' : 'unknown';
    const models = [...new Set(jobs.map(job => job.model))];
    const target = row ? row.target : count(pool?.target) ?? count(engine?.slots);
    return { lane: node.label, provider: node.provider,
      model: (models.length === 1 ? models[0] : null) ?? launches.get(node.label) ?? null, state,
      doing: laneDoing(state, row?.heldReason ?? null, target, queued, running || live),
      heldReason: row?.heldReason ?? null, running, target, queued, held, health: healths.get(node.label) ?? null,
      usage: { usedPct: count(pool?.usedPct), asOf: pool ? pool.observation?.asOf ?? usage?.asOf ?? null : null, resetAt: pool?.resetAt ?? null },
      jobs };
  });
  const rank = (lane: string) => { const index = (ORG_LANES as readonly string[]).indexOf(lane); return index < 0 ? ORG_LANES.length : index; };
  lanes.sort((a, b) => rank(a.lane) - rank(b.lane) || (a.lane < b.lane ? -1 : 1));

  const leader = map.nodes.find(node => node.kind === 'leader');
  const messages = map.sources.messages !== 'available' ? null : map.edges.filter(edge => edge.kind === 'message')
    .map(edge => ({ from: label.get(edge.from) ?? 'unknown', to: label.get(edge.to) ?? 'unknown', count: edge.count ?? null, ...(edge.lastAt ? { lastAt: edge.lastAt } : {}) }))
    .sort((a, b) => `${a.from}\n${a.to}` < `${b.from}\n${b.to}` ? -1 : 1);
  // A held lane can still have jobs running, so count jobs, not lane states.
  const paused = runs?.paused ?? null, working = lanes.map(lane => lane.running || lane.jobs.filter(job => job.state === 'running').length).filter(n => n > 0);
  const total = working.reduce((sum, n) => sum + n, 0);
  const state: OrgState = paused ? 'held' : total ? 'running' : paused === false ? 'idle' : 'unknown';
  return { schema: 'fleet.org.v1', version: 1, generatedAt: map.generatedAt,
    ...(inputs.leaderSeat ? { leaderSeat: inputs.leaderSeat } : {}),
    leader: { label: leader?.label ?? 'Leader', status: leader?.status ?? 'unknown', provider: leader?.provider ?? 'unknown', model: null, state,
      doing: state === 'held' ? 'Dispatch is paused' : state === 'running' ? `Directing ${plural(total, 'running job')} across ${plural(working.length, 'lane')}`
        : state === 'idle' ? 'No jobs running' : 'Unknown',
      dispatcher: { lastTick: runs?.lastTick ?? null, paused } },
    planners: plannerRows(map, runs), lanes, jobsKnown,
    messages, messageWindowMinutes: map.messageWindowMinutes, unmappedMessages: map.unmappedMessages,
    sources: { ...map.sources, lanes: runs?.sources.status ?? 'unknown', usage: usage?.sources.status ?? 'unknown' } };
}

/** True within the live window, false outside it, null when no activity time is known. */
export function orgLive(lastActivityAt: string | null, now: number): boolean | null {
  if (!lastActivityAt) return null;
  const age = now - Date.parse(lastActivityAt);
  return age <= ORG_LIVE_WINDOW_MS && age >= -60_000;
}

/** "3m ago", or "unknown". Shared by `phm org --text` and the Fleet map. */
export function orgAgo(at: string | null, now: number): string {
  const seconds = at ? Math.floor((now - Date.parse(at)) / 1000) : NaN;
  if (!Number.isFinite(seconds) || seconds < -60) return 'unknown';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return seconds < 86_400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86_400)}d ago`;
}
const shown = (value: number | null) => value === null ? 'unknown' : String(value);
/** One plain line of lane counts: "2 running of 8, 3 queued". */
export function orgLaneCounts(lane: OrgTreeLane): string {
  return `${shown(lane.running)} running of ${shown(lane.target)}, ${shown(lane.queued)} queued${lane.held ? ', held' : ''}`;
}
export function orgLaneUsage(lane: OrgTreeLane, now: number): string {
  return lane.usage.usedPct === null ? 'usage unknown' : `usage ${Math.round(lane.usage.usedPct)}% (measured ${orgAgo(lane.usage.asOf, now)})`;
}

export function renderOrgTreeText(tree: FleetOrgTree, now = Date.now()): string {
  const { dispatcher } = tree.leader;
  const lines = [`${tree.leader.label}: ${tree.leader.state}. ${tree.leader.doing}. Dispatcher ${dispatcher.paused === null ? 'state unknown' : dispatcher.paused ? 'paused' : 'running'}, last tick ${orgAgo(dispatcher.lastTick, now)}.`];
  if (tree.planners) lines.push('  Planners:', ...tree.planners.map(row => `    ${row.label}: ${row.state}. ${row.doing}. Last sign ${orgAgo(row.lastActivityAt, now)}.`));
  for (const lane of tree.lanes) {
    // A bare "Idle" would only repeat the state word.
    const why = lane.state === 'held' || (lane.state === 'idle' && lane.doing !== 'Idle') ? `${lane.doing}. ` : '';
    lines.push(`  ${lane.lane} (${lane.provider}, ${lane.model ?? 'model unknown'}): ${lane.state}. ${why}${orgLaneCounts(lane)}, ${orgLaneUsage(lane, now)}`);
    if (!lane.jobs.length) lines.push(tree.jobsKnown ? '    idle' : '    jobs unknown');
    for (const job of lane.jobs) {
      const live = orgLive(job.lastActivityAt, now);
      lines.push(`    ${live ? '*' : '-'} ${job.id} | ${job.state} | ${job.doing} | ${job.model ?? 'model unknown'} | started ${orgAgo(job.startedAt, now)} | last event ${job.lastEvent ? `${job.lastEvent.kind} ${orgAgo(job.lastEvent.at, now)}` : 'unknown'} | tier ${job.tier ?? 'unknown'} | goal ${job.goal ?? 'unknown'}`);
    }
  }
  lines.push(tree.messages === null ? 'Messages: unknown' : tree.messages.length
    ? `Messages in the last ${tree.messageWindowMinutes} minutes:\n${tree.messages.map(row => `  ${row.from} -> ${row.to}: ${shown(row.count)}`).join('\n')}`
    : `Messages in the last ${tree.messageWindowMinutes} minutes: none`);
  lines.push('* = active in the last 5 minutes. Updated ' + (tree.generatedAt ?? 'unknown') + '.');
  return lines.join('\n');
}
