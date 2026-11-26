import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { poolDirectory, readPoolConfig } from '../drive/nodes/pool-host.js';
import { callNodeSshReadOnly, validSshHost } from '../drive/nodes/ssh.js';
import { canonicalPath, privateDirectory } from '../universe/artifacts.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { scrubSecrets } from '../util/scrub.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { FLEET_ENGINES, type FleetLiveSnapshotV1 } from './fleet-types.js';
import type { FleetOrgMap } from './org-map.js';
import type { FleetOrgTree } from './org-tree.js';
import type { ResourceLedgerV1 } from './runs-resource-ledger.js';
import type { LeaderBoardRead } from './leader-board.js';
import type { FleetQueueV1 } from './runs-parked-queue.js';

const MAX_BYTES = 1024 * 1024;
const PEER_BYTES = 16 * 1024;
const MAX_PEERS = 32;
const MAX_LANES = 64;
const FRESH_MS = 120_000;
const SYNC_MS = 30_000;
const READ_SYNC_MS = 5_000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const safeId = (value: unknown): value is string => typeof value === 'string' && ID.test(value) && scrubSecrets(value) === value;

export interface FleetReplicaSource {
  machine: string | null;
  via: 'local' | 'leader-replica';
  asOf: string | null;
  ageSeconds: number | null;
  stale: boolean;
  reason: string | null;
}

interface PeerLane {
  lane: string;
  processes: number | null;
  claims: number | null;
  dispatch?: { running: number; target: number; queued: number; held: boolean };
}
interface MachineReport { machine: string; lanes: PeerLane[] }
interface PeerReport extends MachineReport { receivedAt: string }
interface FleetReplica {
  schema: 'fleet.replica.v1';
  role: 'leader';
  machine: string;
  generatedAt: string;
  map: FleetOrgMap & { tree: FleetOrgTree };
  usage: ResourceLedgerV1 | null;
  live: FleetLiveSnapshotV1;
  board: LeaderBoardRead;
  queue: FleetQueueV1;
  grant: { id: string; seq: number; host: string } | null;
  peers: PeerReport[];
}
interface Cache {
  leader: string;
  receivedAt: string | null;
  lastAttemptAt: string;
  lastError: string | null;
  replica: FleetReplica | null;
}
type ReadOnlySsh = (host: string, request: unknown, maxBuffer: number,
  options?: Parameters<typeof callNodeSshReadOnly>[3]) => unknown | Promise<unknown>;
const counter = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 65_536;

function dispatchCounts(value: unknown): PeerLane['dispatch'] {
  const row = value as NonNullable<PeerLane['dispatch']> | null;
  if (!row || !counter(row.running) || !counter(row.target) || !counter(row.queued) || typeof row.held !== 'boolean') return undefined;
  return { running: row.running, target: row.target, queued: row.queued, held: row.held };
}

function readJson(root: string, name: string, maxBytes: number): unknown {
  try {
    const read = readStableRegularFile(join(root, name), { anchorPath: root, maxFileBytes: maxBytes, remainingBytes: maxBytes });
    return read.ok ? JSON.parse(read.text) : null;
  } catch { return null; }
}
function writeJson(root: string, name: string, value: unknown, maxBytes: number): void {
  const text = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Fleet replica exceeds its size limit');
  writePrivateFileAtomically(join(root, `${name}.${randomUUID()}.tmp`), join(root, name), text,
    { anchorPath: root, label: 'Fleet replica evidence' });
}
function peerDirectory(): string {
  const root = poolDirectory();
  return privateDirectory(join(root, 'peers'));
}
export function fleetMachine(): string {
  const name = hostname().replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 100);
  return name || 'localhost';
}
export function localFleetSource(asOf: string | null, now = Date.now()): FleetReplicaSource {
  return { machine: fleetMachine(), via: 'local', asOf, ageSeconds: asOf ? Math.max(0, Math.floor((now - Date.parse(asOf)) / 1000)) : null,
    stale: false, reason: null };
}
function validStamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function parseMachineReport(value: unknown): MachineReport {
  const input = value as MachineReport;
  if (!input || !safeId(input.machine) ||
      !Array.isArray(input.lanes) || input.lanes.length > MAX_LANES) throw new Error('Invalid fleet machine report');
  const seen = new Set<string>();
  const lanes = input.lanes.map(row => {
    if (!row || !safeId(row.lane) || seen.has(row.lane) ||
        (row.processes !== null && !counter(row.processes)) || (row.claims !== null && !counter(row.claims))) throw new Error('Invalid fleet machine lane');
    seen.add(row.lane);
    const dispatch = dispatchCounts(row.dispatch);
    return { lane: row.lane, processes: row.processes, claims: row.claims, ...(dispatch ? { dispatch } : {}) };
  });
  return { machine: input.machine, lanes };
}

