import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { arch, cpus, hostname, platform, totalmem } from 'node:os';
import { delimiter, join } from 'node:path';
import { ashlrHome } from '../../cloud/store.js';
import { DriveNodes, LocalNodesStore, type NodeMeta, type NodeSession } from './index.js';
import { validId } from './state.js';

/** Heartbeat well inside the 30 s node lease. */
export const HEARTBEAT_MS = 10_000;
const TOOLS = ['claude', 'codex', 'docker', 'gh', 'git', 'node', 'npm'] as const;

/** A failure that tells the operator how to fix it. */
export class NodeJoinError extends Error {
  constructor(message: string, readonly fix: string) { super(message); }
}

export interface JoinDeps {
  dir?: string;
  now?: () => number;
  /** Returns the gh login of the machine's own `gh` session, or null. Never a token. */
  ghLogin?: () => string | null;
  caps?: () => Record<string, unknown>;
  startHeartbeat?: () => void;
  host?: () => string;
}

export interface JoinOptions { name?: string; owner?: string }

/** Own `gh` login only: the token never leaves gh, nothing secret is read or stored. */
export function ghLoginFromCli(): string | null {
  const res = spawnSync('gh', ['api', 'user', '--jq', '.login'], {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
  const login = res.status === 0 ? String(res.stdout).trim() : '';
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ? login : null;
}

/** Deterministic capability advert: sorted tool list, whole-GiB memory. */
export function detectCaps(): Record<string, unknown> {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  const exts = platform() === 'win32' ? ['', '.exe', '.cmd'] : [''];
  const tools = TOOLS.filter(t => dirs.some(d => exts.some(e => existsSync(join(d, t + e))))).slice().sort();
  return { arch: arch(), cpus: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30),
    node: process.versions.node, os: platform(), tools };
}

function parseOwner(raw: string | undefined, ghUser: string): NodeMeta['owner'] {
  if (raw === undefined) return { kind: 'person', id: ghUser };
  const [kind, ...rest] = raw.split(':');
  const id = rest.join(':');
  if (!['person', 'team', 'org'].includes(kind ?? '') || !validId(id)) {
    throw new NodeJoinError(`Invalid --owner "${raw}".`, 'Use --owner person:<id>, team:<id> or org:<id>, or omit it to own the node as your gh user.');
  }
  return { kind: kind as NodeMeta['owner']['kind'], id };
}

function paths(dir: string) { return { dir, session: join(dir, 'session.json') }; }

function readSession(file: string): NodeSession | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<NodeSession>;
    return validId(v.nodeId) && Number.isSafeInteger(v.session) ? { nodeId: v.nodeId, session: v.session! } : null;
  } catch { return null; }
}

function open(deps: JoinDeps) {
  const dir = deps.dir ?? join(ashlrHome(), 'nodes');
  return { ...paths(dir), nodes: new DriveNodes(new LocalNodesStore(dir), { now: deps.now }) };
}

export interface NodeStatus {
  schemaVersion: 1;
  state: 'live' | 'expired' | 'not-joined';
  nodeId: string | null;
  owner: NodeMeta['owner'] | null;
  ghUser: string | null;
  caps: Record<string, unknown> | null;
  leader: string | null;
  peers: { nodeId: string; live: boolean; owner: NodeMeta['owner'] | null }[];
  fix: string | null;
}

const NOT_JOINED: NodeStatus = { schemaVersion: 1, state: 'not-joined', nodeId: null, owner: null, ghUser: null,
  caps: null, leader: null, peers: [], fix: 'Run `phm node join`.' };

