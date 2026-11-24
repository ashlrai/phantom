/**
 * core/fleet/nodes-doctor.ts: `phm nodes doctor`, a read-only readiness check
 * for each joined computer. It answers "what is this computer missing before it
 * can take jobs?": reachable, which lane CLIs are installed and signed in,
 * which ashlrai repo clones exist and free disk. Every gap is one plain fix line.
 *
 * It extends the nodes view (reachability, registry) and adds no registry.
 * Lane facts come from a `NodeProbe` adapter that may only run each CLI's own
 * `--version` / status command by exit code. Credential files are never read.
 * The shipped remote adapter is a stub: `phm node rpc` serves pool calls only,
 * so for a remote computer the doctor falls back to what that computer
 * advertised in its heartbeat and says "unknown" (with a reason) for the rest.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { binaryCandidates } from '../drive/nodes/provider-binary.js';
import { aliasMatches } from './pool-reach.js';
import { UNKNOWN } from './runtime-identity.js';
import { readNodesRegistry, readNodesView, type NodeRow, type NodesViewDeps } from './nodes-view.js';

export const NODES_DOCTOR_SCHEMA = 'phantom.nodes-doctor.v1';
/** Below this the node pool already holds jobs (see drive/nodes/capacity.ts). */
export const DOCTOR_MIN_DISK_GB = 20;
export const DOCTOR_LANES = ['claude', 'codex', 'devin', 'gemini', 'local-model'] as const;
export type DoctorLane = typeof DOCTOR_LANES[number];
type Unknown = typeof UNKNOWN;
export type LaneStatus = 'ready' | 'not-installed' | 'signed-out' | 'unknown';

/** What a probe saw. `signedIn: 'unknown'` means the CLI has no status command Phantom can run. */
export interface NodeProbeReply {
  lanes: Partial<Record<DoctorLane, { installed: boolean; signedIn: boolean | Unknown }>>;
  repos: string[];
  diskFreeBytes: number | null;
}
/** The node adapter. Resolve null when the computer cannot be probed; it must not throw secrets. */
export type NodeProbe = (node: string, isSelf: boolean) => Promise<NodeProbeReply | null>;

export interface LaneCheck { lane: DoctorLane; status: LaneStatus; reason?: string }
export interface DoctorNode {
  name: string;
  isSelf: boolean;
  reachable: boolean | Unknown;
  lanes: LaneCheck[];
  repos: string[] | Unknown;
  missingRepos: string[] | Unknown;
  diskFreeGb: number | Unknown;
  /** One plain fix line per known gap. */
  gaps: string[];
  /** Why a fact is unknown. */
  unknowns: string[];
  ready: boolean;
}
export interface NodesDoctor { schema: typeof NODES_DOCTOR_SCHEMA; schemaVersion: 1; asOf: string; nodes: DoctorNode[]; reasons: string[] }
export interface NodesDoctorDeps { view: NodesViewDeps; probe: NodeProbe }

const LOGIN: Partial<Record<DoctorLane, string>> = { claude: 'claude auth login', codex: 'codex login' };
const BINARY: Record<DoctorLane, string[]> = { claude: ['claude'], codex: ['codex'], devin: ['devin'], gemini: ['gemini'], 'local-model': ['ollama', 'omlx', 'llama-server'] };
const STATUS_ARGS: Partial<Record<DoctorLane, string[]>> = { claude: ['auth', 'status', '--json'], codex: ['login', 'status'] };
const REPO_ROOT = ['Projects', 'ashlrai'];

/** Real probe for this computer: exit codes only, absolute binaries, no shell, no output kept. */
export function localProbe(run: typeof spawnSync = spawnSync, home: string = homedir()): NodeProbeReply {
  const exits = (binary: string, args: string[]) => {
    const r = run(binary, args, { timeout: 5000, stdio: 'ignore', shell: false, env: { PATH: process.env['PATH'], HOME: home } });
    return !r.error && r.status === 0;
  };
  const lanes: NodeProbeReply['lanes'] = {};
  for (const lane of DOCTOR_LANES) {
    const binary = BINARY[lane].flatMap(name => binaryCandidates(name, { home })).find(path => existsSync(path) && exits(path, ['--version']));
    const status = STATUS_ARGS[lane];
    lanes[lane] = { installed: Boolean(binary), signedIn: !binary ? false : status ? exits(binary, status) : lane === 'local-model' ? true : UNKNOWN };
  }
  const root = join(home, ...REPO_ROOT);
  let repos: string[] = [];
  try { repos = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(root, e.name, '.git'))).map(e => e.name).sort(); } catch { /* none */ }
  let diskFreeBytes: number | null = null;
  try { const disk = statfsSync(home); diskFreeBytes = disk.bavail * disk.bsize; } catch { /* unknown */ }
  return { lanes, repos, diskFreeBytes };
}

/** Default adapter: this Mac is probed directly. Other Macs are not probed yet (stub, see file header). */
export const defaultNodeProbe: NodeProbe = async (_node, isSelf) => (isSelf ? localProbe() : null);

const gb = (bytes: number) => Math.round(bytes / 1e8) / 10;

