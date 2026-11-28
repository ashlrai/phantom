import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { cpus, homedir, loadavg, platform } from 'node:os';
import { join } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubSecrets } from '../util/scrub.js';
import { readLoadOwnerInputs, summarizeLoadOwners, type LoadOwnerInputs, type LoadOwners } from './load-owners.js';
import { findHostLeftovers, leftoverJob, processTool, readLeftoverEvidence, type LeftoverEvidence } from './host-leftovers.js';

export interface HostLoad {
  load1: number | null; load5: number | null; load15: number | null;
  cores: number | null; ratio: number | null;
}

export function readHostLoad(deps: { loadavg: () => number[]; cpus: () => unknown[]; platform?: () => string } = { loadavg, cpus }): HostLoad {
  let loads: number[] = [];
  let cores: number | null = null;
  // os.loadavg() always returns [0,0,0] on Windows; that stub is not a load reading.
  let posix = true;
  try { posix = (deps.platform ?? platform)() !== 'win32'; } catch { /* Platform unknown: try the reading. */ }
  if (posix) try { loads = deps.loadavg(); } catch { /* The load reading is unavailable. */ }
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
/** Tree mode reads the whole command line, so a root can be matched by folder or pattern. */
export const HOST_LOAD_TREE_PS_ARGS = ['-axo', 'pid,ppid,pcpu,rss,command'];
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
  /** Present only in by-tree mode (`phm host load --by-tree`, `?by=tree`). */
  trees?: HostLoadTrees;
  /** Who owns the load, by producer, with the admission guard's state and any idle-but-busy job. */
  owners?: LoadOwners;
}

// ── By tree: every process counted under the root it descends from ─────────────────────────────────────────────

/** One process row. cpu is ps CPU (100 = one busy core); memoryKb is resident memory. */
export interface ProcessRow { pid: number; ppid: number; cpu: number; memoryKb: number; command: string }
/** A root: a fleet job (by pid) or a named app, found by pid and/or a command pattern (a working folder or a word). */
export interface TreeRootMatcher { name: string; fleet: boolean; pid?: number; command?: RegExp }
export interface TreeRow {
  name: string; fleet: boolean; cpuPercent: number; memoryMb: number;
  processes: number;
  /** Processes in the tree other than the root process itself. */
  descendants: number;
  /** The three busiest descendant commands, busiest first. */
  topCommands: { command: string; cpuPercent: number }[];
}
export interface HostLoadTrees {
  /** One plain sentence for the top of the human output. */
  summary: string;
  /** Fleet tree CPU divided by total CPU, 0 to 1; 'unknown' when there is nothing to divide. */
  fleetShare: number | 'unknown';
  fleetCpuPercent: number; totalCpuPercent: number;
  roots: TreeRow[];
}
export const UNATTRIBUTED = 'unattributed';
const NAMED_APPS = ['Codex', 'Claude', 'ChatGPT', 'Cursor', 'Grok', 'Chrome', 'Docker'];
const WORK_WORDS = /\b(typecheck|tsgo|tsc|vitest|jest|eslint|lint|build|test|install)\b/i;
/** Never the full command line: argv can hold secrets. Only the program name, plus a fixed work word ("npm (typecheck)") when one is present. */
const shortCommand = (command: string): string => {
  const program = plainName(baseName(command.trim().split(/\s+/)[0] ?? ''));
  const work = WORK_WORDS.exec(command)?.[1]?.toLowerCase();
  return work && work !== program.toLowerCase() ? `${program} (${work})` : program;
};
/** "typecheck", "vitest" ... when the command names the work; otherwise the program name. */
const workWord = (command: string): string =>
  WORK_WORDS.exec(command)?.[1]?.toLowerCase() ?? plainName(baseName(command.trim().split(/\s+/)[0] ?? ''));

/** The fleet's job roots plus the named desktop apps and local model servers, as matchers. */
export function defaultTreeMatchers(jobRoots: readonly HostLoadJobRoot[] | null): TreeRootMatcher[] {
  return [
    ...(jobRoots ?? []).map(root => ({ name: `job ${root.jobId}`, fleet: true, pid: root.pid })),
    ...NAMED_APPS.map(app => ({ name: app, fleet: false, command: new RegExp(`/${app}\\.app/`, 'i') })),
    { name: 'Local models', fleet: false, command: HOST_LOAD_MODEL_COMMAND },
  ];
}

