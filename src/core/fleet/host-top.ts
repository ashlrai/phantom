/**
 * Host top: what is using this machine's CPU and memory, grouped by program
 * family and split into fleet-owned versus everything else (`phm host`, GET
 * /api/verse/fleet/host). Read-only. Process args are read to classify and
 * attribute, but never returned, so keys or tokens on a command line cannot
 * leak. Anything this host will not tell us stays null (unknown), never zero.
 */
import { execFile } from 'node:child_process';
import { existsSync, readlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join, sep } from 'node:path';
import { readHostLoad } from './host-load.js';
import { readMacMemoryDiagnostics } from '../run/host-headroom.js';

export const HOST_TOP_SCHEMA = 'phantom.host.v1';
/** `ps -axo pid,ppid,pcpu,rss,etime,comm,args`, headerless and unclipped. */
export const HOST_PS_ARGS = ['-axww', '-o', 'pid=,ppid=,pcpu=,rss=,etime=,comm=,args='];
export const HOST_FAMILIES = ['node', 'git', 'codex', 'claude', 'python', 'docker', 'spotlight', 'browser', 'other'] as const;
export type HostFamily = (typeof HOST_FAMILIES)[number];
const LABELS: Record<HostFamily, string> = { node: 'Node/Bun/tsx', git: 'Git', codex: 'Codex', claude: 'Claude', python: 'Python/MLX',
  docker: 'Docker', spotlight: 'Spotlight', browser: 'Chrome/Safari', other: 'Other' };
const ORPHAN_LIMIT = 50;

export interface HostGroup { family: HostFamily; label: string; fleet: boolean; processes: number; cpuPercent: number; rssBytes: number }
export interface HostOrphan { pid: number; family: HostFamily; name: string; job: string; reason: 'worktree-gone' | 'parent-launchd'; ageSeconds: number | null }
/** Schema phantom.host.v1. CPU percent is ps's average where 100 = one core. Null always means unknown. */
export interface HostReportV1 {
  schema: typeof HOST_TOP_SCHEMA; version: 1; generatedAt: string;
  load: { load1: number | null; load5: number | null; load15: number | null; cpuCount: number | null };
  memory: { freePercent: number | null; swapGb: number | null };
  processes: {
    state: 'known' | 'unknown'; reason: 'ps-denied' | 'ps-failed' | 'ps-unreadable' | null;
    count: number | null; cwd: 'read' | 'unavailable';
    cpuPercent: number | null; fleetCpuPercent: number | null; otherCpuPercent: number | null;
    /** Fleet share of process CPU, 0..1; null when unknown or nothing is running. */
    fleetShare: number | null;
  };
  topCpu: HostGroup[] | null; topRss: HostGroup[] | null;
  orphans: HostOrphan[] | null; orphanCount: number | null;
}

/** Everything the report reads, injectable so tests use fixtures. */
export interface HostTopReader {
  home: string;
  now(): number;
  /** Raw `ps` stdout for HOST_PS_ARGS. Throws when ps is not permitted or fails. */
  ps(): Promise<string>;
  /** Working directory of a process, or null when this host cannot say (no lsof). */
  cwd(pid: number): string | null;
  exists(path: string): boolean;
  load(): Pick<HostReportV1['load'], 'load1' | 'load5' | 'load15'> & { cores: number | null };
  memory(): HostReportV1['memory'];
}

/** Bounded `ps` run with a fixed PATH and locale; shared with `fleet load-why`. */
export function runPs(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('/bin/ps', [...args], { timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } }, (error, stdout, stderr) =>
    error ? reject(Object.assign(error, { stderr: String(stderr ?? '') })) : resolve(stdout)));
}

export function defaultHostTopReader(): HostTopReader {
  const linux = platform() === 'linux';
  return {
    home: homedir(), now: Date.now, ps: () => runPs(HOST_PS_ARGS), exists: existsSync, load: readHostLoad,
    // lsof-free: Linux exposes /proc/<pid>/cwd; macOS has no equivalent without lsof, so it stays unknown.
    cwd: pid => { if (!linux) return null; try { return readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ''); } catch { return null; } },
    memory: () => { const read = platform() === 'darwin' ? readMacMemoryDiagnostics() : null;
      return { freePercent: read ? Math.round(read.freePercent * 10) / 10 : null, swapGb: read ? Math.round(read.swapGb * 100) / 100 : null }; },
  };
}

