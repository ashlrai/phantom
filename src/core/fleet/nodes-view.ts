/**
 * core/fleet/nodes-view.ts: one read-only row per known computer. Backs
 * `phm nodes [--json] [--can-take <lane>]` and the desktop Computers panel.
 *
 * It joins evidence that already exists and adds no registry of its own:
 * the sanitized tailnet reader (tailnet-peers.ts) says which computers are
 * reachable, and the node registry (drive/nodes, `NodesState`) says where a
 * Phantom node has a live heartbeat, what lanes it advertises and which jobs
 * it holds. Nothing is written, no SSH or network call is made beyond the
 * shared `tailscale status --json` read, and nothing throws. A fact that
 * cannot be confirmed is "unknown" plus a `reasons[]` entry.
 */
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { sampleHostStats } from '../drive/nodes/capacity.js';
import { joinHintCommand } from '../drive/nodes/commands.js';
import { readPoolConfig } from '../drive/nodes/pool-host.js';
import { isHostStats, parseState, type HostStats, type NodeRecord, type NodesState } from '../drive/nodes/state.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { aliasMatches } from './pool-reach.js';
import { sanitizeIdentityText, UNKNOWN } from './runtime-identity.js';
import { defaultTailnetPeersDeps, readTailnetPeers, type TailnetPeers, type TailnetPeersDeps } from './tailnet-peers.js';

type Unknown = typeof UNKNOWN;
/** `local`/`pool-witness` are the authority on this disk; `pool-mirror` is the primary's evidence copy;
 * `none` means no pool exists here; `elsewhere` means the list lives on another computer. */
export type NodesRegistrySource = 'local' | 'pool-witness' | 'pool-mirror' | 'none' | 'elsewhere';
/** This computer's node-pool enrollment details: the owner scope and SSH aliases a new computer joins through. */
export interface NodesPoolJoin { owner: string; primary: string; backup: string }
export interface NodesRegistry {
  source: NodesRegistrySource;
  state: NodesState | null;
  selfNode: string | null;
  /** Pool enrollment details when this computer belongs to a node pool; null for the standalone registry. */
  pool: NodesPoolJoin | null;
}
export type NodeStateCode = 'ready' | 'busy' | 'held' | 'offline' | 'not-running' | 'unknown';

export interface NodeRow {
  name: string;
  isSelf: boolean;
  reachable: boolean | Unknown;
  lastSeen: string | Unknown;
  /** Seconds since the newest Phantom heartbeat from that computer; "unknown" when none is on record. */
  heartbeatAgeSeconds: number | Unknown;
  /** A Phantom node on that computer has a live heartbeat in the registry. */
  phantom: 'running' | 'not-running' | Unknown;
  freeMemoryBytes: number | Unknown;
  /** Free memory as a whole percent of the total. */
  freeMemoryPercent: number | Unknown;
  /** One-minute load average. */
  load: number | Unknown;
  cpuHeadroomPercent: number | Unknown;
  lanes: string[] | Unknown;
  /** IDs of jobs that computer holds a running claim on. */
  jobsRunning: string[] | Unknown;
  freeSlots: number | Unknown;
  stateCode: NodeStateCode;
  /** The same state in plain words. */
  state: string;
  /** True for this computer and any computer registered in the node list. False: seen on Tailscale only ("not joined"). */
  joined: boolean;
  /** The command that joins this computer to this computer's node pool; run it on that computer.
   * Null once joined, and when this computer has no node pool for it to join. */
  joinCommand: string | null;
}
/** The enrollment command a new computer runs to join this pool; null when no pool is configured here. */
export function poolJoinCommand(pool: NodesPoolJoin | null): string | null {
  return pool === null ? null : `phm node join --owner ${pool.owner} --primary ${pool.primary} --backup ${pool.backup}`;
}
export const NODES_SCHEMA = 'phantom.nodes-view.v1';
/** A Phantom heartbeat older than this means the computer is offline. */
export const HEARTBEAT_OFFLINE_MS = 5 * 60_000;
export interface NodesView {
  schema: typeof NODES_SCHEMA;
  schemaVersion: 1;
  asOf: string;
  self: string;
  registry: NodesRegistrySource | Unknown;
  nodes: NodeRow[];
  reasons: string[];
}
export interface NodesViewDeps {
  peers: TailnetPeersDeps;
  /** Read-only registry snapshot; may throw. */
  readRegistry(): NodesRegistry;
  /** This computer's own numeric sample; may throw. */
  localStats(): HostStats;
  hostName(): string;
  /** IANA zone for the clock in `state`; defaults to the local zone. */
  timeZone?: string;
}