const LOOP = /(?:^|[\s/])(rloop\.sh|arloop\.sh|loop2\.sh|(?:ashlr-)?(?:muse-|node-)runner)(?=\s|$)(.*)$/;
const LANE_FLAG = /(?:^|\s)--lane(?:=|\s+)([a-zA-Z0-9][a-zA-Z0-9_.-]{0,99})(?=\s|$)/;

async function readProcesses(signal?: AbortSignal): Promise<string | null> {
  return new Promise(resolve => execFile('ps', ['-ax', '-o', 'args='], { timeout: 3_000, maxBuffer: MAX_BYTES, signal },
    (error, stdout) => resolve(error ? null : stdout)));
}
export function machineReport(machine: string, processes: string | null, claims: readonly string[], localLanes?: Record<string, unknown>): MachineReport {
  const lanes = new Map<string, PeerLane>();
  const add = (lane: string, field: 'processes' | 'claims') => {
    if (!safeId(lane) || (!lanes.has(lane) && lanes.size >= MAX_LANES)) return;
    const current = lanes.get(lane) ?? { lane, processes: null, claims: null };
    current[field] = Math.min(65_536, (current[field] ?? 0) + 1);
    lanes.set(lane, current);
  };
  for (const line of processes?.split('\n') ?? []) {
    const loop = LOOP.exec(line);
    if (loop?.[1]) add(LANE_FLAG.exec(loop[2] ?? '')?.[1] ?? loop[1].replace(/\.sh$/, ''), 'processes');
  }
  for (const lane of claims) add(lane, 'claims');
  for (const [lane, row] of Object.entries(localLanes ?? {})) {
    if (!safeId(lane) || (!lanes.has(lane) && lanes.size >= MAX_LANES)) continue;
    const dispatch = dispatchCounts(row);
    if (dispatch) lanes.set(lane, { ...(lanes.get(lane) ?? { lane, processes: null, claims: null }), dispatch });
  }
  return { machine, lanes: [...lanes.values()] };
}

function localDispatchLanes(now: number): Record<string, unknown> | undefined {
  const runsDir = process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const status = readJson(join(runsDir, 'queue'), 'status.json', MAX_BYTES) as { last_tick?: unknown; lanes?: Record<string, unknown> } | null;
  if (!validStamp(status?.last_tick) || now - Date.parse(status.last_tick) > FRESH_MS) return undefined;
  return status.lanes;
}

function readPeers(now: number): PeerReport[] {
  const root = join(ashlrHome(), 'node-pool', 'peers');
  try {
    return readdirSync(root).filter(name => name.endsWith('.json')).slice(0, MAX_PEERS * 2).flatMap(name => {
      const value = readJson(root, name, PEER_BYTES) as PeerReport | null;
      if (!value || !validStamp(value.receivedAt) || now - Date.parse(value.receivedAt) > FRESH_MS) return [];
      try { return [{ ...parseMachineReport(value), receivedAt: value.receivedAt }]; } catch { return []; }
    }).sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, MAX_PEERS);
  } catch { return []; }
}

export function fleetPeerReports(now = Date.now()): PeerReport[] {
  return readPeers(now).filter(peer => peer.machine !== fleetMachine());
}

function parseReplica(value: unknown): FleetReplica {
  const replica = value as FleetReplica;
  if (!replica || replica.schema !== 'fleet.replica.v1' || replica.role !== 'leader' ||
      typeof replica.machine !== 'string' || !ID.test(replica.machine) || !validStamp(replica.generatedAt) ||
      replica.map?.schema !== 'fleet.map.v2' || replica.map.tree?.schema !== 'fleet.org.v1' ||
      !Array.isArray(replica.map.tree.lanes) || replica.live?.v !== 1 || !Array.isArray(replica.live.lanes) ||
      !Array.isArray(replica.peers) || replica.queue?.v !== 1 || !Array.isArray(replica.queue.skips) || !replica.board ||
      (replica.grant !== null &&
        (!replica.grant || typeof replica.grant.id !== 'string' || !Number.isSafeInteger(replica.grant.seq) || replica.grant.host !== replica.machine))) {
    throw new Error('Invalid fleet replica');
  }
  return replica;
}