interface Proc { pid: number; ppid: number; cpu: number; rss: number; age: number | null; exe: string; args: string }

/** `[[dd-]hh:]mm:ss` to seconds. */
export function parseEtime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}

/** comm and args are both free text; comm ends where args restarts with it (macOS paths may hold spaces). */
function splitCommArgs(rest: string): [string, string] {
  // Exact repeat first (macOS full paths), then a bare name whose args name its path (Linux comm).
  for (const same of [(comm: string, args: string) => args.startsWith(comm),
    (comm: string, args: string) => basename(args.split(' ')[0] ?? '') === basename(comm)]) {
    for (let i = rest.indexOf(' '); i > 0; i = rest.indexOf(' ', i + 1)) {
      if (same(rest.slice(0, i), rest.slice(i + 1))) return [rest.slice(0, i), rest.slice(i + 1)];
    }
  }
  const i = rest.indexOf(' ');
  return i < 0 ? [rest, rest] : [rest.slice(0, i), rest.slice(i + 1)];
}

export function parseHostPs(text: string): Proc[] | null {
  const rows: Proc[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue; // a header or a line ps clipped; the rest still counts
    const [comm, args] = splitCommArgs(m[6]!.trim());
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rss: Number(m[4]) * 1024, age: parseEtime(m[5]!), exe: basename(comm), args });
  }
  return rows.length ? rows : null;
}

/** Sorts a process into a family by its program name, then by the script a runtime runs. */
export function hostFamily(exe: string, args = ''): HostFamily {
  const name = exe.toLowerCase();
  const script = args.split(/\s+/).slice(1).find(token => !token.startsWith('-'))?.toLowerCase() ?? '';
  if (/^(mds|mds_stores|mdworker|mdworker_shared|mdsync|mdbulkimport|corespotlightd)$/.test(name)) return 'spotlight';
  if (/chrome|chromium|safari|com\.apple\.webkit/.test(name)) return 'browser';
  if (/docker|vpnkit|containerd|qemu-system/.test(name)) return 'docker';
  if (name === 'git' || name.startsWith('git-')) return 'git';
  if (name === 'claude' || /claude-code|[/\\]claude(\.[cm]?js)?$/.test(script)) return 'claude';
  if (name === 'codex' || name.startsWith('codex-') || /@openai[/\\]codex|[/\\]codex(\.[cm]?js)?$/.test(script)) return 'codex';
  if (/^python|mlx/.test(name)) return 'python';
  if (/^(node|nodejs|bun|tsx|npm|npx|pnpm|vitest|esbuild|tsgo|tsc)$/.test(name)) return 'node';
  return 'other';
}

const round = (n: number, places = 1): number => Math.round(n * 10 ** places) / 10 ** places;
const two = (n: number | null): number | null => n === null ? null : round(n, 2);
const under =(path: string, root: string): boolean => path === root || path.startsWith(root + sep);