/** A mirror older than this cannot prove a node stopped; its silence is unknown. */
export const MIRROR_FRESH_MS = 120_000;
const HELD_WORDS: Record<string, string> = {
  'memory-pressure': 'low memory', 'memory-unmeasured': 'memory not measured',
  'disk-pressure': 'low disk space', 'disk-unmeasured': 'disk not measured',
};
const MOBILE_OS = /^(?:ios|android|tvos)$/i;

/** A millisecond time as ISO text; "unknown" outside the representable range. */
const iso = (ms: number): string => (Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : UNKNOWN);

/** "10:42" today, "Nov 14 10:42" on another day; null when either time is unreadable. */
function clock(iso: string, now: Date, timeZone?: string): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime()) || !Number.isFinite(now.getTime())) return null;
  const part = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(date);
  const day = (date: Date) => part(date, { month: 'short', day: 'numeric' });
  const time = part(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return day(at) === day(now) ? time : `${day(at)} ${time}`;
}

function headroom(stats: HostStats | undefined): Pick<NodeRow, 'freeMemoryBytes' | 'freeMemoryPercent' | 'load' | 'cpuHeadroomPercent'> {
  if (!stats || !isHostStats(stats)) return { freeMemoryBytes: UNKNOWN, freeMemoryPercent: UNKNOWN, load: UNKNOWN, cpuHeadroomPercent: UNKNOWN };
  const load = stats.load[0];
  return {
    freeMemoryBytes: Math.round(stats.ramTotal - stats.ramUsed),
    freeMemoryPercent: stats.ramTotal > 0 ? Math.round((stats.ramTotal - stats.ramUsed) / stats.ramTotal * 100) : UNKNOWN,
    load: load === null || load === undefined ? UNKNOWN : Math.round(load * 100) / 100,
    cpuHeadroomPercent: load === null || load === undefined || stats.cores.length === 0 ? UNKNOWN
      : Math.round(Math.max(0, Math.min(1, 1 - load / stats.cores.length)) * 100),
  };
}

interface Machine { name: string; isSelf: boolean; reachable: boolean | Unknown; lastSeen: string | Unknown; records: NodeRecord[] }

/** The standalone rejoin for this computer's own expired session, from its newest record.
 * With no record it is a first join, which needs no --node: join defaults the id to the hostname.
 * A record restores the last advertised profile — owners, caps and slots — through the same
 * hint a session-expired fix prints, so the suggested rejoin never silently downgrades the node. */
function standaloneRejoin(records: NodeRecord[]): string {
  const rec = [...records].sort((a, b) => b.heartbeatAt - a.heartbeatAt)[0];
  return rec ? joinHintCommand(rec.nodeId, rec) : 'phm node join --owner <scope>';
}

