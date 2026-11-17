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

/** A job or lane counts as live when something happened within this window. */
export const ORG_LIVE_WINDOW_MS = 5 * 60_000;
type Health = 'healthy' | 'missing' | 'degraded' | 'unknown';
/** One word for every node. `done` is a job whose publish record already has a RESULT line. */
export type OrgState = 'running' | 'idle' | 'held' | 'done' | 'unknown';

export interface OrgTreeJob {
  id: string; repo: string | null; model: string | null; provider: ProviderName; status: string;
  state: OrgState;
  /** What the job is doing, in plain words. */
  doing: string;
  startedAt: string | null;
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
  /** Running jobs. A job the dispatcher still counts but that already published is not running. */
  running: number | null; target: number | null; queued: number | null; held: boolean | null;
  /** Pool usage and when it was measured. */
  usage: { usedPct: number | null; asOf: string | null; resetAt: string | null };
  jobs: OrgTreeJob[];
}
export interface FleetOrgTree {
  schema: 'fleet.org.v1';
  /** Bumped only when a field is removed or changes meaning; new fields do not bump it. */
  version: 1;
  generatedAt: string | null;
  /** `state` and `doing` describe the dispatcher the leader works through; the leader's own process, provider and model are not reported. */
  leader: { label: string; status: string; provider: ProviderName; model: string | null; state: OrgState; doing: string; dispatcher: { lastTick: string | null; paused: boolean | null } };
  lanes: OrgTreeLane[];
  /** False when no job source answered: an empty lane is then unknown, not idle. */
  jobsKnown: boolean;
  /** Agent-to-agent message lines in the window; null when the bus could not be read. */
  messages: { from: string; to: string; count: number | null }[] | null;
  messageWindowMinutes: number; unmappedMessages: number | null;
  sources: FleetOrgMap['sources'] & { lanes: Health; usage: Health };
}
export interface OrgTreeInputs {
  /** dispatchd's lane counts and recent events (`readFleetRunsDirState`). */
  runs?: FleetRunsDirState | null;
  /** Pool usage (`readResourceLedger`). */
  usage?: ResourceLedgerV1 | null;
  /** In-app engine lanes; used for a lane the dispatcher does not report. */
  engineLanes?: readonly FleetLaneState[] | null;
  /** Each lane's newest launch (`getLaneModelSnapshot`). */
  models?: LaneModelSnapshot | null;
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
  const launches = new Map(inputs.models?.lanes.map(row => [row.lane, row.lastLaunch?.model ?? null]));
  const lanes = map.nodes.filter(node => node.kind === 'lane').map((node): OrgTreeLane => {
    const row = laneCounts.get(node.label), pool = usageRows.get(node.label), engine = engines.get(node.label);
    const jobs = map.nodes.filter(job => job.kind === 'job' && parent.get(job.id) === node.id).map((job): OrgTreeJob => {
      const startedAt = job.startedAt ?? null, event = lastEvent(job.jobId!);
      const last = event ? { at: event.at, kind: event.kind } : startedAt ? { at: startedAt, kind: 'started' } : null;
      const state = jobState(job.status, job.published);
      return { id: job.jobId!, repo: text(job.repo), model: text(job.model), provider: job.provider, status: job.status,
        state, doing: jobDoing(state, job.status, text(job.repo)), startedAt,
        lastEvent: last, lastActivityAt: newest(last?.at, job.processLive === 'yes' ? map.generatedAt : null) };
    }).sort((a, b) => start(a) - start(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const live = jobs.filter(job => job.state === 'running').length, done = jobs.filter(job => job.state === 'done').length;
    // The dispatcher (and the ledger read from it) still counts a published job; the in-app engine never did.
    const reported = row ? row.running : count(pool?.running);
    const running = reported === null ? count(engine?.busy) : Math.max(0, reported - done);
    const held = row ? row.held : pool?.held ?? null, queued = row ? row.queued : null;
    const state: OrgState = held ? 'held' : (running ?? 0) > 0 || live > 0 ? 'running' : running === 0 || (jobsKnown && !jobs.length) ? 'idle' : 'unknown';
    const models = [...new Set(jobs.map(job => job.model))];
    return { lane: node.label, provider: node.provider,
      model: (models.length === 1 ? models[0] : null) ?? launches.get(node.label) ?? null, state,
      doing: state === 'held' ? `Held${row?.heldReason ? `: ${row.heldReason}` : ''}` : state === 'running' ? `${plural(running || live, 'job')} running`
        : state === 'idle' ? (queued ? `Idle, ${queued} queued` : 'Idle') : 'Unknown',
      heldReason: row?.heldReason ?? null, running,
      target: row ? row.target : count(pool?.target) ?? count(engine?.slots), queued, held,
      usage: { usedPct: count(pool?.usedPct), asOf: pool ? pool.observation?.asOf ?? usage?.asOf ?? null : null, resetAt: pool?.resetAt ?? null },
      jobs };
  });
  const rank = (lane: string) => { const index = (ORG_LANES as readonly string[]).indexOf(lane); return index < 0 ? ORG_LANES.length : index; };
  lanes.sort((a, b) => rank(a.lane) - rank(b.lane) || (a.lane < b.lane ? -1 : 1));

  const leader = map.nodes.find(node => node.kind === 'leader');
  const messages = map.sources.messages !== 'available' ? null : map.edges.filter(edge => edge.kind === 'message')
    .map(edge => ({ from: label.get(edge.from) ?? 'unknown', to: label.get(edge.to) ?? 'unknown', count: edge.count ?? null }))
    .sort((a, b) => `${a.from}\n${a.to}` < `${b.from}\n${b.to}` ? -1 : 1);
  // A held lane can still have jobs running, so count jobs, not lane states.
  const paused = runs?.paused ?? null, working = lanes.map(lane => lane.running || lane.jobs.filter(job => job.state === 'running').length).filter(n => n > 0);
  const total = working.reduce((sum, n) => sum + n, 0);
  const state: OrgState = paused ? 'held' : total ? 'running' : paused === false ? 'idle' : 'unknown';
  return { schema: 'fleet.org.v1', version: 1, generatedAt: map.generatedAt,
    leader: { label: leader?.label ?? 'Leader', status: leader?.status ?? 'unknown', provider: leader?.provider ?? 'unknown', model: null, state,
      doing: state === 'held' ? 'Dispatch is paused' : state === 'running' ? `Directing ${plural(total, 'running job')} across ${plural(working.length, 'lane')}`
        : state === 'idle' ? 'No jobs running' : 'Unknown',
      dispatcher: { lastTick: runs?.lastTick ?? null, paused } },
    lanes, jobsKnown,
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
  for (const lane of tree.lanes) {
    lines.push(`  ${lane.lane} (${lane.provider}, ${lane.model ?? 'model unknown'}): ${lane.state}. ${lane.heldReason ? `${lane.heldReason}. ` : ''}${orgLaneCounts(lane)}, ${orgLaneUsage(lane, now)}`);
    if (!lane.jobs.length) lines.push(tree.jobsKnown ? '    idle' : '    jobs unknown');
    for (const job of lane.jobs) {
      const live = orgLive(job.lastActivityAt, now);
      lines.push(`    ${live ? '*' : '-'} ${job.id} | ${job.state} | ${job.doing} | ${job.model ?? 'model unknown'} | started ${orgAgo(job.startedAt, now)} | last event ${job.lastEvent ? `${job.lastEvent.kind} ${orgAgo(job.lastEvent.at, now)}` : 'unknown'}`);
    }
  }
  lines.push(tree.messages === null ? 'Messages: unknown' : tree.messages.length
    ? `Messages in the last ${tree.messageWindowMinutes} minutes:\n${tree.messages.map(row => `  ${row.from} -> ${row.to}: ${shown(row.count)}`).join('\n')}`
    : `Messages in the last ${tree.messageWindowMinutes} minutes: none`);
  lines.push('* = active in the last 5 minutes. Updated ' + (tree.generatedAt ?? 'unknown') + '.');
  return lines.join('\n');
}