export async function readHostTop(options: { top?: number; reader?: HostTopReader } = {}): Promise<HostReportV1> {
  const io = options.reader ?? defaultHostTopReader();
  const top = Math.max(1, Math.min(50, Math.floor(options.top ?? 5)));
  const load = io.load();
  const base: Pick<HostReportV1, 'schema' | 'version' | 'generatedAt' | 'load' | 'memory'> = {
    schema: HOST_TOP_SCHEMA, version: 1, generatedAt: new Date(io.now()).toISOString(),
    load: { load1: two(load.load1), load5: two(load.load5), load15: two(load.load15), cpuCount: load.cores },
    memory: io.memory(),
  };
  let rows: Proc[] | null = null, reason: HostReportV1['processes']['reason'] = null;
  try {
    rows = parseHostPs(await io.ps());
    if (!rows) reason = 'ps-unreadable';
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    reason = e.code === 'EPERM' || e.code === 'EACCES' || /not permitted|permission/i.test(e.stderr ?? '') ? 'ps-denied' : 'ps-failed';
  }
  if (!rows) {
    return { ...base, processes: { state: 'unknown', reason, count: null, cwd: 'unavailable', cpuPercent: null, fleetCpuPercent: null, otherCpuPercent: null, fleetShare: null },
      topCpu: null, topRss: null, orphans: null, orphanCount: null };
  }

  const wt = join(io.home, 'Projects', 'ashlrai', 'wt'), runs = join(io.home, '.ashlr-runs');
  const byPid = new Map(rows.map(row => [row.pid, row]));
  let cwdRead = false;
  // Where a process runs: its cwd when readable, else a fleet path its command names.
  const place = new Map<number, string | null>();
  const where = (row: Proc): string | null => {
    if (place.has(row.pid)) return place.get(row.pid)!;
    const cwd = io.cwd(row.pid);
    if (cwd) cwdRead = true;
    const named = row.args.split(/\s+/).find(token => under(token, wt) || under(token, runs)) ?? null;
    const value = cwd && (under(cwd, wt) || under(cwd, runs)) ? cwd : named ?? cwd;
    place.set(row.pid, value);
    return value;
  };
  const jobOf = (row: Proc): string | null => {
    const path = where(row);
    return path && under(path, wt) ? path.slice(wt.length + 1).split(sep)[0] || null : null;
  };
  const ancestry = (row: Proc): Proc[] => {
    const chain: Proc[] = [], seen = new Set<number>();
    for (let at: Proc | undefined = row; at && !seen.has(at.pid); at = byPid.get(at.ppid)) { seen.add(at.pid); chain.push(at); }
    return chain;
  };
  const fleet = (row: Proc): boolean => ancestry(row).some(at => {
    const path = where(at);
    return /(^|[/\s])dispatchd(\.\w+)?(\s|$)/.test(at.args) || (path !== null && (under(path, wt) || under(path, runs)));
  });

  const groups = new Map<string, HostGroup>();
  let total = 0, fleetCpu = 0;
  const orphans: HostOrphan[] = [];
  for (const row of rows) {
    const family = hostFamily(row.exe, row.args), owned = fleet(row), key = `${family}:${owned}`;
    const group = groups.get(key) ?? { family, label: LABELS[family], fleet: owned, processes: 0, cpuPercent: 0, rssBytes: 0 };
    group.processes++; group.cpuPercent += row.cpu; group.rssBytes += row.rss; groups.set(key, group);
    total += row.cpu; if (owned) fleetCpu += row.cpu;
    const job = jobOf(row);
    if (!job) continue;
    const gone = !io.exists(join(wt, job));
    if (!gone && row.ppid !== 1) continue;
    const parent = byPid.get(row.ppid);
    if (gone && parent && jobOf(parent) === job) continue; // report the top of a dead job's tree only
    orphans.push({ pid: row.pid, family, name: row.exe, job, reason: gone ? 'worktree-gone' : 'parent-launchd', ageSeconds: row.age });
  }
  const list = [...groups.values()].map(g => ({ ...g, cpuPercent: round(g.cpuPercent) }));
  const rank = (key: 'cpuPercent' | 'rssBytes') => [...list].sort((a, b) => b[key] - a[key] || a.label.localeCompare(b.label)).slice(0, top);
  orphans.sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1) || a.pid - b.pid);
  return { ...base,
    processes: { state: 'known', reason: null, count: rows.length, cwd: cwdRead ? 'read' : 'unavailable', cpuPercent: round(total),
      fleetCpuPercent: round(fleetCpu), otherCpuPercent: round(total - fleetCpu), fleetShare: total > 0 ? round(fleetCpu / total, 3) : null },
    topCpu: rank('cpuPercent'), topRss: rank('rssBytes'), orphans: orphans.slice(0, ORPHAN_LIMIT), orphanCount: orphans.length };
}

/** `3h 12m`, `4d 2h`, `45s`; unknown stays unknown. */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'age unknown';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}