/** Pure join of the tailnet read, the registry snapshot and this computer's sample. */
export function buildNodesView(
  peers: TailnetPeers, registry: NodesRegistry | null, local: { name: string; stats: HostStats | null },
  now: Date, options: { home?: string; timeZone?: string } = {},
): NodesView {
  const nowMs = now.getTime(), asOf = Number.isFinite(nowMs) ? now.toISOString() : UNKNOWN;
  const safe = (text: string) => sanitizeIdentityText(text, options.home ?? '').slice(0, 120);
  const reasons = [...peers.reasons];
  const state = registry?.state ?? null;
  const enroll = poolJoinCommand(registry?.pool ?? null);
  if (!registry) reasons.push('node list unreadable; Phantom status unknown');
  else if (registry.pool === null) reasons.push('no node pool on this computer: other computers cannot join its list (docs/NODES.md)');
  else if (registry.source === 'elsewhere') reasons.push('the node list lives on the pool primary: run `phm nodes` there');
  const mirrorStale = registry?.source === 'pool-mirror' && state !== null && nowMs - state.observedAt > MIRROR_FRESH_MS;
  if (mirrorStale) reasons.push(`pool mirror last updated ${clock(iso(state.observedAt), now, options.timeZone) ?? UNKNOWN}; newer node state unknown`);

  const selfName = peers.self !== UNKNOWN ? peers.self : safe(local.name.split('.')[0] ?? '') || UNKNOWN;
  const machines: Machine[] = [{ name: selfName, isSelf: true, reachable: true, lastSeen: asOf, records: [] }];
  for (const peer of peers.peers) {
    if (peer.name === UNKNOWN || MOBILE_OS.test(peer.os) || machines.some(m => m.name.toLowerCase() === peer.name.toLowerCase())) continue;
    machines.push({ name: peer.name, isSelf: false, reachable: peer.online, lastSeen: peer.online === true ? asOf : peer.lastSeen, records: [] });
  }
  // The standalone registry (~/.ashlr/nodes) is single-host authority: every
  // record in it is a node session on this computer, whatever id it joined
  // under. Those records attach to this machine before any tailnet name is
  // consulted, so a local id matching a peer's name cannot mark that peer
  // as running Phantom — and this computer stops claiming it never joined.
  const localRegistry = registry?.source === 'local';
  for (const record of state?.nodes ?? []) {
    const ids = [record.nodeId, record.capacity?.hostId].filter((id): id is string => typeof id === 'string');
    let machine = localRegistry ? machines.find(m => m.isSelf)
      : machines.find(m => (m.isSelf && record.nodeId === registry?.selfNode) || ids.some(id => aliasMatches(id, m.name)));
    if (!machine) {
      // Registered but not on the tailnet read: the heartbeat is the only sighting.
      machine = { name: safe(record.nodeId), isSelf: false, reachable: UNKNOWN, lastSeen: iso(record.heartbeatAt), records: [] };
      machines.push(machine);
    }
    machine.records.push(record);
  }

  /** The command that brings this computer's Phantom back, or nothing when none exists here.
   * A pool member re-enrolls with bare `phm node join`; a computer new to the pool needs the
   * full enrollment command. The standalone registry is single-host, so only this computer
   * can rejoin it — and only with the node id and owner its expired session recorded. */
  const rejoinWords = (machine: Machine): string => {
    if (!registry) return '';
    const cmd = registry.pool !== null
      ? (machine.records.length ? 'phm node join' : enroll)
      : machine.isSelf ? standaloneRejoin(machine.records) : null;
    return cmd ? `: run \`${cmd}\` ${machine.isSelf ? 'here' : 'there'}` : '';
  };

  const nodes = machines.map((machine): NodeRow => {
    const live = machine.records.filter(record => !mirrorStale && record.expiresAt > nowMs);
    // Absence proves "not running" only where the list is authoritative and current.
    const silenceKnown = state !== null ? !mirrorStale : machine.isSelf && registry?.source === 'none';
    const phantom = live.length ? 'running' : silenceKnown ? 'not-running' : UNKNOWN;
    // A claim counts only while the session that took it can still act on it:
    // unexpired claim, unexpired record on this machine, same node and session.
    const jobs = state === null || mirrorStale ? UNKNOWN : state.jobs.filter(job => {
      const claim = job.claim;
      return job.state === 'running' && claim !== undefined && claim.expiresAt > nowMs &&
        live.some(record => record.nodeId === claim.nodeId && record.session === claim.session);
    }).map(job => job.id).sort();
    const slots = live.length && live.every(record => record.slots !== undefined) && jobs !== UNKNOWN
      ? Math.max(0, live.reduce((sum, record) => sum + (record.slots ?? 0), 0) - jobs.length) : UNKNOWN;
    const held = live.map(record => record.capacity?.held).find(Boolean);
    const newest = [...live].sort((a, b) => b.heartbeatAt - a.heartbeatAt)[0];
    const joined = machine.isSelf || machine.records.length > 0;
    const newestBeat = machine.records.reduce((max, record) => Math.max(max, record.heartbeatAt), Number.NEGATIVE_INFINITY);
    const heartbeatAgeSeconds = Number.isFinite(newestBeat) && Number.isFinite(nowMs) ? Math.max(0, Math.round((nowMs - newestBeat) / 1000)) : UNKNOWN;
    // A remote computer seen only through the registry, whose last heartbeat is over 5 minutes old, is offline.
    const silent = !machine.isSelf && machine.reachable === UNKNOWN && heartbeatAgeSeconds !== UNKNOWN && heartbeatAgeSeconds * 1000 > HEARTBEAT_OFFLINE_MS;
    let stateCode: NodeStateCode, words: string;
    if (machine.reachable === false || silent) {
      stateCode = 'offline';
      const since = machine.lastSeen === UNKNOWN ? null : clock(machine.lastSeen, now, options.timeZone);
      words = since === null ? 'offline' : `offline since ${since}`;
    } else if (phantom === 'running') {
      if (held || slots === 0 && jobs.length === 0) { stateCode = 'held'; words = `holding: ${HELD_WORDS[held ?? ''] ?? 'no job slots open'}`; }
      else if (slots === 0) { stateCode = 'busy'; words = `busy: ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} running, no free slots`; }
      else if (machine.reachable !== true || slots === UNKNOWN) {
        stateCode = UNKNOWN; words = `Phantom running; ${machine.reachable !== true ? 'reachability' : 'free slots'} unknown`;
      } else { stateCode = 'ready'; words = 'ready for work'; }
    } else if (phantom === 'not-running') {
      stateCode = machine.reachable === true ? 'not-running' : UNKNOWN;
      words = machine.reachable === true ? `reachable but Phantom not running${rejoinWords(machine)}` : 'not seen on the network; Phantom not running';
    } else {
      stateCode = UNKNOWN;
      words = machine.reachable === true ? 'reachable; Phantom status unknown' : 'unknown';
    }
    return {
      name: machine.name, isSelf: machine.isSelf, reachable: silent ? false : machine.reachable, lastSeen: machine.lastSeen, heartbeatAgeSeconds, phantom,
      ...headroom(machine.isSelf ? local.stats ?? undefined : newest?.hostStats),
      lanes: machine.records.length ? [...new Set((live.length ? live : machine.records).flatMap(record => record.caps ?? []))].sort() : UNKNOWN,
      jobsRunning: jobs, freeSlots: slots, stateCode, state: words,
      joined, joinCommand: joined ? null : enroll,
    };
  });
  nodes.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { schema: NODES_SCHEMA, schemaVersion: 1, asOf, self: selfName, registry: registry?.source ?? UNKNOWN, nodes, reasons };
}

