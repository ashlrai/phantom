/** Read-only: finished work that never became a pull request, plus unfinished run markers on explicitly idle lanes. */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readStrandedWork, strandedWorkText, STRANDED_DEFAULT_DAYS, STRANDED_MAX_DAYS, type StrandedWorkReport } from '../core/fleet/stranded-work.js';

export interface StrandedRun { id: string; lane: string; ageMinutes: number }
export interface StrandedReport { v: 1; minutes: number; runs: StrandedRun[] }
/** What `--json` prints: the run markers and the finished-work report in one object. */
export type StrandedCliReport = StrandedReport & StrandedWorkReport;
export interface StrandedOptions { runsDir?: string; now?: number; checkoutRoot?: string }

const usage = 'Usage: ashlr fleet stranded [--days N] [--verify] [--minutes N] [--json]\n'
  + `Find finished work that never became a pull request: kept worktrees whose job finished with changes in the last N days (default ${STRANDED_DEFAULT_DAYS}, up to ${STRANDED_MAX_DAYS}) `
  + 'and whose publish step stopped. Each item has a cause (abort after push, gate stop, abort other, unknown) and one next step. '
  + '--verify also compares each pushed branch with the local main branch (read-only git, no network) and marks work that is already on main.\n'
  + 'Also lists unfinished runs older than --minutes N (default 90) on lanes reporting running 0, oldest first. '
  + 'Age uses the .line modification time. N must be a finite nonnegative number. Read-only.';

export async function readFleetStranded(options: StrandedOptions = {}, minutes = 90): Promise<StrandedReport> {
  const root = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const runDir = join(root, 'queue', 'run');
  const status = JSON.parse(await readFile(join(root, 'queue', 'status.json'), 'utf8')) as { lanes?: Record<string, { running?: unknown } | null> } | null;
  if (!status?.lanes || typeof status.lanes !== 'object' || Array.isArray(status.lanes)) throw new Error('invalid lane status');
  const now = options.now ?? Date.now();
  const names = await readdir(runDir);
  const rows = await Promise.all(names.filter(name => name.endsWith('.line') && name.length > 5).map(async name => {
    const path = join(runDir, name);
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { id: name.slice(0, -5), lane: content.split('\t')[2]?.trim() ?? '', ageMinutes: (now - info.mtimeMs) / 60_000 };
  }));
  // Recheck completion after reading the run markers to narrow the scan race.
  const finished = new Set((await readdir(runDir)).filter(name => name.endsWith('.fin')).map(name => name.slice(0, -4)));
  const runs = rows.filter(row => row.lane && Number.isFinite(row.ageMinutes) && row.ageMinutes > minutes
    && !finished.has(row.id) && Object.hasOwn(status.lanes!, row.lane) && status.lanes![row.lane]?.running === 0)
    .sort((a, b) => b.ageMinutes - a.ageMinutes || a.id.localeCompare(b.id));
  return { v: 1, minutes, runs };
}

export async function cmdFleetStranded(args: string[], options: StrandedOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let minutes = 90, days = STRANDED_DEFAULT_DAYS, json = false, verify = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!['--minutes', '--days', '--verify', '--json'].includes(flag) || seen.has(flag)) { console.error(usage); return 2; }
    seen.add(flag);
    if (flag === '--json') { json = true; continue; }
    if (flag === '--verify') { verify = true; continue; }
    const raw = args[++i];
    if (flag === '--days') {
      if (raw === undefined || !/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > STRANDED_MAX_DAYS) { console.error(usage); return 2; }
      days = Number(raw); continue;
    }
    if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) { console.error(usage); return 2; }
    minutes = Number(raw);
  }
  try {
    const report = await readFleetStranded(options, minutes);
    const work = await readStrandedWork({ days, verify, runsDir: options.runsDir, now: options.now, checkoutRoot: options.checkoutRoot });
    if (json) { console.log(JSON.stringify({ ...report, ...work } satisfies StrandedCliReport)); return 0; }
    for (const line of strandedWorkText(work)) console.log(line);
    if (!report.runs.length) console.log('No stranded runs.');
    else console.log(`Unfinished runs on idle lanes (older than ${minutes} minutes): ${report.runs.length}`);
    for (const run of report.runs) console.log(`${run.id}\t${run.lane}\t${run.ageMinutes.toFixed(1)} min old`);
    return 0;
  } catch { console.error('error: cannot read stranded runs from queue/run and queue/status.json'); return 1; }
}
