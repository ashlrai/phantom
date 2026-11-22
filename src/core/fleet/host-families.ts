/** Compact projection of the existing host-load process trees; argv never leaves this module. */
import { execFile } from 'node:child_process';
import { scrubSecrets } from '../util/scrub.js';
import { attributeProcessTrees, HOST_LOAD_MODEL_COMMAND, parseProcessList, type TreeRootMatcher } from './host-load.js';
import { findHostLeftovers, readLeftoverEvidence, type LeftoverEvidence } from './host-leftovers.js';
import { parseEtime } from './runs-live-workers.js';

export const HOST_FAMILIES_PS_ARGS = ['-axo', 'pid,ppid,pcpu,rss,etime,command'];
export type HostFamily = 'leftover from finished jobs' | 'fleet worker' | 'claude loop' | 'main guardian' | 'typecheck/test' | 'local model' | 'desktop apps' | 'other';
export interface HostFamilyRow { family: HostFamily; job: string | null; jobs?: string[]; processes: number; cpuPercent: number; rssMb: number }
export interface HostFamilies { state: 'known' | 'unknown'; families: HostFamilyRow[]; omitted: number; leftovers?: ReturnType<typeof findHostLeftovers> }
const familyRows = (text: string | null) => parseProcessList((text ?? '').replace(/^(\s*\d+\s+\d+\s+[\d.]+\s+\d+)\s+\S+\s+/gm, '$1 '));

/** Pure: strips elapsed time, then reuses host load's parser and cycle-safe ancestor attribution. */
export function groupHostFamilies(text: string | null, evidence?: LeftoverEvidence): HostFamilies {
  const rows = familyRows(text);
  const ages = new Map<number, number | null>([...(text?.matchAll(/^\s*(\d+)\s+\d+\s+[\d.]+\s+\d+\s+(\S+)/gm) ?? [])].map(m => [Number(m[1]), parseEtime(m[2]!)]));
  const leftovers = findHostLeftovers(rows, evidence, ages), leftoverPids = new Set(leftovers.items.map(r => r.pid));
  const matchers: TreeRootMatcher[] = [], labels = new Map<string, { family: HostFamily; job: string | null }>();
  for (const row of rows) {
    if (leftoverPids.has(row.pid)) continue;
    const wt = /\/wt\/([\w.-]+)(?=[/\s'"]|$)/.exec(row.command)?.[1];
    const loop = /\bRQ-CL-[A-Za-z0-9-]+/.exec(row.command)?.[0];
    const test = /\b(?:tsgo|tsc|vitest|jest|eslint)\b|\bbun\s+test\b|\bnode\s+(?:--\S+\s+)*--test\b|\bnode\b.*\btest[-_/]/i.test(row.command);
    const family: HostFamily | null = loop ? 'claude loop' : wt?.startsWith('guardian-') ? 'main guardian'
      : wt ? test ? 'typecheck/test' : 'fleet worker' : test ? 'typecheck/test'
      : HOST_LOAD_MODEL_COMMAND.test(row.command) ? 'local model' : /\/[^/]+\.app\//.test(row.command) ? 'desktop apps' : null;
    if (!family) continue;
    const job = loop || wt ? scrubSecrets(loop ?? wt!).slice(0, 32) : null;
    const name = `${family}:${job ?? ''}`;
    labels.set(name, { family, job });
    // Use tree attribution's priority tier so a launching terminal app cannot swallow work or models.
    matchers.push({ name, pid: row.pid, fleet: family !== 'desktop apps' });
  }
  const trees = attributeProcessTrees(rows.filter(r => !leftoverPids.has(r.pid)), matchers);
  const families: HostFamilyRow[] = trees.roots.map(t => ({ ...(labels.get(t.name) ?? { family: 'other' as const, job: null }),
    processes: t.processes, cpuPercent: t.cpuPercent, rssMb: t.memoryMb }));
  if (leftovers.processes) families.push({ family: 'leftover from finished jobs', job: null, jobs: leftovers.jobs,
    processes: leftovers.processes, cpuPercent: leftovers.cpuPercent, rssMb: Math.round(rows.filter(r => leftoverPids.has(r.pid)).reduce((sum, r) => sum + r.memoryKb, 0) / 1024) });
  families.sort((a, b) => b.cpuPercent - a.cpuPercent);
  return { state: rows.length ? 'known' : 'unknown', families: families.slice(0, 8), omitted: Math.max(0, families.length - 8), ...(evidence ? { leftovers } : {}) };
}

/** Read-only, bounded ps call; failures never echo argv or subprocess errors. */
export async function readHostFamilies(ps?: () => Promise<string | null>, evidence?: LeftoverEvidence): Promise<HostFamilies> {
  try {
    const text = await (ps ? ps() : new Promise<string | null>(resolve => execFile('/bin/ps', HOST_FAMILIES_PS_ARGS,
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? null : stdout))));
    return groupHostFamilies(text, evidence ?? (ps ? undefined : await readLeftoverEvidence(familyRows(text))));
  } catch { return groupHostFamilies(null); }
}
