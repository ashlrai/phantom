/** Worktree cleanup preview with explicit, bounded removal. */
import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizePublicJson } from '../core/util/public-json.js';

type State = 'merged' | 'empty' | 'open' | 'none';
export interface WtReapReaders {
  listDirs: (path: string) => Promise<string[]>;
  readJobs: (path: string) => Promise<string>;
}
export interface WtReapDeps {
  readers?: WtReapReaders;
  runner?: (file: string, args: string[]) => Promise<void>;
  runsRoot?: string;
  now?: number;
  output?: { log: (text: string) => void; error: (text: string) => void };
}
export interface WtReapReport {
  schema: 'fleet.wt-reap.v1';
  readOnly: boolean;
  removals?: Array<{ id: string; status: 'removed' | 'refused' | 'failed' }>;
  sources: { worktrees: boolean; jobs: boolean };
  worktrees: Array<{ id: string; ageHours: number | null; state: State; reapable: boolean }>;
  totals: Record<State | 'worktrees' | 'reapable', number>;
}
const defaults: WtReapReaders = {
  listDirs: async path => (await readdir(path, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name),
  readJobs: path => readFile(path, 'utf8'),
};
const usage = 'Usage: ashlr fleet wt-reap [--apply] [--json]';

/** Folder names are job ids. Last means last recorded row in the append-only log.
 * Age is time since the last finish, without rounding across the one-hour boundary.
 * An outcome takes precedence over an empty finish, so open work stays protected.
 */
export async function readFleetWtReap(deps: WtReapDeps = {}): Promise<WtReapReport> {
  const root = deps.runsRoot ?? join(homedir(), '.ashlr-runs');
  const readers = deps.readers ?? defaults;
  const [dirs, jobs] = await Promise.allSettled([
    readers.listDirs(join(root, 'wt')), readers.readJobs(join(root, 'metrics', 'jobs.jsonl')),
  ]);
  const latest = new Map<string, { outcome?: Record<string, unknown>; finish?: Record<string, unknown> }>();
  for (const line of (jobs.status === 'fulfilled' ? jobs.value : '').split(/\r?\n/)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown> | null;
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const id = r.job ?? r.job_id ?? r.id;
      if (typeof id !== 'string' || (r.event !== 'outcome' && r.event !== 'finish')) continue;
      const entry = latest.get(id) ?? {};
      entry[r.event] = r;
      latest.set(id, entry);
    } catch { /* Ignore damaged rows; never echo their contents. */ }
  }
  const report: WtReapReport = { schema: 'fleet.wt-reap.v1', readOnly: true,
    sources: { worktrees: dirs.status === 'fulfilled', jobs: jobs.status === 'fulfilled' }, worktrees: [],
    totals: { worktrees: 0, merged: 0, empty: 0, open: 0, none: 0, reapable: 0 } };
  for (const id of (dirs.status === 'fulfilled' ? dirs.value : []).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) { report.sources.worktrees = false; continue; }
    const { outcome, finish } = latest.get(id) ?? {};
    const recorded = String(outcome?.state ?? outcome?.outcome ?? '').toLowerCase();
    const state: State = recorded === 'merged' ? 'merged' : recorded === 'open' ? 'open'
      : !outcome && finish?.empty === true ? 'empty' : 'none';
    const at = typeof finish?.ts === 'string' ? Date.parse(finish.ts) : NaN;
    const ageHours = Number.isFinite(at) ? Math.max(0, ((deps.now ?? Date.now()) - at) / 3_600_000) : null;
    const reapable = (state === 'merged' || state === 'empty') && ageHours !== null && ageHours > 1;
    report.worktrees.push({ id, ageHours, state, reapable });
    report.totals.worktrees++;
    report.totals[state]++;
    if (reapable) report.totals.reapable++;
  }
  return sanitizePublicJson(report) as WtReapReport;
}

export async function cmdFleetWtReap(args: string[], deps: WtReapDeps = {}): Promise<number> {
  const out = deps.output ?? { log: console.log, error: console.error };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    out.log(`${usage}\nList job folders in ~/.ashlr-runs/wt. Age is hours since the last finish.\nMerged or empty jobs older than one hour are reapable. Unknown ages stay protected.\nDry run is the default. Use --apply to remove reapable worktrees with Git.`);
    return 0;
  }
  if (new Set(args).size !== args.length || args.some(arg => !['--json', '--apply'].includes(arg))) { out.error(usage); return 2; }
  const r = await readFleetWtReap(deps);
  if (args.includes('--apply')) {
    r.readOnly = false;
    r.removals = [];
    const wtRoot = resolve(deps.runsRoot ?? join(homedir(), '.ashlr-runs'), 'wt');
    const runner = deps.runner ?? (async (file, argv) => { await promisify(execFile)(file, argv, { timeout: 30_000, maxBuffer: 64 * 1024 }); });
    if (r.sources.worktrees && r.sources.jobs) for (const w of r.worktrees.filter(w => w.reapable)) {
      const path = resolve(wtRoot, w.id);
      try {
        if (dirname(path) !== wtRoot || !(await lstat(path)).isDirectory()
          || dirname(await realpath(path)) !== await realpath(wtRoot)) {
          r.removals.push({ id: w.id, status: 'refused' });
          continue;
        }
      } catch {
        r.removals.push({ id: w.id, status: 'refused' });
        continue;
      }
      try {
        await runner('git', ['-C', path, 'worktree', 'remove', '--', path]);
        r.removals.push({ id: w.id, status: 'removed' });
      } catch { r.removals.push({ id: w.id, status: 'failed' }); }
    }
  }
  if (args.includes('--json')) out.log(JSON.stringify(r));
  else {
    out.log(r.readOnly ? 'Worktree cleanup report. Deletes nothing.' : 'Worktree cleanup results.');
    if (!r.sources.worktrees || !r.sources.jobs) out.log('Some records could not be read.');
    for (const w of r.worktrees) out.log(`${w.id}: ${w.ageHours === null ? 'unknown age' : `${w.ageHours.toFixed(2)} hours old`}, ${w.state}, reapable: ${w.reapable ? 'yes' : 'no'}`);
    for (const removal of r.removals ?? []) out.log(`${removal.id}: ${removal.status}.`);
    out.log(`Totals: ${r.totals.worktrees} worktrees, ${r.totals.merged} merged, ${r.totals.empty} empty, ${r.totals.open} open, ${r.totals.none} none, ${r.totals.reapable} reapable.`);
  }
  return r.sources.worktrees && r.sources.jobs && (r.removals ?? []).every(item => item.status === 'removed') ? 0 : 1;
}