/**
 * Pure: puts every process under one root, the topmost ancestor (or itself) that a matcher names; fleet roots win
 * over apps. Anything else, including a process whose parent is missing from the list, goes under "unattributed",
 * so the rows always add up to the whole list. A repeated pid counts once (the first row); a parent loop stops at
 * the first repeat. Callers may name unmatched rows by executable instead of combining them as unattributed.
 * The optional visitor observes the same deduplicated rows and ownership decisions.
 */
export function attributeProcessTrees(rowsIn: readonly ProcessRow[], matchers: readonly TreeRootMatcher[], unattributedName?: (row: ProcessRow) => string, onAttributed?: (row: ProcessRow, root: TreeRootMatcher | undefined) => void): HostLoadTrees {
  const rows = new Map<number, ProcessRow>();
  for (const row of rowsIn) if (!rows.has(row.pid)) rows.set(row.pid, row);
  const match = (row: ProcessRow, fleet: boolean) =>
    matchers.find(m => m.fleet === fleet && (m.pid === row.pid || (m.command !== undefined && m.command.test(row.command))));
  const trees = new Map<string, { fleet: boolean; rootPids: Set<number>; members: ProcessRow[] }>();
  for (const row of rows.values()) {
    let found: TreeRootMatcher | undefined, foundAt: ProcessRow = row, foundFleet = false;
    const seen = new Set<number>();
    for (let at: ProcessRow | undefined = row; at && !seen.has(at.pid); at = rows.get(at.ppid)) {
      seen.add(at.pid);
      const fleetHit = match(at, true);
      if (fleetHit) { found = fleetHit; foundAt = at; foundFleet = true; }
      else if (!foundFleet) { const appHit = match(at, false); if (appHit) { found = appHit; foundAt = at; } }
    }
    onAttributed?.(row, found);
    const name = found?.name ?? unattributedName?.(row) ?? UNATTRIBUTED;
    const tree = trees.get(name) ?? { fleet: found?.fleet ?? false, rootPids: new Set<number>(), members: [] };
    if (found) tree.rootPids.add(foundAt.pid);
    tree.members.push(row);
    trees.set(name, tree);
  }
  const out: TreeRow[] = [...trees].map(([name, tree]) => {
    const below = tree.members.filter(row => !tree.rootPids.has(row.pid)).sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
    return {
      name, fleet: tree.fleet, descendants: below.length, processes: tree.members.length,
      cpuPercent: round1(tree.members.reduce((sum, row) => sum + row.cpu, 0)),
      memoryMb: Math.round(tree.members.reduce((sum, row) => sum + row.memoryKb, 0) / 1024),
      topCommands: below.slice(0, 3).map(row => ({ command: shortCommand(row.command), cpuPercent: round1(row.cpu) })),
    };
  }).sort((a, b) => b.cpuPercent - a.cpuPercent || a.name.localeCompare(b.name));
  const totalCpuPercent = round1(out.reduce((sum, row) => sum + row.cpuPercent, 0));
  const fleetCpuPercent = round1(out.filter(row => row.fleet).reduce((sum, row) => sum + row.cpuPercent, 0));
  const fleetShare = totalCpuPercent > 0 ? Math.round((fleetCpuPercent / totalCpuPercent) * 1000) / 1000 : 'unknown';
  const topFleet = out.find(row => row.fleet && row.cpuPercent > 0);
  const work = topFleet ? ` (${workWord(topFleet.topCommands[0]?.command ?? topFleet.name)})` : '';
  const summary = fleetShare === 'unknown'
    ? "The fleet's share of CPU is unknown: no process list could be read."
    : !topFleet ? `The fleet's own jobs and their children use ${Math.round(fleetShare * 100)}% of CPU; no fleet job is running.`
    : `The fleet's own jobs and their children use ${Math.round(fleetShare * 100)}% of CPU; the top tree is ${topFleet.name}${work}.`;
  return { summary, fleetShare, fleetCpuPercent, totalCpuPercent, roots: out };
}

