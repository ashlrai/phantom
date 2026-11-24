/**
 * Pure shaping for Home's Machines card. Everything here restates one `phm nodes pool --json` report
 * (phantom.nodes-pool.v1): nothing is estimated. A fact the report marks "unknown" stays unknown (never 0),
 * and memory in use is only the report's own free share turned round, so a Mac with no share gets no bar.
 */
import { seenWords, type NodesPool, type PoolNode, type PoolStatus } from '../../../../core/fleet/nodes-pool.js';

/** Job names shown on one tile; the rest are counted. */
export const JOB_CHIPS = 6;

export interface MacFact { label: string; value: string; unknown: boolean }
export interface MacTile {
  name: string; isSelf: boolean; status: PoolStatus;
  /** "seen 3 min ago", against the report's own read time. */
  seen: string;
  /** Jobs this Mac could take now. Null when nobody measured it. */
  slots: number | null;
  /** Share of memory in use, 0 to 100. Null when the report holds no free share. */
  memoryUsed: number | null;
  /** The memory reading in words; the bar only repeats it. */
  memoryWords: string;
  /** Up to JOB_CHIPS job ids. Null when the registry cannot say what the Mac is running. */
  jobs: string[] | null;
  moreJobs: number;
  facts: MacFact[];
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const amount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const fact = (label: string, value: string | null): MacFact => ({ label, value: value ?? 'unknown', unknown: value === null });

function memory(node: PoolNode): Pick<MacTile, 'memoryUsed' | 'memoryWords'> {
  const bytes = amount(node.freeMemoryBytes);
  const share = amount(node.freeMemoryPercent);
  const used = share !== null && share <= 100 ? Math.round(100 - share) : null;
  const free = bytes === null ? null : `${(bytes / 1024 ** 3).toFixed(1)} GB free`;
  if (free === null && used === null) return { memoryUsed: null, memoryWords: 'unknown' };
  return { memoryUsed: used, memoryWords: [free, used === null ? 'share in use unknown' : `${used}% in use`].filter(Boolean).join(', ') };
}

export function macTile(node: PoolNode, asOf: string): MacTile {
  const jobs = Array.isArray(node.jobsRunning) ? node.jobsRunning : null;
  const load = amount(node.load), disk = amount(node.freeDiskGb);
  return {
    name: node.name, isSelf: node.isSelf === true, status: node.status, seen: seenWords(node.lastSeen, asOf),
    slots: amount(node.freeSlots), ...memory(node),
    jobs: jobs ? jobs.slice(0, JOB_CHIPS) : null, moreJobs: jobs ? Math.max(0, jobs.length - JOB_CHIPS) : 0,
    facts: [
      fact('Load', load === null ? null : String(load)),
      fact('Disk free', disk === null ? null : `${disk} GB`),
      // Each Mac keeps its own offload setting, so the report only knows this Mac's.
      fact('Offload', node.offload === 'unknown' ? null : node.offload),
    ],
  };
}

/** The report's order is kept: this Mac first. */
export const macTiles = (pool: NodesPool): MacTile[] => pool.nodes.map(node => macTile(node, pool.asOf));

/** One line under the total: how many Macs answer, and how many jobs the ones that report are running. */
export function machinesSummary(pool: NodesPool): string {
  const count = (status: PoolStatus) => pool.nodes.filter(node => node.status === status).length;
  const offline = count('offline'), unsure = count('unknown');
  const reporting = pool.nodes.filter(node => Array.isArray(node.jobsRunning));
  const silent = pool.nodes.length - reporting.length;
  const jobs = reporting.reduce((sum, node) => sum + (node.jobsRunning as string[]).length, 0);
  return [
    `${count('online')} of ${plural(pool.nodes.length, 'Mac')} online`,
    offline > 0 ? `${offline} offline` : '',
    unsure > 0 ? `${unsure} not known` : '',
    reporting.length === 0 ? 'running jobs unknown' : `${plural(jobs, 'job')} running${silent > 0 ? ` (${plural(silent, 'Mac')} not reporting)` : ''}`,
  ].filter(Boolean).join(' · ');
}
