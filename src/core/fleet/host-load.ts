import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';

export interface HostLoad {
  load1: number | null; load5: number | null; load15: number | null;
  cores: number | null; ratio: number | null;
}

export function readHostLoad(deps: { loadavg: () => number[]; cpus: () => unknown[] } = { loadavg, cpus }): HostLoad {
  let loads: number[] = [];
  let cores: number | null = null;
  try { loads = deps.loadavg(); } catch { /* The load reading is unavailable. */ }
  try { const count = deps.cpus().length; if (count > 0) cores = count; } catch { /* Core count is unavailable. */ }
  const valid = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const load1 = valid(loads[0]);
  const rounded = load1 !== null && cores !== null ? Math.round((load1 / cores) * 10) / 10 : null;
  return { load1, load5: valid(loads[1]), load15: valid(loads[2]), cores, ratio: rounded !== null && Number.isFinite(rounded) ? rounded : null };
}

export function hostLoadTone(ratio: number | null): 'unknown' | 'ok' | 'warn' | 'bad' {
  return ratio === null ? 'unknown' : ratio < 1.5 ? 'ok' : ratio < 4 ? 'warn' : 'bad';
}

export function describeHostLoad(load: HostLoad | null | undefined): string {
  return load?.load1 == null || load.cores == null || load.ratio == null
    ? 'Load unknown' : `Load ${load.load1} on ${load.cores} cores (${load.ratio.toFixed(1)}×)`;
}

// ── What is loading this host: `phm host load` and the Fleet host "Host" card ──────────────────────────────────

export const HOST_LOAD_SCHEMA = 'host.load.v1';
export const HOST_LOAD_PS_ARGS = ['-axo', 'pid,ppid,pcpu,rss,comm'];
export const HOST_LOAD_GROUPS = [
  { id: 'fleet-workers', label: 'Fleet workers', words: 'fleet workers' },
  { id: 'local-models', label: 'Local models', words: 'local models' },
  { id: 'desktop-apps', label: 'Desktop apps', words: 'desktop apps' },
  { id: 'system', label: 'System', words: 'the system' },
  { id: 'other', label: 'Other', words: 'other' },
] as const;
export type HostLoadGroupId = (typeof HOST_LOAD_GROUPS)[number]['id'];
/** A fleet job and the pid of the process its worker tree hangs from. */
export interface HostLoadJobRoot { jobId: string; pid: number }
/** One job (fleet-workers), app, model server or command inside a group. */
export interface HostLoadItem { name: string; cpuPercent: number; rssMb: number; processes: number }
export interface HostLoadGroup extends HostLoadItem {
  id: HostLoadGroupId;
  /** Share of load1 by CPU share, whole points; the groups sum to the rounded load1. Null when load1 is unknown. */
  loadPoints: number | null;
  /** Busiest first. Every job for fleet-workers; the top five elsewhere. */
  items: HostLoadItem[];
}
export interface HostLoadReport {
  schema: typeof HOST_LOAD_SCHEMA; version: 1; generatedAt: string;
  /** known: every input was read. partial: see gaps. unknown: no process list, so groups is empty. */
  state: 'known' | 'partial' | 'unknown';
  load1: number | null; cores: number | null;
  /** Job roots handed in; null when the fleet's job roots could not be read. */
  jobRoots: number | null;
  processes: number;
  /** ps CPU, where 100 is one busy core. */
  cpuPercent: number;
  /** The top line in plain words, shared by the CLI and the card. */
  summary: string;
  groups: HostLoadGroup[];
  gaps: string[];
}

const MODEL_COMMAND = /(?:^|[^a-z])(?:o?mlx|llama|ollama)/i;
const DESKTOP_APP = /\b(?:codex|claude|chatgpt|cursor|grok|phantom|chrome|docker)\b/i;
const SYSTEM_PATH = /^\/(?:System|usr\/libexec|usr\/sbin|sbin|Library\/Apple)\//;
const TOP_ITEMS = 5;
const round1 = (value: number): number => Math.round(value * 10) / 10;
/** Process names reach JSON and the UI, so keep plain characters only. */
const plainName = (text: string): string => text.replace(/[^\w .()+-]/g, '').trim().slice(0, 64) || 'unnamed';
const baseName = (comm: string): string => comm.slice(comm.lastIndexOf('/') + 1);

