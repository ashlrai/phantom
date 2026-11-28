/**
 * core/fleet/nodes-doctor.ts: `phm nodes doctor`, a read-only readiness check
 * for each joined computer. It answers "what is this computer missing before it
 * can take jobs?": reachable, whether a Phantom session is live there, which
 * lane CLIs are installed and signed in, which ashlrai repo clones exist and
 * free disk. Every gap is one plain fix line.
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
import { UNKNOWN } from './runtime-identity.js';
import { capServesLane, readNodesRegistry, readNodesView, registryDiskFree, type NodeRow, type NodesViewDeps } from './nodes-view.js';

export const NODES_DOCTOR_SCHEMA = 'phantom.nodes-doctor.v1';
/** Below this the node pool already holds jobs (see drive/nodes/capacity.ts). */
export const DOCTOR_MIN_DISK_GB = 20;
export const DOCTOR_LANES = ['claude', 'codex', 'devin', 'gemini', 'local-model'] as const;
export type DoctorLane = typeof DOCTOR_LANES[number];
type Unknown = typeof UNKNOWN;
export type LaneStatus = 'ready' | 'not-installed' | 'signed-out' | 'unknown';

/** What a probe saw. `signedIn: 'unknown'` means the CLI has no status command Phantom can run
 * or the check itself could not complete; `reason` then says which, overriding the default
 * "no sign-in check" wording. */
