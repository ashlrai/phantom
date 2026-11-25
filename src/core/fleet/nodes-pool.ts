/**
 * core/fleet/nodes-pool.ts: the joined Macs as one pool. Backs `phm nodes pool [--json]`,
 * GET /api/verse/fleet/nodes/pool and the Machines card on the desktop and phone Home.
 *
 * It only joins what `phm nodes` (the computers view), the plan's slot rule and the offload
 * setting already know; it measures, writes and launches nothing. A fact nobody measured is
 * "unknown", never zero: an unknown slot count is left out of the total and the total says so.
 * The offload setting lives on each Mac's own disk, so only this Mac's is known here.
 */
import { aliasMatches } from './pool-reach.js';
import { readOffloadEnabled } from './nodes-offload.js';
import { planNode } from './nodes-plan.js';
import { readNodesView, type NodeRow, type NodesRegistry, type NodesView, type NodesViewDeps } from './nodes-view.js';
import { UNKNOWN } from './runtime-identity.js';

type Unknown = typeof UNKNOWN;
export const NODES_POOL_SCHEMA = 'phantom.nodes-pool.v1';
export type PoolStatus = 'online' | 'offline' | 'unknown';
export type PoolOffload = 'on' | 'off' | 'unknown';

export interface PoolNode {
  name: string;
  isSelf: boolean;
  status: PoolStatus;
  /** Jobs this Mac could take now: 0 when offline or holding, "unknown" when not measured. */
  freeSlots: number | Unknown;
  /** IDs of the jobs it is running; "unknown" when the registry cannot say. */
  jobsRunning: string[] | Unknown;
  load: number | Unknown;
  freeMemoryBytes: number | Unknown;
  freeMemoryPercent: number | Unknown;
  freeDiskGb: number | Unknown;
  offload: PoolOffload;
  /** ISO time the Mac was last seen; "unknown" when never. */
  lastSeen: string | Unknown;
  /** The same state in plain words. */
  state: string;
}
export interface PoolTotal {
  macs: number;
  online: number;
  /** Free slots on online Macs, counting only the ones measured. */
  freeSlots: number;
  /** Online Macs whose free slots are not measured, so the total is at least this many. */
  slotsUnknown: number;
  jobsRunning: number;
  /** "2 Macs, 11 free slots" */
  line: string;
}
export interface NodesPool {
  schema: typeof NODES_POOL_SCHEMA;
  schemaVersion: 1;
  asOf: string;
  nodes: PoolNode[];
  total: PoolTotal;
  reasons: string[];
}
export interface NodesPoolDeps { view: NodesViewDeps; readOffload?: () => boolean }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const gb = (bytes: number) => Math.round(bytes / 1e8) / 10;

/** Pure. `disk` maps a Mac's name to its free disk in bytes where someone measured it. */
export function buildNodesPool(view: NodesView, extra: { disk?: ReadonlyMap<string, number | null>; selfOffload: boolean | null }): NodesPool {
  const nodes = view.nodes.map((row: NodeRow): PoolNode => {
    const status: PoolStatus = row.reachable === true ? 'online' : row.reachable === false || row.stateCode === 'offline' ? 'offline' : UNKNOWN;
    const disk = extra.disk?.get(row.name) ?? null;
    return {
      name: row.name, isSelf: row.isSelf, status,
      freeSlots: planNode(row).suggested_slots, jobsRunning: row.jobsRunning,
      load: row.load, freeMemoryBytes: row.freeMemoryBytes, freeMemoryPercent: row.freeMemoryPercent,
      freeDiskGb: disk === null ? UNKNOWN : gb(disk),
      offload: row.isSelf ? (extra.selfOffload === null ? UNKNOWN : extra.selfOffload ? 'on' : 'off') : UNKNOWN,
      lastSeen: row.lastSeen, state: row.state,
    };
  });
  // A Mac that is not online offers nothing; an online Mac with unmeasured slots is counted apart.
  const online = nodes.filter(n => n.status === 'online');
  const freeSlots = online.reduce((sum, n) => sum + (typeof n.freeSlots === 'number' ? n.freeSlots : 0), 0);
  const slotsUnknown = online.filter(n => n.freeSlots === UNKNOWN).length;
  const jobsRunning = nodes.reduce((sum, n) => sum + (n.jobsRunning === UNKNOWN ? 0 : n.jobsRunning.length), 0);
  const line = `${plural(nodes.length, 'Mac')}, ${plural(freeSlots, 'free slot')}${slotsUnknown ? ` (${slotsUnknown} not measured)` : ''}`;
  return { schema: NODES_POOL_SCHEMA, schemaVersion: 1, asOf: view.asOf, nodes,
    total: { macs: nodes.length, online: online.length, freeSlots, slotsUnknown, jobsRunning, line }, reasons: view.reasons };
}

