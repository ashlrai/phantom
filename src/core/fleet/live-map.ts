/**
 * The whole fleet as one live graph: the leader, lanes, running jobs (agents),
 * computers and pool resources, with who reports to whom, what runs where,
 * which lane draws on which pool and who messaged whom in the last 15 minutes.
 * `phm map` prints it, GET /api/verse/fleet/control/live-map serves it and the
 * desktop Map pane draws it.
 *
 * Pure join of reads that already exist, no source of its own: the org map
 * and tree (`phm org`, org-map.ts / org-tree.ts; its message edges are the bus
 * projection behind `phm messages`), the computers view (`phm nodes`,
 * nodes-view.ts) and the pool-usage ledger the org tree already reads. A fact
 * no source reported stays "unknown" / null and is listed in `gaps`.
 *
 * Stable: ids are derived from names (`lane:claude`, `job:RQ-A`,
 * `computer:node-a`), nodes are ordered by level then a fixed order, edges by
 * kind then id, and every node and edge carries the same keys in the same
 * order, so the same inputs and clock always print byte-identical JSON.
 */
import { fleetOrgTree, orgLaneCounts, orgLive, type FleetOrgTree, type OrgTreeJob } from './org-tree.js';
import type { FleetOrgMap } from './org-map.js';
import { orgLayoutOf, type FleetOrgLayout3D } from './org-layout-3d.js';
import type { NodesView } from './nodes-view.js';
import { providerFor, type ProviderName } from './provider.js';
import type { LaneHealth } from './lane-badge.js';
import { describeMapFilter, jobMapState, MAP_FILTER_EMPTY, type MapFilterResult, type MapState } from './map-filter.js';
import type { FleetLaneSnapshot } from './lane-console.js';
import type { ResourceLedgerV1 } from './runs-resource-ledger.js';

export const LIVE_MAP_WINDOW_MINUTES = 15;
/** An edge whose newest message is this recent pulses. */
export const LIVE_MAP_PULSE_MS = 60_000;
/** Message line thickness by count, shared by the 2D and 3D maps: 1 message is thin, 10 or more is the cap. Unknown counts draw thin. */
export const messageLineWidth = (count: number | null | undefined): number => Math.min(6, 1.25 + 0.5 * Math.max(1, count ?? 1));

export type LiveMapNodeKind = 'leader' | 'lane' | 'job' | 'computer' | 'resource';
export type LiveMapEdgeKind = 'reports-to' | 'runs-on' | 'uses-resource' | 'messaged-in-last-15-min';
/** Rows of the 2D view, top to bottom: leader, lanes, jobs, computers, resources. */
export const LIVE_MAP_LEVEL: Readonly<Record<LiveMapNodeKind, number>> = { leader: 0, lane: 1, job: 2, computer: 3, resource: 4 };
const EDGE_ORDER: readonly LiveMapEdgeKind[] = ['reports-to', 'runs-on', 'uses-resource', 'messaged-in-last-15-min'];