function laneStatus(lane: DoctorLane, probe: NodeProbeReply | null, caps: string[] | Unknown): LaneCheck {
  const seen = probe?.lanes[lane];
  if (seen) {
    if (!seen.installed) return { lane, status: 'not-installed' };
    if (seen.signedIn === true) return { lane, status: 'ready' };
    if (seen.signedIn === false) return { lane, status: 'signed-out' };
    return { lane, status: 'unknown', reason: `${lane} is installed but has no sign-in check Phantom can run` };
  }
  // No probe: a lane the node advertised in its heartbeat is installed and signed in.
  if (caps !== UNKNOWN && caps.includes(lane)) return { lane, status: 'ready' };
  return { lane, status: 'unknown', reason: `${lane} is not advertised; installed or signed out is unknown until remote checks exist` };
}

export async function readNodesDoctor(deps: NodesDoctorDeps, only?: string): Promise<NodesDoctor> {
  const view = readNodesView(deps.view);
  let state: ReturnType<typeof readNodesRegistry>['state'] = null;
  try { state = deps.view.readRegistry().state; } catch { /* disk stays unknown */ }
  const safeProbe = async (row: NodeRow) => { try { return await deps.probe(row.name, row.isSelf); } catch { return null; } };
  const rows = view.nodes.filter(n => only === undefined || n.name === only);
  const selfProbe = await safeProbe(view.nodes.find(n => n.isSelf) ?? { name: view.self, isSelf: true } as NodeRow);
  const wanted = selfProbe?.repos ?? null;
  const nodes: DoctorNode[] = [];
  for (const row of rows) {
    const gaps: string[] = [], unknowns: string[] = [];
    const probe = row.reachable === false ? null : row.isSelf ? selfProbe : await safeProbe(row);
    if (row.reachable === false) gaps.push(`${row.name}: not reachable. Wake it and check it is on Tailscale.`);
    else if (row.reachable === UNKNOWN) unknowns.push(`${row.name}: reachability unknown (${view.reasons[0] ?? 'no network read'})`);
    const lanes = DOCTOR_LANES.map(lane => laneStatus(lane, probe, row.reachable === false ? UNKNOWN : row.lanes));
    for (const c of lanes) {
      const login = LOGIN[c.lane];
      if (row.reachable === false) c.reason = 'computer is offline';
      if (c.status === 'not-installed') gaps.push(`${row.name}: ${c.lane} is not installed. Install it on that Mac${login ? `, then run \`${login}\`` : ''}.`);
      else if (c.status === 'signed-out') gaps.push(`${row.name}: ${c.lane} is not signed in. ${login ? `Run \`${login}\`` : `Sign in to ${c.lane}`} on that Mac.`);
      else if (c.status === 'unknown' && c.reason) unknowns.push(`${row.name}: ${c.reason}`);
    }
    const record = state?.nodes.filter(r => [r.nodeId, r.capacity?.hostId].some(id => typeof id === 'string' && aliasMatches(id, row.name)))
      .sort((a, b) => b.heartbeatAt - a.heartbeatAt)[0];
    const diskBytes = probe?.diskFreeBytes ?? (row.reachable === false ? null : record?.hostStats?.diskFree ?? null);
    const diskFreeGb = diskBytes === null ? UNKNOWN : gb(diskBytes);
    if (diskFreeGb === UNKNOWN) unknowns.push(`${row.name}: free disk unknown (no measurement from that computer)`);
    else if (diskFreeGb < DOCTOR_MIN_DISK_GB) gaps.push(`${row.name}: only ${diskFreeGb} GB free; jobs hold under ${DOCTOR_MIN_DISK_GB} GB. Free space on that Mac.`);
    const repos = probe ? probe.repos : UNKNOWN;
    const missing = repos !== UNKNOWN && wanted ? wanted.filter(r => !repos.includes(r)) : UNKNOWN;
    if (repos === UNKNOWN) unknowns.push(`${row.name}: repo clones unknown (${row.reachable === false ? 'computer is offline' : 'remote checks do not exist yet'})`);
    else if (missing === UNKNOWN) unknowns.push(`${row.name}: repo list for comparison unavailable from this Mac`);
    else if (missing.length) gaps.push(`${row.name}: missing repo ${missing.join(', ')}. Clone ${missing.length === 1 ? 'it' : 'them'} under ~/Projects/ashlrai on that Mac.`);
    nodes.push({ name: row.name, isSelf: row.isSelf, reachable: row.reachable, lanes, repos, missingRepos: missing, diskFreeGb, gaps, unknowns,
      ready: gaps.length === 0 && unknowns.length === 0 });
  }
  return { schema: NODES_DOCTOR_SCHEMA, schemaVersion: 1, asOf: view.asOf, nodes, reasons: view.reasons };
}

export function doctorText(report: NodesDoctor): string {
  if (!report.nodes.length) return 'No computers known. Run `phm node join` on each computer.';
  const words: Record<LaneStatus, string> = { ready: 'ok', 'not-installed': 'not installed', 'signed-out': 'signed out', unknown: 'unknown' };
  return report.nodes.flatMap(n => [
    `${n.name}${n.isSelf ? ' (this computer)' : ''}: ${n.reachable === true ? 'reachable' : n.reachable === false ? 'not reachable' : 'reachability unknown'} | disk ${n.diskFreeGb === UNKNOWN ? 'unknown' : `${n.diskFreeGb} GB free`}`,
    `  ${n.lanes.map(l => `${l.lane} ${words[l.status]}`).join(' | ')}`,
    `  repos: ${n.repos === UNKNOWN ? 'unknown' : n.repos.join(', ') || 'none'}`,
    ...n.gaps.map(g => `  fix: ${g}`), ...n.unknowns.map(u => `  unknown: ${u}`),
    ...(n.ready ? ['  ready for jobs'] : []),
  ]).join('\n');
}
