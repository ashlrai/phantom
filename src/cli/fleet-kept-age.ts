import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseKeptWorktrees } from './fleet-kept.js';

export interface KeptAgeRow { id: string; ageHours: number | null; exists: boolean | null }
export interface KeptAgeReport {
  schema: 'fleet.kept-age.v1';
  worktrees: KeptAgeRow[];
  totals: { under6h: number; from6to24h: number; over24h: number; unknown: number };
}
export interface KeptAgeOptions { runsDir?: string; wtDir?: string; now?: number }

/** Read queue evidence only; missing or inaccessible evidence remains unknown. */
export async function readFleetKeptAge(options: KeptAgeOptions = {}): Promise<KeptAgeReport> {
  const runs = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const wt = options.wtDir ?? process.env.ASHLR_WT_DIR ?? join(homedir(), 'Projects/ashlrai/wt');
  const now = options.now ?? Date.now();
  const ids = parseKeptWorktrees(await readFile(join(runs, 'queue/status.json'), 'utf8'));
  const worktrees = await Promise.all(ids.map(async id => {
    let ageHours: number | null = null;
    let exists: boolean | null = null;
    try {
      const mtime = (await stat(join(runs, `${id}.base`))).mtimeMs;
      if (Number.isFinite(mtime) && mtime <= now) ageHours = (now - mtime) / 3_600_000;
    } catch { /* Age is unknown when the marker cannot be read. */ }
    try { exists = (await stat(join(wt, id))).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false; }
    return { id, ageHours, exists };
  }));
  worktrees.sort((a, b) => (b.ageHours ?? -1) - (a.ageHours ?? -1) || a.id.localeCompare(b.id));
  const totals = { under6h: 0, from6to24h: 0, over24h: 0, unknown: 0 };
  for (const row of worktrees) {
    if (row.ageHours === null) totals.unknown++;
    else if (row.ageHours < 6) totals.under6h++;
    else if (row.ageHours <= 24) totals.from6to24h++;
    else totals.over24h++;
  }
  return { schema: 'fleet.kept-age.v1', worktrees, totals };
}

const usage = 'Usage: ashlr fleet kept-age [--json]\nList kept worktrees oldest first, using .base modification times. Exactly 6 and 24 hours are in the 6–24 hour band. Missing evidence is unknown.';
export async function cmdFleetKeptAge(args: string[], options: KeptAgeOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  try {
    const report = await readFleetKeptAge(options);
    console.log(args.includes('--json') ? JSON.stringify(report) : [
      ...report.worktrees.map(row => `${row.id}: ${row.ageHours === null ? 'unknown age' : `${row.ageHours.toFixed(1)} hours`}; worktree ${row.exists === null ? 'unknown' : row.exists ? 'exists' : 'missing'}`),
      `Under 6 hours: ${report.totals.under6h}; 6–24 hours: ${report.totals.from6to24h}; over 24 hours: ${report.totals.over24h}; unknown age: ${report.totals.unknown}`,
    ].join('\n'));
    return 0;
  } catch {
    console.error('fleet kept-age: unable to read kept worktree status');
    return 1;
  }
}