/** Key order is the JSON contract. */
export interface LiveMapNode {
  id: string;
  kind: LiveMapNodeKind;
  level: number;
  label: string;
  /** Lanes and jobs: the provider behind them; 'unknown' otherwise. */
  provider: ProviderName;
  /** A short state code; 'unknown' when no source said. */
  status: string;
  /** One plain line for people. */
  detail: string;
  /** Jobs: activity in the last 5 minutes (null when no time is known). Null for other kinds. */
  live: boolean | null;
  /** Lanes: ok | held | starved | wasteful | drained with a plain reason (lane-badge.ts). Absent when the lanes read failed or from older servers. */
  health?: LaneHealth;
  /** Lanes: merged PRs per hour from the lanes read; null when that read had no number. Absent from older servers. */
  mergedPerHour?: number | null;
  /** Computers: true when it is another Mac, not this one. Absent for this Mac, other kinds and older servers. */
  remote?: boolean;
  /** Pools: percent of the plan used (0..100); null when no reading. Absent from older servers. */
  usedPct?: number | null;
  /** Jobs: the lane and repo the job reports (null = unknown), and its state in the filter's words. Absent from older servers. */
  lane?: string | null;
  repo?: string | null;
  state?: MapState;
}
export interface LiveMapEdge {
  id: string;
  kind: LiveMapEdgeKind;
  from: string;
  to: string;
  /** Message edges: messages in the window. Null for other kinds. */
  messages: number | null;
  /** Message edges: the newest message (ISO), when known. */
  lastMessageAt: string | null;
  /** A message on this edge in the last minute. */
  pulse: boolean;
}
type SourceState = 'available' | 'unknown';
export interface FleetLiveMap {
  schema: 'fleet.live-map.v1';
  generatedAt: string;
  windowMinutes: number;
  pulseSeconds: number;
  nodes: LiveMapNode[];
  edges: LiveMapEdge[];
  counts: { lanes: number; jobs: number; computers: number; resources: number; messages: number | null };
  sources: { org: SourceState; jobs: SourceState; computers: SourceState; resources: SourceState; messages: 'available' | 'missing' | 'unavailable' | 'unknown' };
  /** Messages whose sender or receiver is not on this map (a channel, the guardian, an unknown agent). Null when unknown. */
  unmappedMessages: number | null;
  /** Plain words for every fact the map could not show. */
  gaps: string[];
  /** Where each org node sits in 3D, grouped by who it reports to: the positions the 3D map draws. Absent from older servers. */
  orgLayout?: FleetOrgLayout3D;
  /** Set only when the map was narrowed (`phm map --lane/--repo/--state`): the filters and how many of the jobs matched. */
  filter?: MapFilterResult;
}
export interface LiveMapInputs {
  /** `readFleetOrgSources(15)`: the org map with its tree; null when it could not be read. */
  org?: (FleetOrgMap & { tree?: FleetOrgTree }) | null;
  /** `readNodesView`: one row per computer. */
  computers?: NodesView | null;
  /** The pool-usage ledger (`readResourceLedger`). */
  usage?: ResourceLedgerV1 | null;
  /** `getFleetLaneSnapshot`: each lane's health verdict, shown as a badge on its node. */
  lanes?: Pick<FleetLaneSnapshot, 'lanes'> | null;
  now: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const shown = (value: string | null | undefined) => value && value !== 'unknown' ? value : null;

export function buildFleetLiveMap(inputs: LiveMapInputs): FleetLiveMap {
  const { org, computers, usage, lanes, now } = inputs;
  const nodes = new Map<string, LiveMapNode>();
  const edges = new Map<string, LiveMapEdge>();
  const gaps: string[] = [];
  const node = (kind: LiveMapNodeKind, id: string, label: string, status: string, detail: string, provider: ProviderName = 'unknown', live: boolean | null = null) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, level: LIVE_MAP_LEVEL[kind], label, provider, status, detail, live });
    return id;
  };
  const edge = (kind: LiveMapEdgeKind, from: string, to: string, message?: { count: number | null; lastAt: string | null }) => {
    const id = `${kind}:${from}->${to}`;
    const lastAt = message?.lastAt ?? null, age = lastAt ? now - Date.parse(lastAt) : NaN;
    edges.set(id, { id, kind, from, to, messages: message ? message.count : null, lastMessageAt: lastAt,
      pulse: Number.isFinite(age) && age <= LIVE_MAP_PULSE_MS && age >= -LIVE_MAP_PULSE_MS });
  };

  // Leader, lanes and jobs: the same tree `phm org` prints.
  const tree = org ? org.tree ?? fleetOrgTree(org) : null;
  const { paused } = tree?.leader.dispatcher ?? { paused: null };
  node('leader', 'leader', tree?.leader.label ?? 'Leader', tree?.leader.status ?? 'unknown',
    `dispatcher ${paused === null ? 'state unknown' : paused ? 'paused' : 'running'}`);
  if (!tree) gaps.push('Org unknown: lanes, jobs and messages could not be read.');
  else if (!tree.jobsKnown) gaps.push('Running jobs unknown: no job source answered.');
  const laneId = (lane: string) => `lane:${lane}`;
  const addLane = (lane: string, status = 'unknown', detail = 'counts unknown') =>
    node('lane', laneId(lane), lane, status, detail, providerFor(lane).name);
  const processLive = new Map(org?.nodes.filter(row => row.kind === 'job').map(row => [row.jobId!, row.processLive ?? 'unknown']));
  const localJobs: string[] = [];
  const addJob = (job: OrgTreeJob, lane: string | null) => {
    const id = node('job', `job:${job.id}`, job.id, job.status, `${job.model ?? 'model unknown'} · ${job.repo ?? 'repo unknown'}`, job.provider, orgLive(job.lastActivityAt, now));
    Object.assign(nodes.get(id)!, { lane: lane && lane !== 'unknown' ? lane : null, repo: job.repo, state: jobMapState(job.status, job.state) });
    if (lane) edge('reports-to', id, laneId(lane));
    if (processLive.get(job.id) === 'yes') localJobs.push(id);
  };
  for (const lane of tree?.lanes ?? []) {
    const status = lane.held ? 'held' : lane.running === null ? 'unknown' : lane.running > 0 ? 'running' : 'idle';
    edge('reports-to', addLane(lane.lane, status, orgLaneCounts(lane)), 'leader');
    for (const job of lane.jobs) addJob(job, lane.lane);
  }

  // Computers: `phm nodes`. A job runs on a computer when that computer's registry claim names it,
  // or when a worker process for it was seen on this computer.
  if (!computers) gaps.push('Computers unknown: the computers list could not be read.');
  else for (const reason of computers.reasons) gaps.push(`Computers: ${reason}`);
  const rows = [...computers?.nodes ?? []].sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || cmp(a.name, b.name));
  for (const row of rows) {
    const id = node('computer', `computer:${row.name}`, row.name, row.stateCode, row.isSelf ? `${row.state} (this computer)` : row.state);
    if (!row.isSelf) nodes.get(id)!.remote = true;
    for (const job of row.jobsRunning === 'unknown' ? [] : row.jobsRunning) {
      // A job only the node pool knows about: shown, with its lane unknown.
      const jobId = node('job', `job:${job}`, job, 'running', 'lane unknown', 'unknown');
      if (!nodes.get(jobId)!.state) Object.assign(nodes.get(jobId)!, { lane: null, repo: null, state: 'running' });
      edge('runs-on', jobId, id);
    }
    if (row.isSelf) for (const job of localJobs) edge('runs-on', job, id);
  }

  // Resources: the pool each lane draws on, from the usage ledger.
  if (!usage) gaps.push('Pool usage unknown: the usage ledger could not be read.');
  for (const row of [...usage?.lanes ?? []].sort((a, b) => cmp(a.lane, b.lane))) {
    if (row.window === 'none') continue;
    const what = row.window === 'weekly' ? 'weekly quota' : 'credits';
    const pct = row.usedPct === null ? null : Math.round(row.usedPct);
    const status = row.deadSignal ? 'exhausted' : pct === null ? 'unknown' : pct >= 100 ? 'exhausted' : 'available';
    const detail = row.window === 'credits' && row.creditsRemaining !== null ? `${row.creditsRemaining} credits left`
      : pct === null ? 'usage unknown' : `${pct}% used`;
    const id = node('resource', `resource:${row.lane}`, `${row.lane} ${what}`, status, detail);
    nodes.get(id)!.usedPct = pct;
    edge('uses-resource', nodes.has(laneId(row.lane)) ? laneId(row.lane) : addLane(row.lane), id);
  }

  // Messages in the window, from the org map's bus projection. Endpoints not drawn here are counted, never guessed.
  const messageSource = org?.sources.messages ?? 'unknown';
  let unmapped = messageSource === 'available' ? org?.unmappedMessages ?? 0 : null;
  let messages: number | null = unmapped;
  if (org && messageSource === 'available') {
    for (const row of org.edges) {
      if (row.kind !== 'message') continue;
      const count = row.count ?? 0;
      messages! += count;
      if (!nodes.has(row.from) || !nodes.has(row.to)) { unmapped! += count; continue; }
      edge('messaged-in-last-15-min', row.from, row.to, { count: row.count ?? null, lastAt: shown(row.lastAt) });
    }
  } else gaps.push('Messages unknown: the agent bus could not be read.');
  if (unmapped) gaps.push(`${unmapped} message${unmapped === 1 ? '' : 's'} could not be matched to a node on this map.`);

  for (const view of lanes?.lanes ?? []) {
    const lane = nodes.get(laneId(view.lane));
    if (lane && view.health) lane.health = view.health;
    if (lane) lane.mergedPerHour = view.mergesPerHour ?? null;
  }

  const order = (kind: LiveMapNodeKind) => LIVE_MAP_LEVEL[kind];
  const insertion = [...nodes.keys()];
  const sortedNodes = [...nodes.values()].sort((a, b) => order(a.kind) - order(b.kind)
    // Lanes and computers keep their source order (fixed lane order, this computer first); jobs and resources sort by id.
    || (a.kind === 'job' || a.kind === 'resource' ? cmp(a.id, b.id) : insertion.indexOf(a.id) - insertion.indexOf(b.id)));
  const sortedEdges = [...edges.values()].sort((a, b) => EDGE_ORDER.indexOf(a.kind) - EDGE_ORDER.indexOf(b.kind) || cmp(a.id, b.id));
  const count = (kind: LiveMapNodeKind) => sortedNodes.filter(row => row.kind === kind).length;
  return {
    schema: 'fleet.live-map.v1', generatedAt: new Date(now).toISOString(),
    windowMinutes: LIVE_MAP_WINDOW_MINUTES, pulseSeconds: LIVE_MAP_PULSE_MS / 1000,
    nodes: sortedNodes, edges: sortedEdges,
    counts: { lanes: count('lane'), jobs: count('job'), computers: count('computer'), resources: count('resource'), messages },
    sources: {
      org: tree ? 'available' : 'unknown', jobs: tree?.jobsKnown ? 'available' : 'unknown',
      computers: computers ? 'available' : 'unknown', resources: usage ? 'available' : 'unknown', messages: messageSource,
    },
    unmappedMessages: unmapped, gaps,
    orgLayout: orgLayoutOf({ generatedAt: new Date(now).toISOString(), nodes: sortedNodes, edges: sortedEdges }),
  };
}