/** The existing SSH account authenticates the exchange; the sender's report is observational, not admission evidence. */
export async function serveFleetReplica(envelope: { report?: unknown }): Promise<FleetReplica> {
  const config = readPoolConfig();
  const { readLeaderBoard } = await import('./leader-board.js');
  const board = await readLeaderBoard();
  if ((config && config.role !== 'primary') || configuredFleetLeader() ||
      (!config && !board.board)) throw new Error('Fleet leader data unavailable');
  const report = parseMachineReport(envelope.report);
  const now = Date.now(), generatedAt = new Date(now).toISOString(), machine = fleetMachine();
  if (report.machine !== machine) {
    const root = peerDirectory();
    const existing = readdirSync(root).filter(name => name.endsWith('.json'));
    const name = `${report.machine.toLowerCase()}.json`;
    if (existing.includes(name) || existing.length < MAX_PEERS ||
        (readPeers(now).length < MAX_PEERS && existing.length < MAX_PEERS * 2)) {
      writeJson(root, name, { ...report, receivedAt: generatedAt }, PEER_BYTES);
    }
  }
  const [{ buildFleetLiveSnapshot }, { readFleetOrgSources }, { displayStandingPolicy }, { readFleetQueue }, { readStuckQueue }] = await Promise.all([
    import('../verse/fleet-live-api.js'), import('../verse/fleet-org-map-api.js'), import('../verse/display-standing-policy.js'),
    import('./runs-parked-queue.js'), import('../queue/stuck.js'),
  ]);
  const [{ snapshot: live }, queue, stuck] = await Promise.all([
    buildFleetLiveSnapshot(), readFleetQueue({ limit: 200 }), readStuckQueue().catch(() => null),
  ]);
  const { map, usage } = await readFleetOrgSources(60, { live: async () => ({ snapshot: live }) });
  const policy = displayStandingPolicy();
  const replica = parseReplica(sanitizePublicJson({ schema: 'fleet.replica.v1', role: 'leader', machine, generatedAt,
    map, usage, live, board, queue: { ...queue, stuck },
    grant: policy ? { id: policy.grantId, seq: policy.grantSeq, host: machine } : null, peers: fleetPeerReports() }));
  if (Buffer.byteLength(JSON.stringify(replica)) + 1 > MAX_BYTES) throw new Error('Fleet replica exceeds its size limit');
  return replica;
}

export function configuredFleetLeader(): string | null {
  const configured = readJson(ashlrHome(), 'fleet-leader.json', 4096) as { leader?: unknown } | null;
  if (validSshHost(configured?.leader)) return configured.leader;
  try {
    const config = readPoolConfig();
    return config && config.role !== 'primary' ? config.primary : null;
  } catch { return null; }
}
function readCache(leader: string): Cache | null {
  const value = readJson(join(ashlrHome(), 'node-pool'), 'leader-replica.json', MAX_BYTES + 4096) as Cache | null;
  return value?.leader === leader && validStamp(value.lastAttemptAt) ? value : null;
}
export function readFleetReplica(now = Date.now()): { source: FleetReplicaSource; replica: FleetReplica | null } | null {
  const leader = configuredFleetLeader();
  if (!leader) return null;
  const cache = readCache(leader);
  let replica: FleetReplica | null = null;
  try { replica = parseReplica(cache?.replica); } catch { /* no valid observation */ }
  const asOf = replica?.generatedAt ?? null;
  const age = asOf && validStamp(cache?.receivedAt)
    ? Math.max(0, now - Date.parse(asOf), now - Date.parse(cache.receivedAt)) : null;
  const stale = age === null || age > FRESH_MS;
  return { source: {
    machine: replica?.machine ?? leader, via: 'leader-replica', asOf,
    ageSeconds: age === null ? null : Math.floor(age / 1000), stale,
    reason: stale ? `leader unreachable since ${cache?.receivedAt ?? 'never reached'}` : null,
  }, replica: stale ? null : replica };
}
export function fleetReplicaStatus(now = Date.now()) {
  const leader = configuredFleetLeader();
  const cache = leader ? readCache(leader) : null;
  return { leader, source: readFleetReplica(now)?.source ?? null, receivedAt: cache?.receivedAt ?? null,
    lastAttemptAt: cache?.lastAttemptAt ?? null, lastError: cache?.lastError ?? null };
}