/** Pure: process-list text (pid ppid cpu memory command) as rows. Commands may be long and contain spaces. */
export function parseProcessList(psText: string | null): ProcessRow[] {
  return [...parseHostPs(psText).values()].map(row => ({ pid: row.pid, ppid: row.ppid, cpu: row.cpu, memoryKb: row.rssKb, command: row.comm }));
}

export const HOST_LOAD_MODEL_COMMAND = /(?:^|[^a-z])(?:o?mlx|llama|ollama)/i;
const DESKTOP_APP = /\b(?:codex|claude|chatgpt|cursor|grok|phantom|chrome|docker)\b/i;
export const HOST_LOAD_SYSTEM_PATH = /^\/(?:System|usr\/libexec|usr\/sbin|sbin|Library\/Apple)\//;
const TOP_ITEMS = 5;
const round1 = (value: number): number => Math.round(value * 10) / 10;
/** Process names reach JSON and the UI, so keep plain characters only. */
export const plainName = (text: string): string => text.replace(/[^\w .()+-]/g, '').trim().slice(0, 64) || 'unnamed';
export const baseName = (comm: string): string => comm.slice(comm.lastIndexOf('/') + 1);
export interface HostPsRow { pid: number; ppid: number; cpu: number; rssKb: number; comm: string }
/** Pure: the rows of `ps -axo pid,ppid,pcpu,rss,comm` by pid. Lines that are not a process row are skipped. */
export function parseHostPs(psText: string | null): Map<number, HostPsRow> {
  const rows = new Map<number, HostPsRow>();
  for (const line of (psText ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]), comm: m[5]! });
  }
  return rows;
}

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
  type Row = HostPsRow;
  const rows = parseHostPs(psText);
  const rootJob = new Map((jobRoots ?? []).map(root => [root.pid, root.jobId]));
  const own = (row: Row): [HostLoadGroupId, string] | null => {
    if (HOST_LOAD_MODEL_COMMAND.test(baseName(row.comm))) return ['local-models', baseName(row.comm)];
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
    return inherited ?? [row.pid <= 1 || HOST_LOAD_SYSTEM_PATH.test(row.comm) ? 'system' : 'other', baseName(row.comm)];
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
  leftovers?: LeftoverEvidence;
  /** Returns the text of `ps -axo pid,ppid,pcpu,rss,comm`, or null when it cannot be read. Tests inject text. */
  ps?: (full?: boolean) => Promise<string | null>;
  /** Returns the fleet's job roots, or null when they cannot be read. */
  jobRoots?: () => HostLoadJobRoot[] | null;
  load?: () => HostLoad;
  now?: () => number;
  /** Admission state and job log times; tests inject them. */
  owners?: (report: HostLoadReport) => LoadOwnerInputs;
}

export const readHostPs = (full = false): Promise<string | null> => new Promise(resolve => execFile('/bin/ps', full ? HOST_LOAD_TREE_PS_ARGS : HOST_LOAD_PS_ARGS,
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
export async function readHostLoadReport(deps: HostLoadDeps = {}, opts: { byTree?: boolean } = {}): Promise<HostLoadReport> {
  let psText: string | null = null, roots: HostLoadJobRoot[] | null = null;
  try { psText = await (deps.ps ?? readHostPs)(opts.byTree === true); } catch { /* Unknown process list. */ }
  try { roots = (deps.jobRoots ?? readHostLoadJobRoots)(); } catch { /* Unknown job roots. */ }
  const rows = parseProcessList(psText);
  const evidence = deps.leftovers ?? (deps.ps ? undefined : await readLeftoverEvidence(rows).catch(() => undefined));
  const leftoverRoots = findHostLeftovers(rows, evidence).items.map(row => ({ jobId: row.job, pid: row.pid }));
  const attributedRoots = roots === null && !leftoverRoots.length ? null : [...(roots ?? []), ...leftoverRoots];
  const load = (deps.load ?? readHostLoad)();
  const report = groupHostLoad(psText, attributedRoots, { load1: load.load1, cores: load.cores, now: (deps.now ?? Date.now)() });
  report.jobRoots = roots?.length ?? null;
  if (roots === null && leftoverRoots.length) { report.state = rows.length ? 'partial' : 'unknown'; report.gaps.push('Live job roots are unknown; confirmed leftovers count as fleet work.'); }
  try { report.owners = summarizeLoadOwners(report, { ...(deps.owners ?? readLoadOwnerInputs)(report), now: (deps.now ?? Date.now)() }); } catch { /* Owners are optional. */ }
  if (opts.byTree) report.trees = attributeProcessTrees(rows, defaultTreeMatchers(attributedRoots));
  return report;
}

export interface HostOrphanGroup { command: string; job: string | null; processes: number; cpuPercent: number; watchers: number | null }
export interface HostOrphansReport {
  schema: 'host.orphans.v1'; state: 'known' | 'partial' | 'unknown';
  processes: number | null; cpuPercent: number | null; groups: HostOrphanGroup[];
  watcherKind: 'kqueue-descriptors'; notes: string[];
}
export type HostOrphansDeps = HostLoadDeps & { runsDir?: string; watcherPs?: (pids: number[]) => Promise<string | null> };

/** kqueue descriptors are observable on macOS; they are not a count of watched files. No paths or argv. */
const readWatcherPs = (pids: number[]): Promise<string | null> => new Promise(resolve => {
  if (process.platform !== 'darwin' || !pids.length) { resolve(null); return; }
  execFile('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-Fpt'],
    { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } },
    (error, stdout) => resolve(error ? null : stdout));
});