/** Require confirmed reachability, free slots and a live advertisement for the lane. */
export function nodesThatCanTake(view: NodesView, lane: string): NodeRow[] {
  return view.nodes.filter(node => node.stateCode === 'ready' && node.reachable === true
    && typeof node.freeSlots === 'number' && node.freeSlots > 0 && node.lanes !== UNKNOWN && node.lanes.includes(lane));
}

export interface NodePlacement {
  lane: string;
  node: string | null;
  target: 'remote' | 'local' | 'none';
  reason: 'remote-ready' | 'local-only' | 'local-fallback' | 'no-ready-node';
  explanation: string;
}

/** Pure placement advice for a selected lane; reserves nothing and grants no execution authority. */
export function chooseNodeForLane(view: NodesView, lane: string, options: { localOnly?: boolean } = {}): NodePlacement {
  const ready = nodesThatCanTake(view, lane).sort((a, b) => Number(b.freeSlots) - Number(a.freeSlots)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const remote = options.localOnly ? undefined : ready.find(node => !node.isSelf);
  if (remote) return { lane, node: remote.name, target: 'remote', reason: 'remote-ready',
    explanation: 'Ready remote computer; most free slots first, then name.' };
  const local = ready.find(node => node.isSelf);
  if (!local) return { lane, node: null, target: 'none', reason: 'no-ready-node',
    explanation: options.localOnly ? 'This computer is not ready for this lane.' : 'No computer is ready for this lane.' };
  const localOnly = options.localOnly || view.nodes.every(node => node.isSelf);
  return { lane, node: local.name, target: 'local', reason: localOnly ? 'local-only' : 'local-fallback',
    explanation: localOnly ? 'Using this computer; placement is local only.' : 'Using this computer; no remote computer is ready for this lane.' };
}

/** Read every source through its seam and join; never throws. */
export function readNodesView(deps: NodesViewDeps): NodesView {
  const attempt = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
  const now = attempt(() => deps.peers.now()) ?? new Date(Number.NaN);
  const peers = attempt(() => readTailnetPeers(deps.peers))
    ?? { asOf: UNKNOWN, self: UNKNOWN, peers: [], reasons: ['tailscale unavailable or status unreadable'] };
  return buildNodesView(peers, attempt(() => deps.readRegistry()), { name: attempt(() => deps.hostName()) ?? '', stats: attempt(() => deps.localStats()) },
    now, { home: attempt(() => deps.peers.homeDir()) ?? '', timeZone: deps.timeZone });
}

/** The registry file this computer holds, read without a lock, a write or a mkdir. */
export function readNodesRegistry(): NodesRegistry {
  const config = readPoolConfig();
  const selfNode = config?.node ?? null;
  const pool = config === null ? null : { owner: config.owner, primary: config.primary, backup: config.backup };
  if (config?.role === 'worker') return { source: 'elsewhere', state: null, selfNode, pool };
  const [directory, file, source] = !config ? ['nodes', 'nodes.json', 'local'] as const
    : config.role === 'backup' ? ['node-pool', 'nodes.json', 'pool-witness'] as const
      : ['node-pool', 'primary-mirror.json', 'pool-mirror'] as const;
  const root = join(ashlrHome(), directory), path = join(root, file);
  if (!existsSync(path)) return { source: config ? 'elsewhere' : 'none', state: null, selfNode, pool };
  const limit = 16 * 1024 * 1024;
  const read = readStableRegularFile(path, { anchorPath: root, maxFileBytes: limit, remainingBytes: limit });
  if (!read.ok) throw new Error('Node list unreadable');
  return { source, state: parseState(JSON.parse(read.text)), selfNode, pool };
}

export function defaultNodesViewDeps(): NodesViewDeps {
  return { peers: defaultTailnetPeersDeps(), readRegistry: readNodesRegistry, localStats: sampleHostStats, hostName: hostname };
}
