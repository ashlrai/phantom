/**
 * Narrow the fleet map to the agents you care about: by lane, repo and state.
 * `phm map --lane/--repo/--state`, and the desktop and phone Map views all call
 * `filterLiveMap`, so the CLI, agents and both screens agree on what matches.
 *
 * Pure. An agent is a job node. A job whose lane or repo no source reported is "unknown":
 * it never matches a named lane or repo, and `--lane unknown` / `--repo unknown` finds it.
 * The result keeps the leader, the lanes that still hold a match, the computers they run on
 * and the lanes' pools, and drops every edge with a missing end.
 */
import { orgLayoutOf } from './org-layout-3d.js';
import type { FleetLiveMap, LiveMapEdge, LiveMapNode } from './live-map.js';

/** The words a person picks from. `unknown` is a real answer: no source said. */
export const MAP_STATES = ['running', 'waiting', 'done', 'failed', 'unknown'] as const;
export type MapState = (typeof MAP_STATES)[number];
export const MAP_FILTER_UNKNOWN = 'unknown';
export const MAP_FILTER_EMPTY = 'No agents match these filters.';
/** Same shape queue lines use for lanes and repos. */
export const MAP_FILTER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

export interface MapFilter { lane?: string | null; repo?: string | null; state?: MapState | null }
/** What the filtered map reports about itself (`filter` on fleet.live-map.v1). */
export interface MapFilterResult { lane: string | null; repo: string | null; state: MapState | null; matched: number; total: number }

/** One word for a job: its raw status plus the org state (`done` = published). */
export function jobMapState(status: string, orgState?: string | null): MapState {
  if (orgState === 'done' || status === 'done' || status === 'finished' || status === 'merged') return 'done';
  if (['failed', 'error', 'crashed', 'exited', 'killed', 'timeout'].includes(status)) return 'failed';
  if (['queued', 'parked', 'held', 'idle', 'waiting', 'blocked'].includes(status)) return 'waiting';
  if (['running', 'launching', 'publishing'].includes(status)) return 'running';
  return 'unknown';
}

const norm = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
/** The job's own words, so every caller reads one rule. */
const laneOf = (node: LiveMapNode) => norm(node.lane) || MAP_FILTER_UNKNOWN;
const repoOf = (node: LiveMapNode) => norm(node.repo) || MAP_FILTER_UNKNOWN;
const stateOf = (node: LiveMapNode): MapState => node.state ?? jobMapState(node.status);

export const isMapFilterActive = (filter: MapFilter | null | undefined): boolean =>
  Boolean(norm(filter?.lane) || norm(filter?.repo) || filter?.state);

/** True when this job passes every chosen filter. */
export function jobMatches(node: LiveMapNode, filter: MapFilter): boolean {
  const lane = norm(filter.lane), repo = norm(filter.repo);
  return node.kind === 'job' && (!lane || laneOf(node) === lane) && (!repo || repoOf(node) === repo) && (!filter.state || stateOf(node) === filter.state);
}

/** The lanes, repos and states present among the jobs, for the pickers. Sorted; `unknown` last. */
export function mapFilterChoices(map: Pick<FleetLiveMap, 'nodes'>): { lanes: string[]; repos: string[]; states: MapState[] } {
  const jobs = map.nodes.filter(node => node.kind === 'job');
  const distinct = (pick: (node: LiveMapNode) => string) => [...new Set(jobs.map(pick))]
    .sort((a, b) => (a === MAP_FILTER_UNKNOWN ? 1 : b === MAP_FILTER_UNKNOWN ? -1 : a < b ? -1 : a > b ? 1 : 0));
  return { lanes: distinct(laneOf), repos: distinct(repoOf), states: MAP_STATES.filter(state => jobs.some(node => stateOf(node) === state)) };
}

/** `fleet.live-map.v1` narrowed to the filter. No filter: the same map back, unchanged. */
export function filterLiveMap(map: FleetLiveMap, filter: MapFilter | null | undefined): FleetLiveMap {
  if (!filter || !isMapFilterActive(filter)) return map;
  const lane = norm(filter.lane), repo = norm(filter.repo), state = filter.state ?? null;
  const jobs = map.nodes.filter(node => node.kind === 'job');
  const keptJobs = new Set(jobs.filter(node => jobMatches(node, filter)).map(node => node.id));
  const parentOf = new Map(map.edges.filter(edge => edge.kind === 'reports-to').map(edge => [edge.from, edge.to]));
  // A lane stays when it is the chosen lane, or (with no lane chosen) when a kept job reports to it.
  const keptLanes = new Set<string>();
  for (const node of map.nodes) {
    if (node.kind !== 'lane') continue;
    const holdsMatch = [...keptJobs].some(id => parentOf.get(id) === node.id);
    if (lane ? norm(node.label) === lane && (!(repo || state) || holdsMatch) : holdsMatch) keptLanes.add(node.id);
  }
  const keep = new Set<string>(['leader', ...keptLanes, ...keptJobs]);
  for (const edge of map.edges) {
    if (edge.kind === 'runs-on' && keptJobs.has(edge.from)) keep.add(edge.to);
    if (edge.kind === 'uses-resource' && keptLanes.has(edge.from)) keep.add(edge.to);
  }
  const nodes = map.nodes.filter(node => keep.has(node.id));
  const ids = new Set(nodes.map(node => node.id));
  const edges: LiveMapEdge[] = map.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  const count = (kind: LiveMapNode['kind']) => nodes.filter(node => node.kind === kind).length;
  const talk = edges.filter(edge => edge.kind === 'messaged-in-last-15-min');
  const messages = talk.some(edge => edge.messages === null) ? null : talk.reduce((sum, edge) => sum + (edge.messages ?? 0), 0);
  const gaps = [...map.gaps];
  if ((state === 'failed' || state === 'waiting') && !jobs.some(node => stateOf(node) === state))
    gaps.push(`No source reports ${state} jobs on this map yet, so none can be shown.`);
  const result: MapFilterResult = { lane: lane || null, repo: repo || null, state, matched: keptJobs.size, total: jobs.length };
  const stamp = { generatedAt: map.generatedAt, nodes, edges };
  return { ...map, nodes, edges, counts: { lanes: count('lane'), jobs: count('job'), computers: count('computer'), resources: count('resource'), messages },
    unmappedMessages: null, gaps, filter: result, orgLayout: orgLayoutOf(stamp) };
}

/** Why the CLI refused a filter, or null when it is fine. */
export function mapFilterError(filter: MapFilter): string | null {
  for (const key of ['lane', 'repo'] as const) {
    const value = filter[key];
    if (value !== undefined && value !== null && !MAP_FILTER_NAME_RE.test(value)) return `--${key} takes a name like claude or phantom (or "unknown").`;
  }
  if (filter.state && !(MAP_STATES as readonly string[]).includes(filter.state)) return `--state takes one of: ${MAP_STATES.join(', ')}.`;
  return null;
}

/** The chosen filters in plain words: "lane claude, state running". Empty when none. */
export const describeMapFilter = (filter: MapFilter): string =>
  [filter.lane && `lane ${filter.lane}`, filter.repo && `repo ${filter.repo}`, filter.state && `state ${filter.state}`].filter(Boolean).join(', ');