/** Adopted processes are candidates, not proof of a leak: PID 1 also parents services. Never signals anything. */
export async function readHostOrphans(deps: HostOrphansDeps = {}): Promise<HostOrphansReport> {
  let text: string | null = null;
  try { text = await (deps.ps ?? readHostPs)(false); } catch { /* Unknown process list. */ }
  const rows = parseProcessList(text), candidates = rows.filter(row => row.pid > 1 && row.ppid === 1);
  const evidence = deps.leftovers ?? (deps.ps ? undefined : await readLeftoverEvidence(rows, deps.runsDir).catch(() => undefined));
  let watcherText: string | null = null;
  if (candidates.length) try { watcherText = await (deps.watcherPs ?? (deps.ps ? async () => null : readWatcherPs))(candidates.map(row => row.pid)); } catch { /* Unknown watchers. */ }
  const watchers = new Map<number, number>();
  let pid = 0;
  for (const line of (watcherText ?? '').split('\n')) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); watchers.set(pid, 0); }
    else if (line === 'tKQUEUE' && watchers.has(pid)) watchers.set(pid, watchers.get(pid)! + 1);
  }
  const groups = new Map<string, HostOrphanGroup>();
  for (const row of candidates) {
    const cwd = evidence?.cwds.get(row.pid), job = cwd && evidence ? leftoverJob(cwd, evidence.worktreeRoot) : undefined;
    const command = processTool(row.command), owner = job ? scrubSecrets(job) : null, key = JSON.stringify([command, owner]);
    const group = groups.get(key) ?? { command, job: owner, processes: 0, cpuPercent: 0, watchers: 0 };
    group.processes++; group.cpuPercent += row.cpu;
    const count = watchers.get(row.pid);
    group.watchers = group.watchers === null || count === undefined ? null : group.watchers + count;
    groups.set(key, group);
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  const ranked = [...groups.values()].sort((a, b) => b.cpuPercent - a.cpuPercent || a.command.localeCompare(b.command) || (a.job ?? '').localeCompare(b.job ?? ''));
  for (const group of ranked) group.cpuPercent = round(group.cpuPercent);
  const notes = ['Processes with parent 1; services can also appear. This is not proof of a leak.',
    'Watchers count macOS kqueue descriptors, not watched files. CPU 100% means one busy core.'];
  if (!rows.length) notes.push('The process list is unavailable.');
  if (ranked.some(group => group.job === null)) notes.push('Some jobs are unknown; no matching worktree was readable.');
  if (ranked.some(group => group.watchers === null)) notes.push('Some watcher information is unavailable.');
  return { schema: 'host.orphans.v1', state: !rows.length ? 'unknown' : notes.length > 2 ? 'partial' : 'known',
    processes: rows.length ? candidates.length : null, cpuPercent: rows.length ? round(candidates.reduce((sum, row) => sum + row.cpu, 0)) : null,
    groups: ranked, watcherKind: 'kqueue-descriptors', notes };
}