export interface NodeProbeReply {
  lanes: Partial<Record<DoctorLane, { installed: boolean; signedIn: boolean | Unknown; reason?: string }>>;
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

/** unknowns and gaps are reasons and fixes, not a log: several checks can share
 * one cause (an offline computer explains every lane check at once), so an
 * identical line prints once, in first-seen order. */
const note = (list: string[], msg: string): void => { if (!list.includes(msg)) list.push(msg); };

const LOGIN: Partial<Record<DoctorLane, string>> = { claude: 'claude auth login', codex: 'codex login' };
const BINARY: Record<DoctorLane, string[]> = { claude: ['claude'], codex: ['codex'], devin: ['devin'], gemini: ['gemini'], 'local-model': ['ollama', 'omlx', 'llama-server'] };
const STATUS_ARGS: Partial<Record<DoctorLane, string[]>> = { claude: ['auth', 'status', '--json'], codex: ['login', 'status'] };
const REPO_ROOT = ['Projects', 'ashlrai'];

/** Real probe for this computer: exit codes only, absolute binaries, no shell, no output kept. */
export function localProbe(run: typeof spawnSync = spawnSync, home: string = homedir()): NodeProbeReply {
  // 'ok' the CLI answered 0; 'failed' it ran to a nonzero exit — a real verdict;
  // 'unknown' it could not be spawned, was killed or timed out — never a verdict.
  const probe = (binary: string, args: string[]): 'ok' | 'failed' | 'unknown' => {
    const r = run(binary, args, { timeout: 5000, stdio: 'ignore', shell: false, env: { PATH: process.env['PATH'], HOME: home } });
    return r.error || r.status === null ? 'unknown' : r.status === 0 ? 'ok' : 'failed';
  };
  const lanes: NodeProbeReply['lanes'] = {};
  for (const lane of DOCTOR_LANES) {
    // `installed` is file presence at an allowlisted path. A binary that exists
    // but cannot answer `--version` is installed yet unverifiable — an honest
    // unknown, never "not installed" (that fix would reinstall working software)
    // and never "signed out" (the sign-in check never ran).
    const present = BINARY[lane].flatMap(name => binaryCandidates(name, { home })).filter(path => existsSync(path));
    const binary = present.find(path => probe(path, ['--version']) === 'ok');
    const status = STATUS_ARGS[lane];
    let signedIn: boolean | Unknown = false;
    let reason: string | undefined;
    if (present.length > 0 && binary === undefined) {
      signedIn = UNKNOWN;
      reason = `${lane} is installed but did not answer \`--version\``;
    } else if (binary !== undefined) {
      if (status === undefined) signedIn = lane === 'local-model' ? true : UNKNOWN;
      else {
        const verdict = probe(binary, status);
        if (verdict === 'ok') signedIn = true;
        else if (verdict === 'failed') signedIn = false;
        else {
          signedIn = UNKNOWN;
          reason = `${lane} is installed but did not answer the sign-in check`;
        }
      }
    }
    lanes[lane] = { installed: present.length > 0, signedIn, ...(reason === undefined ? {} : { reason }) };
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
    return { lane, status: 'unknown', reason: seen.reason ?? `${lane} is installed but has no sign-in check Phantom can run` };
  }
  // No probe: a lane the node advertised in its heartbeat is installed and signed in.
  // `local-model` is the report name; the advertisement is the oMLX cap family.
  if (caps !== UNKNOWN && caps.some(cap => capServesLane(cap, lane))) return { lane, status: 'ready' };
  return { lane, status: 'unknown', reason: `${lane} is not advertised; installed or signed out is unknown until remote checks exist` };
}

export async function readNodesDoctor(deps: NodesDoctorDeps, only?: string): Promise<NodesDoctor> {
  const view = readNodesView(deps.view);
  let registry: ReturnType<typeof readNodesRegistry> | null = null;
  try { registry = deps.view.readRegistry(); } catch { /* disk stays unknown */ }
  const nowMs = Date.parse(view.asOf);
  const safeProbe = async (row: NodeRow) => { try { return await deps.probe(row.name, row.isSelf); } catch { return null; } };
  const rows = view.nodes.filter(n => only === undefined || n.name === only);
  const selfProbe = await safeProbe(view.nodes.find(n => n.isSelf) ?? { name: view.self, isSelf: true } as NodeRow);
  const wanted = selfProbe?.repos ?? null;
  const nodes: DoctorNode[] = [];
  for (const row of rows) {
    const gaps: string[] = [], unknowns: string[] = [];
    const probe = row.reachable === false ? null : row.isSelf ? selfProbe : await safeProbe(row);
    if (row.reachable === false) note(gaps, `${row.name}: not reachable. Wake it and check it is on Tailscale.`);
    else if (row.reachable === UNKNOWN) note(unknowns, `${row.name}: reachability unknown (${view.reasons[0] ?? 'no network read'})`);
    // No live Phantom session means the computer cannot take jobs whatever its
    // lanes advertise; `state` already names the rejoin command when one exists.
    if (row.stateCode === 'not-running') note(gaps, `${row.name}: ${row.state}`);
    const lanes = DOCTOR_LANES.map(lane => laneStatus(lane, probe, row.reachable === false ? UNKNOWN : row.lanes));
    for (const c of lanes) {
      const login = LOGIN[c.lane];
      if (row.reachable === false) c.reason = 'computer is offline';
      if (c.status === 'not-installed') note(gaps, `${row.name}: ${c.lane} is not installed. Install it on that Mac${login ? `, then run \`${login}\`` : ''}.`);
      else if (c.status === 'signed-out') note(gaps, `${row.name}: ${c.lane} is not signed in. ${login ? `Run \`${login}\`` : `Sign in to ${c.lane}`} on that Mac.`);
      else if (c.status === 'unknown' && c.reason) note(unknowns, `${row.name}: ${c.reason}`);
    }
    const diskBytes = probe?.diskFreeBytes ?? registryDiskFree(registry, row, nowMs);
    const diskFreeGb = diskBytes === null ? UNKNOWN : gb(diskBytes);
    if (diskFreeGb === UNKNOWN) note(unknowns, `${row.name}: free disk unknown (no measurement from that computer)`);
    else if (diskFreeGb < DOCTOR_MIN_DISK_GB) note(gaps, `${row.name}: only ${diskFreeGb} GB free; jobs hold under ${DOCTOR_MIN_DISK_GB} GB. Free space on that Mac.`);
    const repos = probe ? probe.repos : UNKNOWN;
    const missing = repos !== UNKNOWN && wanted ? wanted.filter(r => !repos.includes(r)) : UNKNOWN;
    if (repos === UNKNOWN) note(unknowns, `${row.name}: repo clones unknown (${row.reachable === false ? 'computer is offline' : 'remote checks do not exist yet'})`);
    else if (missing === UNKNOWN) note(unknowns, `${row.name}: repo list for comparison unavailable from this Mac`);
    else if (missing.length) note(gaps, `${row.name}: missing repo ${missing.join(', ')}. Clone ${missing.length === 1 ? 'it' : 'them'} under ~/Projects/ashlrai on that Mac.`);
    nodes.push({ name: row.name, isSelf: row.isSelf, reachable: row.reachable, lanes, repos, missingRepos: missing, diskFreeGb, gaps, unknowns,
      ready: gaps.length === 0 && unknowns.length === 0 });
  }
  return { schema: NODES_DOCTOR_SCHEMA, schemaVersion: 1, asOf: view.asOf, nodes, reasons: view.reasons };
}

export function doctorText(report: NodesDoctor): string {
  const words: Record<LaneStatus, string> = { ready: 'ok', 'not-installed': 'not installed', 'signed-out': 'signed out', unknown: 'unknown' };
  // The view-level reasons explain the gaps the per-node lines cannot — for
  // example why a reachable remote computer gets no join command (this
  // computer has no node pool). `phm nodes` and `phm nodes offload` already
  // print them as `note:` lines; the doctor report carries the same list, so
  // its text output shows it too instead of leaving the JSON as the only read.
  const body = report.nodes.length === 0 ? ['No computers known. Run `phm node join` on each computer.']
    : report.nodes.flatMap(n => [
      `${n.name}${n.isSelf ? ' (this computer)' : ''}: ${n.reachable === true ? 'reachable' : n.reachable === false ? 'not reachable' : 'reachability unknown'} | disk ${n.diskFreeGb === UNKNOWN ? 'unknown' : `${n.diskFreeGb} GB free`}`,
      `  ${n.lanes.map(l => `${l.lane} ${words[l.status]}`).join(' | ')}`,
      `  repos: ${n.repos === UNKNOWN ? 'unknown' : n.repos.join(', ') || 'none'}`,
      ...n.gaps.map(g => `  fix: ${g}`), ...n.unknowns.map(u => `  unknown: ${u}`),
      ...(n.ready ? ['  ready for jobs'] : []),
    ]);
  return [...body, ...report.reasons.map(r => `note: ${r}`)].join('\n');
}