/**
 * Pure: groups the text of `ps -axo pid,ppid,pcpu,rss,comm` into who is loading the host. Never runs ps.
 * A process under a job root (itself or any ancestor) is a fleet worker, whatever its name. Otherwise the
 * nearest of itself and its ancestors that is a local model server or one of the owner's desktop apps (an
 * .app bundle) decides, then system paths, then other.
 */
export function groupHostLoad(
  psText: string | null,
  jobRoots: readonly HostLoadJobRoot[] | null,
  host: { load1: number | null; cores: number | null; now?: number } = { load1: null, cores: null },
): HostLoadReport {
  type Row = { pid: number; ppid: number; cpu: number; rssKb: number; comm: string };
  const rows = new Map<number, Row>();
  for (const line of (psText ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]), comm: m[5]! });
  }
  const rootJob = new Map((jobRoots ?? []).map(root => [root.pid, root.jobId]));
  const own = (row: Row): [HostLoadGroupId, string] | null => {
    if (MODEL_COMMAND.test(baseName(row.comm))) return ['local-models', baseName(row.comm)];
    const app = /\/([^/]+)\.app\/Contents\//.exec(row.comm)?.[1];
    return app && DESKTOP_APP.test(app) ? ['desktop-apps', app] : null;
  };
  const place = (row: Row): [HostLoadGroupId, string] => {
    let inherited: [HostLoadGroupId, string] | null = null;
    const seen = new Set<number>();
    for (let at: Row | undefined = row; at && !seen.has(at.pid); at = rows.get(at.ppid)) {
      seen.add(at.pid);
      const job = rootJob.get(at.pid);
      if (job !== undefined) return ['fleet-workers', job];
      inherited ??= own(at);
    }
    return inherited ?? [row.pid <= 1 || SYSTEM_PATH.test(row.comm) ? 'system' : 'other', baseName(row.comm)];
  };
  const items = new Map<HostLoadGroupId, Map<string, HostLoadItem>>(HOST_LOAD_GROUPS.map(group => [group.id, new Map()]));
  for (const row of rows.values()) {
    const [id, raw] = place(row), name = plainName(raw), bucket = items.get(id)!;
    const item = bucket.get(name) ?? { name, cpuPercent: 0, rssMb: 0, processes: 0 };
    item.cpuPercent += row.cpu; item.rssMb += row.rssKb / 1024; item.processes++;
    bucket.set(name, item);
  }
  const groups: HostLoadGroup[] = rows.size === 0 ? [] : HOST_LOAD_GROUPS.map(({ id, label }) => {
    const all = [...items.get(id)!.values()].sort((a, b) => b.cpuPercent - a.cpuPercent || a.name.localeCompare(b.name));
    const sum = (key: 'cpuPercent' | 'rssMb' | 'processes') => all.reduce((total, item) => total + item[key], 0);
    return { id, name: label, cpuPercent: round1(sum('cpuPercent')), rssMb: Math.round(sum('rssMb')), processes: sum('processes'), loadPoints: null,
      items: (id === 'fleet-workers' ? all : all.slice(0, TOP_ITEMS)).map(item => ({ ...item, cpuPercent: round1(item.cpuPercent), rssMb: Math.round(item.rssMb) })) };
  });
  const cpuPercent = round1(groups.reduce((total, group) => total + group.cpuPercent, 0));
  const load1 = host.load1 !== null && Number.isFinite(host.load1) && host.load1 >= 0 ? host.load1 : null;
  if (load1 !== null && cpuPercent > 0) {
    // Largest remainder, so the whole points add up to the rounded load.
    const exact = groups.map(group => (Math.round(load1) * group.cpuPercent) / cpuPercent);
    groups.forEach((group, i) => { group.loadPoints = Math.floor(exact[i]!); });
    let left = Math.round(load1) - groups.reduce((total, group) => total + group.loadPoints!, 0);
    for (const i of exact.map((value, index) => [value - Math.floor(value), index] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(pair => pair[1])) {
      if (left-- <= 0) break;
      groups[i]!.loadPoints!++;
    }
  }
  const gaps: string[] = [];
  if (rows.size === 0) gaps.push('The process list is unavailable, so the sources of load are unknown.');
  else {
    if (jobRoots === null) gaps.push('Fleet job roots are unknown, so fleet workers are counted under other groups.');
    else if (jobRoots.length === 0) gaps.push('No fleet job roots are registered, so any fleet workers are counted under other groups.');
    if (load1 === null) gaps.push('Load is unknown, so only CPU share is shown.');
    else gaps.push('Load points are an estimate: the one-minute load split by CPU share. Processes waiting on disk add load without CPU.');
    gaps.push('Model servers started through an interpreter such as python are counted by the interpreter name.');
  }
  const head = load1 === null ? 'Load unknown' : `Load ${Math.round(load1)}`;
  const ranked = groups.filter(group => group.id !== 'other' && (load1 === null ? group.cpuPercent : group.loadPoints ?? 0) > 0)
    .sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 3);
  const words = (id: HostLoadGroupId) => HOST_LOAD_GROUPS.find(group => group.id === id)!.words;
  const total = load1 === null ? cpuPercent : Math.round(load1);
  const amount = (group: HostLoadGroup) => load1 === null ? group.cpuPercent : group.loadPoints ?? 0;
  const rest = Math.max(0, round1(total - ranked.reduce((sum, group) => sum + amount(group), 0)));
  const unit = load1 === null ? '% CPU' : '';
  const parts = [...ranked.map(group => `${amount(group)}${unit} from ${words(group.id)}`), ...(rest > 0 || ranked.length === 0 ? [`${rest}${unit} other`] : [])];
  return {
    schema: HOST_LOAD_SCHEMA, version: 1, generatedAt: new Date(host.now ?? Date.now()).toISOString(),
    state: rows.size === 0 ? 'unknown' : jobRoots === null || load1 === null ? 'partial' : 'known',
    load1, cores: host.cores, jobRoots: jobRoots?.length ?? null, processes: rows.size, cpuPercent,
    summary: rows.size === 0 || cpuPercent === 0 ? `${head}: sources unknown` : `${head}: ${parts.join(', ')}`,
    groups, gaps,
  };
}

