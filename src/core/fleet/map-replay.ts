/**
 * Replay the fleet on the map: `phm map replay`, GET /api/verse/fleet/control/map-replay
 * and the Map pane's time slider.
 *
 * Not a second history: frames are folded from what is already recorded. Jobs,
 * launches, PRs and merges come from the work log's ledger entries (worklog.ts);
 * message lines come from `buildMapEdges` over the bus inbox, once per frame.
 * (Browser-safe half: types and `replayMap`; the reads are in map-replay-build.ts.)
 * The node set of a replayed frame is the live map's own (`replayMap`), so the
 * pane draws a frame with the same layout code as "now".
 *
 * Honest about gaps: a source that could not be read, or that no longer reaches
 * back to a frame, makes that part of the frame `null` and the frame
 * `unknown` / `partly-unknown`. It is never shown as an empty fleet.
 */
import type { MapEdge, MapEdges } from './map-edges.js';
import { LIVE_MAP_LEVEL, type FleetLiveMap, type LiveMapEdge, type LiveMapNode } from './live-map.js';
import { orgLayoutOf } from './org-layout-3d.js';

export const MAP_REPLAY_SCHEMA = 'fleet.map-replay.v1';
export const MAP_REPLAY_DEFAULT_SINCE = '6h';
export const MAP_REPLAY_DEFAULT_STEP = '5m';
export const MAP_REPLAY_MAX_FRAMES = 288;
/** Jobs launched earlier than this before the window start are not looked for. */
export const MAP_REPLAY_LOOKBACK_HOURS = 24;

export type ReplayFrameState = 'known' | 'partly-unknown' | 'unknown';
/** Key order is the JSON contract. */
export interface ReplayJob { job: string; lane: string | null; repo: string | null }
export interface ReplayPr extends ReplayJob { url: string | null }
export interface MapReplayFrame {
  /** The frame covers `from` up to (not including) `at`; the last frame includes `at`. */
  from: string;
  at: string;
  state: ReplayFrameState;
  /** Jobs running at the end of the frame. Null when the jobs history is unknown. */
  running: ReplayJob[] | null;
  launched: ReplayJob[] | null;
  prsOpened: ReplayPr[] | null;
  merged: ReplayPr[] | null;
  /** Message lines inside the frame, from buildMapEdges. Null when the bus history is unknown. */
  messages: MapEdge[] | null;
}
export interface MapReplay {
  schema: typeof MAP_REPLAY_SCHEMA;
  version: 1;
  generatedAt: string;
  since: string;
  until: string;
  stepSeconds: number;
  sources: { jobs: 'available' | 'unknown'; messages: MapEdges['source'] };
  /** Oldest first. */
  frames: MapReplayFrame[];
  /** Plain words for every part of the history that could not be shown. */
  gaps: string[];
}

/** `30s`, `5m`, `1h`: a positive whole step in milliseconds; null otherwise. */
export function parseStep(value: string): number | null {
  const match = /^([1-9][0-9]{0,5})(s|m|h)$/.exec(value);
  const ms = match ? Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'] : NaN;
  return ms >= 60_000 ? ms : null;
}

/** `phm map replay` for people: one line per frame, then the gaps. */
export function formatMapReplayText(replay: MapReplay): string {
  const n = (rows: readonly unknown[] | null) => rows === null ? 'unknown' : String(rows.length);
  const lines = replay.frames.map(frame => `  ${frame.at.slice(11, 16)}Z  ${frame.state === 'unknown' ? 'history unknown'
    : `running ${n(frame.running)} · launched ${n(frame.launched)} · PRs opened ${n(frame.prsOpened)} · merged ${n(frame.merged)} · message lines ${n(frame.messages)}`}`);
  const known = replay.frames.filter(frame => frame.state !== 'unknown').length;
  return [`Fleet replay ${replay.since.slice(0, 16).replace('T', ' ')} to ${replay.until.slice(0, 16).replace('T', ' ')} UTC, every ${replay.stepSeconds / 60} min: ${known} of ${replay.frames.length} frames known.`,
    ...lines, ...replay.gaps].join('\n');
}

/**
 * The live map as it looked in one frame: the same leader, lanes, computers and pools
 * (their numbers are today's, not replayed), the frame's running jobs, and the frame's message lines.
 * A frame whose history is unknown keeps no jobs or messages and says so in `gaps`.
 */
export function replayMap(live: FleetLiveMap, frame: MapReplayFrame, stepSeconds: number): FleetLiveMap {
  const at = Date.parse(frame.at);
  const nodes: LiveMapNode[] = live.nodes.filter(node => node.kind !== 'job');
  const ids = new Set(nodes.map(node => node.id));
  const edges: LiveMapEdge[] = live.edges.filter(edge => edge.kind !== 'messaged-in-last-15-min' && ids.has(edge.from) && ids.has(edge.to));
  for (const row of frame.running ?? []) {
    const id = `job:${row.job}`;
    nodes.push({ id, kind: 'job', level: LIVE_MAP_LEVEL.job, label: row.job, provider: 'unknown', status: 'running',
      detail: `${row.repo ?? 'repo unknown'} · running then`, live: null, lane: row.lane, repo: row.repo, state: 'running' });
    ids.add(id);
    if (row.lane && ids.has(`lane:${row.lane}`)) edges.push({ id: `reports-to:${id}->lane:${row.lane}`, kind: 'reports-to', from: id, to: `lane:${row.lane}`, messages: null, lastMessageAt: null, pulse: false });
  }
  let mapped = 0;
  for (const line of frame.messages ?? []) {
    const from = line.from.node, to = line.to.node;
    if (!from || !to || !ids.has(from) || !ids.has(to)) continue;
    mapped += line.count;
    edges.push({ id: `messaged-in-last-15-min:${from}->${to}`, kind: 'messaged-in-last-15-min', from, to, messages: line.count, lastMessageAt: line.lastAt, pulse: false });
  }
  const total = frame.messages ? frame.messages.reduce((sum, line) => sum + line.count, 0) : null;
  const order = ['reports-to', 'runs-on', 'uses-resource', 'messaged-in-last-15-min'];
  nodes.sort((a, b) => a.level - b.level || (a.kind === 'job' ? (a.id < b.id ? -1 : 1) : 0));
  edges.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const count = (kind: LiveMapNode['kind']) => nodes.filter(node => node.kind === kind).length;
  const gaps = [...live.gaps.filter(gap => !/^(Running jobs|Messages|\d+ messages? could not)/.test(gap)),
    ...(frame.running === null ? ['Jobs unknown: nothing recorded for this time.'] : []),
    ...(frame.messages === null ? ['Messages unknown: nothing recorded for this time.'] : []),
    ...(total !== null && total > mapped ? [`${total - mapped} message${total - mapped === 1 ? '' : 's'} could not be matched to a node on this map.`] : [])];
  const generatedAt = new Date(at).toISOString();
  return { ...live, generatedAt, windowMinutes: Math.max(1, Math.round(stepSeconds / 60)), nodes, edges,
    counts: { lanes: count('lane'), jobs: count('job'), computers: count('computer'), resources: count('resource'), messages: total },
    sources: { ...live.sources, jobs: frame.running === null ? 'unknown' : 'available', messages: frame.messages === null ? 'unknown' : 'available' },
    unmappedMessages: total === null ? null : total - mapped, gaps,
    orgLayout: orgLayoutOf({ generatedAt, nodes, edges }) };
}
