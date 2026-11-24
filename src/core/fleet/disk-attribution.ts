import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { measureWorktreeBytes } from '../worktree-retention.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { defaultFs } from './wt-audit.js';
import { readWtCensus, type WtCensusDeps } from './wt-census.js';

export interface FleetDiskEntry {
  job: string;
  path: string;
  kind: 'worktree' | 'job-artifact';
  repo: string | null;
  pool: string | null;
  bytes: number | null;
  complete: boolean;
  cleanup: 'candidate' | 'retain';
  reason: string;
}

/** Logical bytes, not exclusive physical blocks; never read artifact contents. */
async function artifactBytes(path: string): Promise<number | null> {
  try { const stat = await lstat(path); return stat.isFile() && stat.nlink === 1 ? stat.size : null; }
  catch { return null; }
}

/** CLI-only scan: reuse census safety evidence, with one shared size-walk budget. */
export async function readFleetDiskAttribution(deps: WtCensusDeps & {
  artifactBytes?: typeof artifactBytes;
} = {}) {
  const deadlineMs = Date.now() + 2_000;
  const census = await readWtCensus({ ...deps, gitBudgetMs: deps.gitBudgetMs ?? 2_000,
    measure: deps.measure ?? (dir => measureWorktreeBytes(dir, { deadlineMs })) });
  const entries = new Map<string, FleetDiskEntry>();
  for (const w of census.worktrees) {
    const path = resolve(w.root === 'jobs' ? census.roots.worktrees : census.roots.runsWorktrees, w.name);
    entries.set(path, { job: w.name, path, kind: 'worktree', repo: w.repo, pool: w.pool, bytes: w.bytes, complete: w.sizeComplete,
      cleanup: w.census === 'safe-reap' && w.sizeComplete && w.bytes !== null ? 'candidate' : 'retain',
      reason: [w.state, ...w.blockers, ...(!w.sizeComplete ? ['size incomplete'] : [])].join(', ') });
  }
  const names = await (deps.fs ?? defaultFs).entries(census.roots.runs);
  let artifactsComplete = names !== null;
  const artifactDeadline = Date.now() + 2_000;
  const artifacts = [...(names ?? [])].sort().filter(name =>
    /^[A-Za-z0-9][\w.-]*\.(?:base|log(?:\.gz)?|publish(?:\.prev-\d+)?|prompt|notes\.md|body\.md)$/.test(name));
  for (const name of artifacts.slice(0, 10_000)) {
    if (Date.now() >= artifactDeadline) { artifactsComplete = false; break; }
    const path = resolve(census.roots.runs, name);
    const bytes = await (deps.artifactBytes ?? artifactBytes)(path).catch(() => null);
    if (bytes === null) artifactsComplete = false;
    const job = name.replace(/\.(?:base|log(?:\.gz)?|publish(?:\.prev-\d+)?|prompt|notes\.md|body\.md)$/, '');
    const owner = census.worktrees.find(w => w.name === job);
    entries.set(path, { job, path, kind: 'job-artifact', repo: owner?.repo ?? null, pool: owner?.pool ?? null, bytes, complete: bytes !== null,
      cleanup: 'retain', reason: 'retained job evidence; cleanup eligibility not assessed' });
  }
  artifactsComplete &&= artifacts.length <= 10_000;
  const rows = [...entries.values()].sort((a, b) =>
    (b.bytes ?? -1) - (a.bytes ?? -1) || a.path.localeCompare(b.path));
  const categories = (['worktree', 'job-artifact'] as const).map(kind => {
    const selected = rows.filter(row => row.kind === kind);
    const complete = (kind === 'worktree'
      ? census.sources.worktrees === 'healthy' && census.sources.runsWorktrees === 'healthy'
      : artifactsComplete) && selected.every(row => row.complete && row.bytes !== null);
    const measuredBytes = selected.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
    return { kind, count: selected.length, bytes: complete ? measuredBytes : null, measuredBytes, complete };
  });
  const report = { schema: 'fleet.disk-attribution.v1' as const, readOnly: true as const,
    sources: { ...census.sources, artifacts: artifactsComplete ? 'healthy' as const : 'unavailable' as const },
    categories, entries: rows, cleanupCandidates: rows.filter(row => row.cleanup === 'candidate').slice(0, 10) };
  return sanitizePublicJson(report) as typeof report;
}

export type FleetDiskAttribution = Awaited<ReturnType<typeof readFleetDiskAttribution>>;

export function formatFleetDiskAttribution(disk: FleetDiskAttribution): string[] {
  const size = (bytes: number | null) => bytes === null ? 'unknown' : `${(bytes / 1e9).toFixed(2)} GB`;
  return ['Disk use (read-only, logical bytes):',
    ...disk.categories.map(c => `  ${c.kind === 'worktree' ? 'Worktrees' : 'Job artifacts'}: ${size(c.bytes)}${c.complete ? '' : ` (measured at least ${size(c.measuredBytes)})`}`),
    `  Largest safe cleanup candidates: ${disk.cleanupCandidates.length || 'none proven'}`,
    ...disk.cleanupCandidates.map(c => `    ${c.job}: ${size(c.bytes)} — ${c.path} (${c.reason})`),
    '  Inspect details: phm fleet status --json'];
}
