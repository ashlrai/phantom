/** Compact projection of the existing host-load process trees; argv never leaves this module. */
import { execFile } from 'node:child_process';
import { scrubSecrets } from '../util/scrub.js';
import { attributeProcessTrees, baseName, HOST_LOAD_MODEL_COMMAND, parseProcessList, plainName, readHostLoad, type HostLoad, type HostLoadItem, type TreeRootMatcher } from './host-load.js';
import { findHostLeftovers, readLeftoverEvidence, type LeftoverEvidence } from './host-leftovers.js';
import { parseEtime } from './runs-live-workers.js';

export const HOST_FAMILIES_PS_ARGS = ['-ww', '-axo', 'pid,ppid,pcpu,rss,state,etime,comm,command'];
export type HostFamily = string;
export interface HostFamilyRow { family: HostFamily; job: string | null; jobs?: string[]; processes: number; cpuPercent: number; rssMb: number }
export interface HostFamilies {
  state: 'known' | 'unknown'; families: HostFamilyRow[]; omitted: number; blame: string;
  fleetCpuPercent: number; totalCpuPercent: number; unknownCommands: HostLoadItem[];
  /** D/U state counts by executable; null means state readings are unavailable. */
  ioWait: { name: string; processes: number }[] | null;
  leftovers?: ReturnType<typeof findHostLeftovers>;
}
const familyRows = (text: string | null) => {
  const header = text?.split('\n', 1)[0] ?? '', start = header.indexOf('COMM');
  const width = start >= 0 ? header.indexOf('COMMAND', start + 4) - start - 1 : 0;
  const hasState = /\b(?:STAT|STATE)\b/.test(header);
  const pattern = hasState ? /^(\s*\d+\s+\d+\s+[\d.]+\s+\d+)\s+(\S+)\s+(\S+) (.*)$/
    : /^(\s*\d+\s+\d+\s+[\d.]+\s+\d+)\s+(\S+) (.*)$/;
  return (text ?? '').split('\n').flatMap(line => {
    const match = pattern.exec(line);
    if (!match) return [];
    // Keep padding until after the split: an empty comm must not shift argv into its column.
    const tail = match[hasState ? 4 : 3]!;
    const command = width > 0 ? tail.slice(width + 1).trim() : tail.trim();
    const fullPath = command.split(/\s+/)[0] ?? '';
    let executable = width > 0 ? tail.slice(0, width).trim() : hasState ? fullPath : command;
    const short = baseName(executable);
    if (fullPath.startsWith('/') && (!executable || short.length <= 2 || baseName(fullPath).startsWith(short))) executable = fullPath;
    const row = parseProcessList(`${match[1]} ${command || executable || 'unknown'}`)[0];
    return row ? [{ ...row, executable: executable || 'unknown', processState: hasState ? match[2]! : null, ageSeconds: parseEtime(match[hasState ? 3 : 2]!) }] : [];
  });
};
const appName = (command: string) => /^\/(?:[^/\s]+\/)*([^/]+)\.app\//.exec(command)?.[1];
const executableFamily = (command: string): string => {
  const name = appName(command) ?? (/^(?:\S*\/)?Code Helper\b/.test(command) ? 'Code Helper' : baseName(command.trim().split(/\s+/)[0] ?? ''));
  return /^(?:mds(?:_stores)?|mdworker(?:_shared)?)$/.test(name) ? 'Spotlight' : scrubSecrets(plainName(name));
};