export interface HostLoadDeps {
  /** Returns the text of `ps -axo pid,ppid,pcpu,rss,comm`, or null when it cannot be read. Tests inject text. */
  ps?: () => Promise<string | null>;
  /** Returns the fleet's job roots, or null when they cannot be read. */
  jobRoots?: () => HostLoadJobRoot[] | null;
  load?: () => HostLoad;
  now?: () => number;
}

const runPs = (): Promise<string | null> => new Promise(resolve => execFile('/bin/ps', HOST_LOAD_PS_ARGS,
  { timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } },
  (error, stdout) => resolve(error ? null : stdout)));

/** Reads the host runtime's live job claims (queue/run/resource-sessions/<job>.json). Read-only; null when absent. */
export function readHostLoadJobRoots(runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')): HostLoadJobRoot[] | null {
  const dir = join(runsDir, 'queue', 'run', 'resource-sessions');
  let names: string[];
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')).sort().slice(0, 256); } catch { return null; }
  const roots: HostLoadJobRoot[] = [];
  for (const name of names) {
    const file = readStableRegularFile(join(dir, name), { anchorPath: runsDir, maxFileBytes: 64 * 1024, remainingBytes: 64 * 1024 });
    try {
      const claim = JSON.parse(file.ok ? file.text : 'null') as { jobId?: unknown; rootPid?: unknown } | null;
      if (typeof claim?.jobId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(claim.jobId) &&
        `${claim.jobId}.json` === name && Number.isSafeInteger(claim.rootPid) && (claim.rootPid as number) > 1) roots.push({ jobId: claim.jobId, pid: claim.rootPid as number });
    } catch { /* An unreadable claim is skipped; its processes fall into the other groups. */ }
  }
  return roots;
}

/** The one impure entry: runs ps and reads the claims, then hands both to groupHostLoad. Never throws. */
export async function readHostLoadReport(deps: HostLoadDeps = {}): Promise<HostLoadReport> {
  let psText: string | null = null, roots: HostLoadJobRoot[] | null = null;
  try { psText = await (deps.ps ?? runPs)(); } catch { /* Unknown process list. */ }
  try { roots = (deps.jobRoots ?? readHostLoadJobRoots)(); } catch { /* Unknown job roots. */ }
  const load = (deps.load ?? readHostLoad)();
  return groupHostLoad(psText, roots, { load1: load.load1, cores: load.cores, now: (deps.now ?? Date.now)() });
}
