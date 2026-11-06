import { execFile } from 'node:child_process';
import { availableParallelism, loadavg } from 'node:os';
import { basename } from 'node:path';

export const LOAD_WHY_KINDS = ['vitest', 'tsc', 'esbuild', 'node mcp', 'bun', 'cargo', 'codex', 'claude', 'devin', 'git', 'other'] as const;
export type LoadWhyKind = (typeof LOAD_WHY_KINDS)[number];

export interface LoadWhyKindRow {
  kind: LoadWhyKind;
  count: number;
  /** Processes whose parent is pid 1: nobody is waiting on them. */
  orphans: number;
  /** Processes running (R) or waiting on disk (D). */
  active: number;
  cpu: number;
  rssKb: number;
}

export interface LoadWhyReport {
  loadavg: [number, number, number];
  cores: number;
  total: number;
  orphans: number;
  kinds: LoadWhyKindRow[];
}

export interface FleetLoadWhyDeps {
  /** Returns the stdout of `ps -axo pid,ppid,stat,pcpu,rss,etime,command`. */
  runner?: () => Promise<string>;
  loadavg?: () => number[];
  cores?: () => number;
}

export const LOAD_WHY_ORPHAN_LIMIT = 100;
const TOP_KINDS = 10;
export const LOAD_WHY_PS_ARGS = ['-axo', 'pid,ppid,stat,pcpu,rss,etime,command'];

const defaultRunner = (): Promise<string> => new Promise((resolve, reject) => {
  execFile('ps', LOAD_WHY_PS_ARGS, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout));
});

/** Sorts one command line into a kind. The program name decides first; node scripts are then judged by script path. */
export function classifyCommand(command: string): LoadWhyKind {
  const [argv0 = '', ...rest] = command.trim().split(/\s+/);
  const exe = basename(argv0).toLowerCase();
  if (exe === 'vitest') return 'vitest';
  if (exe === 'tsc' || exe === 'tsgo') return 'tsc';
  if (exe === 'esbuild') return 'esbuild';
  if (exe === 'bun') return 'bun';
  if (exe === 'cargo' || exe === 'rustc') return 'cargo';
  if (exe === 'codex') return 'codex';
  if (exe === 'claude') return 'claude';
  if (exe === 'devin') return 'devin';
  if (exe === 'git') return 'git';
  if (exe === 'node' || exe === 'nodejs') {
    const script = rest.find(token => !token.startsWith('-'))?.toLowerCase() ?? '';
    if (/vitest/.test(script)) return 'vitest';
    if (/(^|[/\\])(tsc|tsgo)(\.[cm]?js)?$|typescript[/\\]bin/.test(script)) return 'tsc';
    if (/esbuild/.test(script)) return 'esbuild';
    if (/mcp/.test(script)) return 'node mcp';
  }
  return 'other';
}

/** Turns ps output into per-kind rows, busiest kinds first. Lines that do not parse are skipped. */
export function summarizeProcesses(
  psOutput: string,
  host: { loadavg: number[]; cores: number },
): LoadWhyReport {
  const rows = new Map<LoadWhyKind, LoadWhyKindRow>();
  let total = 0, orphans = 0;
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const kind = classifyCommand(m[7]!);
    const row = rows.get(kind) ?? { kind, count: 0, orphans: 0, active: 0, cpu: 0, rssKb: 0 };
    row.count++;
    if (m[2] === '1') { row.orphans++; orphans++; }
    if (/^[RD]/.test(m[3]!)) row.active++;
    row.cpu += Number(m[4]);
    row.rssKb += Number(m[5]);
    rows.set(kind, row);
    total++;
  }
  const kinds = [...rows.values()]
    .map(r => ({ ...r, cpu: Math.round(r.cpu * 10) / 10 }))
    .sort((a, b) => b.count - a.count || LOAD_WHY_KINDS.indexOf(a.kind) - LOAD_WHY_KINDS.indexOf(b.kind))
    .slice(0, TOP_KINDS);
  const [l1 = 0, l5 = 0, l15 = 0] = host.loadavg.map(n => Math.round(n * 100) / 100);
  return { loadavg: [l1, l5, l15], cores: host.cores, total, orphans, kinds };
}

function formatReport(report: LoadWhyReport): string {
  const mb = (kb: number): string => `${Math.round(kb / 1024)} MB`;
  const lines = [
    `Load ${report.loadavg.join(' ')} on ${report.cores} cores. ${report.total} processes, ${report.orphans} orphans.`,
    'kind       count  orphans  busy  cpu%    memory',
    ...report.kinds.map(r => `${r.kind.padEnd(10)} ${String(r.count).padStart(5)}  ${String(r.orphans).padStart(7)}  ${String(r.active).padStart(4)}  ${String(r.cpu).padStart(5)}  ${mb(r.rssKb).padStart(8)}`),
  ];
  if (report.orphans > LOAD_WHY_ORPHAN_LIMIT) lines.push(`Too many orphans (over ${LOAD_WHY_ORPHAN_LIMIT}). Stop the leftover processes.`);
  return lines.join('\n');
}

/**
 * `ashlr fleet load-why [--json]` — read-only: why is the machine busy?
 * Groups `ps` output by kind. Exits 1 when more than 100 processes are orphans
 * (parent pid 1), 2 on a bad flag or when ps fails. Never throws.
 */
export async function cmdFleetLoadWhy(args: string[], deps: FleetLoadWhyDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log('Usage: ashlr fleet load-why [--json]\nShows which kinds of processes are loading this machine. Exits 1 when over 100 are orphans.');
    return 0;
  }
  if (args.some(a => a !== '--json')) {
    console.error('Usage: ashlr fleet load-why [--json]');
    return 2;
  }
  const json = args.includes('--json');
  let out: string;
  try {
    out = await (deps.runner ?? defaultRunner)();
  } catch {
    console.error('Could not read the process list (ps failed).');
    return 2;
  }
  const report = summarizeProcesses(out, { loadavg: (deps.loadavg ?? loadavg)(), cores: (deps.cores ?? availableParallelism)() });
  console.log(json ? JSON.stringify(report) : formatReport(report));
  return report.orphans > LOAD_WHY_ORPHAN_LIMIT ? 1 : 0;
}