/** Only the executable token: never search arguments for a display name. */
const commandName = (command: string): string => plainName(command.trim().split(/\s+/)[0]?.split('/').pop() ?? 'unknown');
function isKnownStandalone(command: string): boolean {
  const name = commandName(command).toLowerCase();
  const path = command.split(/\s+/)[0]!.toLowerCase();
  if (/docker|com\.docker|qemu|virtualbox|vmware|virtualization|vfkit|lima/.test(name + ' ' + path)) return true;
  if (/^(?:mds(?:_stores)?|mdworker(?:_shared)?|spotlight)$/.test(name)) return true;
  if (/^git(?:-|$)/.test(name)) return true;
  if (/\b(?:tsserver|eslint(?:server|[-.]server)|typescript-language-server|vscode-eslint-language-server)\b/i.test(command)) return true;
  if (/^(?:codex|claude)(?:[-.]|$)/.test(name) || /\/(?:@openai\/codex|@anthropic-ai\/claude-code)\//.test(command)) return true;
  if (/chrome|chromium|safari|webkit|firefox/.test(name + ' ' + path) || /^\/.*?(?:Chrome|Chromium|Safari|Firefox)[^/]*\.app\//i.test(command)) return true;
  if (/^(?:node|nodejs|npm|npx|vite)(?:[-.]|$)/.test(name)) return true;
  if (/^python(?:\d|$)/.test(name)) return true;
  return false;
}

/** Pure: strips elapsed time, then reuses host load's parser and cycle-safe ancestor attribution. */
export function groupHostFamilies(text: string | null, evidence?: LeftoverEvidence, host: Pick<HostLoad, 'load1' | 'cores'> = { load1: null, cores: null }): HostFamilies {
  const rows = familyRows(text);
  const names = new Map(rows.map(row => [row.pid, executableFamily(row.executable)]));
  const ages = new Map(rows.map(row => [row.pid, row.ageSeconds]));
  const waiting = new Map<string, number>();
  for (const row of rows) if (/^[DU]/.test(row.processState ?? '')) {
    const name = scrubSecrets(plainName(baseName(row.executable)));
    waiting.set(name, (waiting.get(name) ?? 0) + 1);
  }
  const ioWait = rows.length && rows.every(row => row.processState !== null)
    ? [...waiting].map(([name, processes]) => ({ name, processes })).sort((a, b) => b.processes - a.processes || a.name.localeCompare(b.name)) : null;
  const leftovers = findHostLeftovers(rows, evidence, ages), leftoverPids = new Set(leftovers.items.map(r => r.pid));
  const matchers: TreeRootMatcher[] = [], labels = new Map<string, { family: HostFamily; job: string | null }>();
  for (const row of rows) {
    if (leftoverPids.has(row.pid)) continue;
    const wt = /\/wt\/([\w.-]+)(?=[/\s'"]|$)/.exec(row.command)?.[1];
    const loop = /\bRQ-CL-[A-Za-z0-9-]+/.exec(row.command)?.[0];
    const test = /\b(?:tsgo|tsc|vitest|jest|eslint)\b|\bbun\s+test\b|\bnode\s+(?:--\S+\s+)*--test\b|\bnode\b.*\btest[-_/]/i.test(row.command);
    const family: HostFamily | null = loop ? 'claude loop' : wt?.startsWith('guardian-') ? 'main guardian'
      : wt ? test ? 'typecheck/test' : 'fleet worker' : test ? 'typecheck/test'
      : HOST_LOAD_MODEL_COMMAND.test(row.command) ? 'local model' : appName(row.executable) ? names.get(row.pid)! : null;
    if (!family) continue;
    const job = loop || wt ? scrubSecrets(loop ?? wt!).slice(0, 32) : null;
    const name = `${family}:${job ?? ''}`;
    labels.set(name, { family, job });
    // Use tree attribution's priority tier so a launching terminal app cannot swallow work or models.
    matchers.push({ name, pid: row.pid, fleet: !appName(row.executable) || !!wt || !!loop || test || family === 'local model' });
  }
  const unknown = new Map<string, HostLoadItem>();
  const trees = attributeProcessTrees(rows.filter(r => !leftoverPids.has(r.pid)), matchers, row => names.get(row.pid)!, (row, root) => {
    if (root || isKnownStandalone(row.command)) return;
    const name = names.get(row.pid)!;
    const item = unknown.get(name) ?? { name, processes: 0, cpuPercent: 0, rssMb: 0 };
    item.processes++; item.cpuPercent += row.cpu; item.rssMb += row.memoryKb / 1024;
    unknown.set(name, item);
  });
  const families: HostFamilyRow[] = trees.roots.filter(t => t.cpuPercent >= 20 || labels.has(t.name)).map(t => ({ ...(labels.get(t.name) ?? { family: t.name, job: null }),
    processes: t.processes, cpuPercent: t.cpuPercent, rssMb: t.memoryMb }));
  const small = trees.roots.filter(t => t.cpuPercent < 20 && !labels.has(t.name));
  if (small.length) families.push({ family: 'other', job: null, processes: small.reduce((n, t) => n + t.processes, 0),
    cpuPercent: Math.round(small.reduce((n, t) => n + t.cpuPercent, 0) * 10) / 10, rssMb: small.reduce((n, t) => n + t.memoryMb, 0) });
  if (leftovers.processes) families.push({ family: 'leftover from finished jobs', job: null, jobs: leftovers.jobs,
    processes: leftovers.processes, cpuPercent: leftovers.cpuPercent, rssMb: Math.round(rows.filter(r => leftoverPids.has(r.pid)).reduce((sum, r) => sum + r.memoryKb, 0) / 1024) });
  families.sort((a, b) => b.cpuPercent - a.cpuPercent);
  const fleet = families.filter(r => r.job !== null || r.family === 'leftover from finished jobs').reduce((n, r) => n + r.cpuPercent, 0);
  const totalCpuPercent = Math.round((trees.totalCpuPercent + leftovers.cpuPercent) * 10) / 10;
  // CPU is a sampled percentage; the load average also counts blocked processes.
  const ioBlame = rows.length && host.load1 !== null && totalCpuPercent / 100 < host.load1 / 2
    ? `load is mostly I/O wait (${ioWait?.slice(0, 3).map(r => `${r.name} ${r.processes}`).join(', ') || 'waiting processes unknown'})` : null;
  const blame = `load1 ${host.load1 ?? 'unknown'} on ${host.cores ?? 'unknown'} cores: ${rows.length
    ? ioBlame ?? [...families.slice(0, 2).map(r => `${r.family} ${r.cpuPercent}%`), `fleet ${Math.round(fleet * 10) / 10}%`].join(', ') : 'process load unknown'}`;
  return { state: rows.length ? 'known' : 'unknown', families: families.slice(0, 8), omitted: Math.max(0, families.length - 8), blame,
    unknownCommands: [...unknown.values()].sort((a, b) => b.cpuPercent - a.cpuPercent || a.name.localeCompare(b.name)).slice(0, 5)
      .map(item => ({ ...item, cpuPercent: Math.round(item.cpuPercent * 10) / 10, rssMb: Math.round(item.rssMb) })),
    ioWait, fleetCpuPercent: Math.round(fleet * 10) / 10, totalCpuPercent, ...(evidence ? { leftovers } : {}) };
}

export const ioWaitLine = (report: Pick<HostFamilies, 'ioWait'>): string =>
  `io-wait: ${report.ioWait === null ? 'unknown' : report.ioWait.map(r => `${r.name} ${r.processes}`).join(', ') || 'none observed'}`;

/** Read-only, bounded ps call; failures never echo argv or subprocess errors. */
export async function readHostFamilies(ps?: () => Promise<string | null>, evidence?: LeftoverEvidence): Promise<HostFamilies> {
  try {
    const text = await (ps ? ps() : new Promise<string | null>(resolve => execFile('/bin/ps', HOST_FAMILIES_PS_ARGS,
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? null : stdout))));
    return groupHostFamilies(text, evidence ?? (ps ? undefined : await readLeftoverEvidence(familyRows(text))), readHostLoad());
  } catch { return groupHostFamilies(null); }
}
