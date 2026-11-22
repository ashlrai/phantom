/** Compact projection of the existing host-load process trees; argv never leaves this module. */
import { execFile } from 'node:child_process';
import { scrubSecrets } from '../util/scrub.js';
import { attributeProcessTrees, HOST_LOAD_MODEL_COMMAND, parseProcessList, plainName, type HostLoadItem, type TreeRootMatcher } from './host-load.js';

export const HOST_FAMILIES_PS_ARGS = ['-axo', 'pid,ppid,pcpu,rss,etime,command'];
export type HostFamily = 'fleet worker' | 'claude loop' | 'main guardian' | 'typecheck/test' | 'local model' | 'desktop apps'
  | 'Docker/virtualization' | 'Spotlight/indexing' | 'git' | 'Node/Vite' | 'language servers' | 'Codex/Claude helpers' | 'browsers' | 'Python' | 'unknown';
export interface HostFamilyRow { family: HostFamily; job: string | null; processes: number; cpuPercent: number; rssMb: number }
export interface HostFamilies { state: 'known' | 'unknown'; families: HostFamilyRow[]; omitted: number; unknownCommands: HostLoadItem[]; fleetCpuPercent: number; totalCpuPercent: number }

/** Only the executable token: never search arguments for a display name. */
const commandName = (command: string): string => plainName(command.trim().split(/\s+/)[0]?.split('/').pop() ?? 'unknown');
function standaloneFamily(command: string): HostFamily | null {
  const name = commandName(command).toLowerCase();
  const path = command.split(/\s+/)[0]!.toLowerCase();
  if (/docker|com\.docker|qemu|virtualbox|vmware|virtualization|vfkit|lima/.test(name + ' ' + path)) return 'Docker/virtualization';
  if (/^(?:mds(?:_stores)?|mdworker(?:_shared)?|spotlight)$/.test(name)) return 'Spotlight/indexing';
  if (/^git(?:-|$)/.test(name)) return 'git';
  if (/\b(?:tsserver|eslint(?:server|[-.]server)|typescript-language-server|vscode-eslint-language-server)\b/i.test(command)) return 'language servers';
  if (/^(?:codex|claude)(?:[-.]|$)/.test(name) || /\/(?:@openai\/codex|@anthropic-ai\/claude-code)\//.test(command)) return 'Codex/Claude helpers';
  if (/chrome|chromium|safari|webkit|firefox/.test(name + ' ' + path) || /^\/.*?(?:Chrome|Chromium|Safari|Firefox)[^/]*\.app\//i.test(command)) return 'browsers';
  if (/^(?:node|nodejs|npm|npx|vite)(?:[-.]|$)/.test(name)) return 'Node/Vite';
  if (/^python(?:\d|$)/.test(name)) return 'Python';
  return null;
}

/** Pure: strips elapsed time, then reuses host load's parser and cycle-safe ancestor attribution. */
export function groupHostFamilies(text: string | null): HostFamilies {
  const rows = parseProcessList((text ?? '').replace(/^(\s*\d+\s+\d+\s+[\d.]+\s+\d+)\s+\S+\s+/gm, '$1 '));
  const matchers: TreeRootMatcher[] = [], labels = new Map<string, { family: HostFamily; job: string | null }>();
  for (const row of rows) {
    const wt = /\/wt\/([\w.-]+)(?=[/\s'"]|$)/.exec(row.command)?.[1];
    const loop = /\bRQ-CL-[A-Za-z0-9-]+/.exec(row.command)?.[0];
    const test = /\b(?:tsgo|tsc|vitest|jest)\b|\bnode\s+(?:--\S+\s+)*--test\b|\bnode\b.*\btest[-_/]/i.test(row.command);
    const family: HostFamily | null = loop ? 'claude loop' : wt?.startsWith('guardian-') ? 'main guardian'
      : wt ? test ? 'typecheck/test' : 'fleet worker' : test ? 'typecheck/test'
      : HOST_LOAD_MODEL_COMMAND.test(row.command) ? 'local model' : /\/[^/]+\.app\//.test(row.command) ? standaloneFamily(row.command) ?? 'desktop apps' : null;
    if (!family) continue;
    const job = loop || wt ? scrubSecrets(loop ?? wt!).slice(0, 32) : null;
    const name = `${family}:${job ?? ''}`;
    labels.set(name, { family, job });
    // Use tree attribution's priority tier so a launching terminal app cannot swallow work or models.
    matchers.push({ name, pid: row.pid, fleet: job !== null || family === 'typecheck/test' || family === 'local model' });
  }
  const buckets = new Map<string, HostFamilyRow>(), unknown = new Map<string, HostLoadItem>();
  const trees = attributeProcessTrees(rows, matchers, (row, root) => {
    const inherited = root ? labels.get(root.name) : undefined;
    const label = inherited && (inherited.job !== null || inherited.family === 'typecheck/test' || inherited.family === 'local model') ? inherited
      : { family: standaloneFamily(row.command) ?? (inherited?.family ?? 'unknown'), job: null };
    const key = `${label.family}:${label.job ?? ''}`;
    const item = buckets.get(key) ?? { ...label, processes: 0, cpuPercent: 0, rssMb: 0 };
    item.processes++; item.cpuPercent += row.cpu; item.rssMb += row.memoryKb / 1024; buckets.set(key, item);
    if (label.family === 'unknown') {
      const name = commandName(row.command), item = unknown.get(name) ?? { name, processes: 0, cpuPercent: 0, rssMb: 0 };
      item.processes++; item.cpuPercent += row.cpu; item.rssMb += row.memoryKb / 1024; unknown.set(name, item);
    }
  });
  const round = <T extends { cpuPercent: number; rssMb: number }>(r: T): T => ({ ...r, cpuPercent: Math.round(r.cpuPercent * 10) / 10, rssMb: Math.round(r.rssMb) });
  const families = [...buckets.values()].sort((a, b) => b.cpuPercent - a.cpuPercent || a.family.localeCompare(b.family)).map(round);
  const fleetCpuPercent = families.filter(r => r.job !== null).reduce((sum, r) => sum + r.cpuPercent, 0);
  return { state: rows.length ? 'known' : 'unknown', families: families.slice(0, 8), omitted: Math.max(0, families.length - 8),
    fleetCpuPercent, totalCpuPercent: trees.totalCpuPercent,
    unknownCommands: [...unknown.values()].sort((a, b) => b.cpuPercent - a.cpuPercent || a.name.localeCompare(b.name)).slice(0, 5).map(round) };
}

/** Read-only, bounded ps call; failures never echo argv or subprocess errors. */
export async function readHostFamilies(ps?: () => Promise<string | null>): Promise<HostFamilies> {
  try {
    const text = await (ps ? ps() : new Promise<string | null>(resolve => execFile('/bin/ps', HOST_FAMILIES_PS_ARGS,
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? null : stdout))));
    return groupHostFamilies(text);
  } catch { return groupHostFamilies(null); }
}