export function readFleetLiveReplica(now = Date.now()): FleetLiveSnapshotV1 | null {
  const observation = readFleetReplica(now);
  if (!observation) return null;
  const { source, replica } = observation;
  if (replica) {
    const grant = replica.grant;
    return { ...replica.live, source, lanes: replica.live.lanes.map(lane => ({ ...lane, machine: replica.machine,
      capReason: grant ? `Governed by leader grant #${grant.seq} on ${grant.host}${lane.capReason ? `. ${lane.capReason}` : ''}` : lane.capReason,
    })) };
  }
  return {
    v: 1, generatedAt: source.asOf ?? new Date(now).toISOString(), source, state: null, stateReason: source.reason,
    lastActivityAt: null, darkSince: null, blockedHolds: null, merged24h: null,
    summary: { building: null, queued: null, parked: null, waitingVerify: null, mergedToday: null,
      revertsToday: null, merged7d: null, postMergeGreenPct7d: null, cycleTimeP50Ms7d: null },
    lanes: FLEET_ENGINES.map(lane => ({ lane, slots: null, busy: null, capReason: source.reason })),
    runs: [], funnel: null, repos: [], mirrors: null,
  };
}

export function stampLocalFleetSnapshot(snapshot: FleetLiveSnapshotV1, now = Date.now()): FleetLiveSnapshotV1 {
  const source = localFleetSource(snapshot.generatedAt, now);
  return { ...snapshot, source, lanes: snapshot.lanes.map(lane => ({ ...lane, machine: source.machine ?? undefined })) };
}

export async function refreshFleetReplicaOnRead(): Promise<void> {
  try { await syncFleetReplica({ timeoutMs: READ_SYNC_MS }); } catch { /* keep the last readable observation */ }
}

export async function syncFleetReplica(options: { leader?: string; claims?: readonly string[]; ssh?: ReadOnlySsh; force?: boolean; timeoutMs?: number } = {}) {
  if (options.leader !== undefined) {
    if (!validSshHost(options.leader)) throw new Error('Use an explicit SSH config alias for --leader');
    const root = privateDirectory(canonicalPath(ashlrHome()));
    writeJson(root, 'fleet-leader.json', { leader: options.leader }, 4096);
  }
  const leader = configuredFleetLeader();
  if (!leader) return fleetReplicaStatus();
  const cache = readCache(leader);
  const now = Date.now();
  if (!options.force && cache && now - Date.parse(cache.lastAttemptAt) < SYNC_MS) return fleetReplicaStatus();
  const root = poolDirectory();
  const next: Cache = { leader, lastAttemptAt: new Date(now).toISOString(), lastError: null,
    receivedAt: cache?.receivedAt ?? null, replica: cache?.replica ?? null };
  // Persist the attempt before SSH so short-lived worker invocations share the cadence.
  writeJson(root, 'leader-replica.json', next, MAX_BYTES + 4096);
  const controller = new AbortController();
  const pull = async () => {
    const processes = await readProcesses(controller.signal);
    controller.signal.throwIfAborted();
    const report = machineReport(fleetMachine(), processes, options.claims ?? [], localDispatchLanes(now));
    return (options.ssh ?? callNodeSshReadOnly)(leader, { kind: 'replica', report }, MAX_BYTES,
      { timeoutMs: options.timeoutMs, signal: controller.signal });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutMs = options.timeoutMs;
    const response = timeoutMs === undefined ? await pull() : await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Fleet replica deadline exceeded');
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
      pull(),
    ]);
    next.replica = parseReplica(sanitizePublicJson(response));
    next.receivedAt = new Date().toISOString();
  } catch {
    next.lastError = 'Fleet leader snapshot unavailable over SSH';
  } finally {
    clearTimeout(timer);
  }
  writeJson(root, 'leader-replica.json', next, MAX_BYTES + 4096);
  return fleetReplicaStatus();
}