export function nodeStatus(deps: JoinDeps = {}): NodeStatus {
  const dir = deps.dir ?? join(ashlrHome(), 'nodes');
  if (!existsSync(join(dir, 'nodes.json'))) return NOT_JOINED;
  const { nodes, session } = open(deps);
  const mine = readSession(session);
  const snap = nodes.snapshot();
  const now = deps.now?.() ?? Date.now();
  const live = (n: { expiresAt: number }) => n.expiresAt > now;
  const record = mine && snap.nodes.find(n => n.nodeId === mine.nodeId && n.session === mine.session);
  const leader = snap.leader && live(snap.leader) ? snap.leader.nodeId : null;
  const peers = snap.nodes.map(n => ({ nodeId: n.nodeId, live: live(n), owner: n.meta?.owner ?? null }))
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
  if (!record) return { ...NOT_JOINED, leader, peers };
  const ok = live(record);
  return { schemaVersion: 1, state: ok ? 'live' : 'expired', nodeId: record.nodeId, owner: record.meta?.owner ?? null,
    ghUser: record.meta?.ghUser ?? null, caps: record.meta?.caps ?? null, leader, peers,
    fix: ok ? null : 'The heartbeat stopped (reboot or crash). Run `phm node join` to rejoin.' };
}

/** One command: reuse the machine's gh login, register with caps + owner, start the heartbeat. Idempotent. */
export function nodeJoin(opts: JoinOptions = {}, deps: JoinDeps = {}): NodeStatus & { action: 'joined' | 'already-joined' } {
  if (nodeStatus(deps).state === 'live') return { ...nodeStatus(deps), action: 'already-joined' };
  const ghUser = (deps.ghLogin ?? ghLoginFromCli)();
  if (!ghUser) {
    throw new NodeJoinError('No working GitHub login on this machine.', 'Run `gh auth login` (install gh from https://cli.github.com first if needed), then `phm node join`.');
  }
  const owner = parseOwner(opts.owner, ghUser);
  const nodeId = opts.name ?? (deps.host ?? hostname)().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100);
  if (!validId(nodeId)) throw new NodeJoinError(`"${nodeId}" is not a valid node name.`, 'Pass --name <letters-digits-dashes>.');
  const { dir, session, nodes } = open(deps);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const joined = nodes.join(nodeId, { owner, ghUser, caps: (deps.caps ?? detectCaps)() });
  if (!joined) {
    throw new NodeJoinError(`Node "${nodeId}" is already live in this registry from another session.`,
      'Run `phm node leave` on that session, or join under a different name with --name.');
  }
  const tmp = `${session}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(joined) + '\n', { mode: 0o600 });
  renameSync(tmp, session);
  nodes.heartbeat(joined);
  (deps.startHeartbeat ?? spawnHeartbeat)();
  return { ...nodeStatus(deps), action: 'joined' };
}

/** Clean and idempotent: revokes the lease at once (the heartbeat process then exits by itself). */
export function nodeLeave(deps: JoinDeps = {}): { schemaVersion: 1; action: 'left' | 'not-joined'; nodeId: string | null } {
  const dir = deps.dir ?? join(ashlrHome(), 'nodes');
  const file = paths(dir).session;
  const mine = readSession(file);
  if (!mine) return { schemaVersion: 1, action: 'not-joined', nodeId: null };
  if (existsSync(join(dir, 'nodes.json'))) open(deps).nodes.leave(mine);
  try { unlinkSync(file); } catch { /* already gone */ }
  return { schemaVersion: 1, action: 'left', nodeId: mine.nodeId };
}

/** Heartbeat loop for the detached process; stops when the session is revoked, replaced or expired. */
export async function runHeartbeat(deps: JoinDeps & { sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const { nodes, session } = open(deps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const first = readSession(session);
  for (let mine = first; mine; mine = readSession(session)) {
    if (mine.session !== first!.session || !nodes.heartbeat(mine)) return;
    await sleep(HEARTBEAT_MS);
  }
}

function spawnHeartbeat(): void {
  const entry = process.argv[1];
  if (!entry) throw new NodeJoinError('Cannot locate the phm entry point to start the heartbeat.', 'Run `phm node heartbeat-run` in the background yourself.');
  spawn(process.execPath, [...process.execArgv, entry, 'node', 'heartbeat-run'], { detached: true, stdio: 'ignore' }).unref();
}