/** Free disk per Mac from the registry's host stats (remote) and this Mac's own sample; never throws. */
function diskFreeByName(view: NodesView, registry: NodesRegistry | null, localDisk: number | null): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const row of view.nodes) {
    if (row.isSelf) { out.set(row.name, localDisk); continue; }
    if (row.reachable === false) continue;
    // The standalone registry is single-host: its records are this computer's
    // sessions, so a peer whose name matches a local node id must not inherit
    // this machine's disk measurement.
    const record = registry?.source === 'local' ? undefined
      : registry?.state?.nodes.filter(r => [r.nodeId, r.capacity?.hostId].some(id => typeof id === 'string' && aliasMatches(id, row.name)))
        .sort((a, b) => b.heartbeatAt - a.heartbeatAt)[0];
    out.set(row.name, record?.hostStats?.diskFree ?? null);
  }
  return out;
}

/** Read every source through its seam and join; never throws. */
export function readNodesPool(deps: NodesPoolDeps): NodesPool {
  const attempt = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
  const view = readNodesView(deps.view);
  const registry = attempt(() => deps.view.readRegistry());
  const localDisk = attempt(() => deps.view.localStats().diskFree) ?? null;
  return buildNodesPool(view, { disk: diskFreeByName(view, registry, localDisk), selfOffload: attempt(deps.readOffload ?? readOffloadEnabled) });
}

const MARK: Record<PoolStatus, string> = { online: '●', offline: '○', unknown: '?' };
const unknownOr = <T>(value: T | Unknown, show: (known: T) => string): string => (value === UNKNOWN ? 'unknown' : show(value as T));
const JOB_NAMES = 3;

/** "seen 3 min ago" from two ISO times; "seen time unknown" when either is unreadable. */
export function seenWords(lastSeen: string | Unknown, asOf: string | Unknown): string {
  const age = Date.parse(asOf) - Date.parse(lastSeen);
  if (lastSeen === UNKNOWN || !Number.isFinite(age)) return 'seen time unknown';
  const minutes = Math.round(Math.max(0, age) / 60_000);
  return minutes < 1 ? 'seen just now' : minutes < 60 ? `seen ${minutes} min ago` : minutes < 48 * 60 ? `seen ${Math.round(minutes / 60)} h ago` : `seen ${Math.round(minutes / 1440)} days ago`;
}
export function jobsWords(jobs: string[] | Unknown): string {
  if (jobs === UNKNOWN) return 'running unknown';
  if (!jobs.length) return 'running nothing';
  return `running ${jobs.slice(0, JOB_NAMES).join(', ')}${jobs.length > JOB_NAMES ? ` +${jobs.length - JOB_NAMES} more` : ''}`;
}

/** One Mac's facts as short plain phrases, in the order people read them. Shared by the CLI line and the Home card. */
export function poolParts(node: PoolNode, asOf: string | Unknown): string[] {
  return [
    node.freeSlots === UNKNOWN ? 'free slots unknown' : plural(node.freeSlots, 'free slot'),
    jobsWords(node.jobsRunning),
    `load ${unknownOr(node.load, String)}`,
    `memory free ${unknownOr(node.freeMemoryBytes, b => `${(b / 1024 ** 3).toFixed(1)} GB`)}`,
    `disk free ${unknownOr(node.freeDiskGb, g => `${g} GB`)}`,
    `offload ${node.offload}`,
    seenWords(node.lastSeen, asOf),
  ];
}

export function poolLine(node: PoolNode, asOf: string | Unknown): string {
  return [`${MARK[node.status]} ${node.name}${node.isSelf ? ' (this Mac)' : ''}: ${node.status}`, ...poolParts(node, asOf)].join(' | ');
}

export function poolText(pool: NodesPool): string {
  if (!pool.nodes.length) return ['No Macs known. Run `phm node join` on each Mac.', ...pool.reasons.map(r => `note: ${r}`)].join('\n');
  const self = pool.nodes.find(n => n.isSelf);
  const offload = self ? `Offload is ${self.offload === UNKNOWN ? 'unknown' : self.offload} on this Mac.` : '';
  return [`${pool.total.line}. ${offload}`.trim(), '', ...pool.nodes.map(n => poolLine(n, pool.asOf)), ...pool.reasons.map(r => `note: ${r}`)].join('\n');
}