/** `phm map` for people: one block per level, then the message lines. */
export function renderFleetLiveMapText(map: FleetLiveMap): string {
  const byKind = (kind: LiveMapNodeKind) => map.nodes.filter(row => row.kind === kind);
  const label = new Map(map.nodes.map(row => [row.id, row.label]));
  const where = new Map(map.edges.filter(row => row.kind === 'runs-on').map(row => [row.from, label.get(row.to)!]));
  const leader = byKind('leader')[0]!;
  const lines = [`${leader.label}: ${leader.status}, ${leader.detail}.`];
  if (map.filter) lines.push(map.filter.matched === 0 ? MAP_FILTER_EMPTY
    : `Showing ${map.filter.matched} of ${map.filter.total} agents (${describeMapFilter(map.filter)}).`);
  const block = <T>(title: string, rows: T[], line: (row: T) => string, empty: string) => {
    lines.push(`${title}:`, ...(rows.length ? rows.map(row => `  ${line(row)}`) : [`  ${empty}`]));
  };
  block('Lanes', byKind('lane'), row => `${row.label} (${row.provider}): ${row.detail}`, map.sources.org === 'available' ? 'none' : 'unknown');
  block('Jobs', byKind('job'), row => `${row.live ? '*' : '-'} ${row.label} | ${row.status} | ${row.detail} | on ${where.get(row.id) ?? 'computer unknown'}`,
    map.sources.jobs === 'available' ? 'none running' : 'unknown');
  block('Computers', byKind('computer'), row => `${row.label}: ${row.detail}`, map.sources.computers === 'available' ? 'none known' : 'unknown');
  block('Resources', byKind('resource'), row => `${row.label}: ${row.detail}`, map.sources.resources === 'available' ? 'none reported' : 'unknown');
  block(`Messages in the last ${map.windowMinutes} minutes`, map.edges.filter(row => row.kind === 'messaged-in-last-15-min'),
    row => `${row.pulse ? '~' : '-'} ${label.get(row.from)} -> ${label.get(row.to)}: ${row.messages ?? 'unknown'}`, map.counts.messages === null ? 'unknown' : 'none');
  for (const gap of map.gaps) lines.push(`note: ${gap}`);
  lines.push(`* = active in the last 5 minutes. ~ = a message in the last minute. Updated ${map.generatedAt}.`);
  return lines.join('\n');
}
