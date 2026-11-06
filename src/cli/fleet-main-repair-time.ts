/**
 * Read-only: how long did each guardian FIXUP-MAIN repair take?
 * Matches guardian enqueue rows to job finish rows (both JSONL) by job id.
 *   enqueue: {"event":"enqueue","kind":"FIXUP-MAIN","job":"RQ-1","repo":"o/r","at":"<ISO>"}
 *   finish:  {"event":"finish","job":"RQ-1","at":"<ISO>"}
 * A source that cannot be read leaves the answer "unknown"; it is never guessed.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = 'ashlr fleet main-repair-time [--guardian <file>] [--finish <file>] [--json]';
const home = (): string => process.env.ASHLR_HOME || join(homedir(), '.ashlr');

type Output = { log: (message: string) => void; error: (message: string) => void };
export interface FleetMainRepairTimeDeps { now?: () => Date; output?: Output; readFile?: (path: string) => string }
export type RepairStatus = 'finished' | 'open' | 'unknown';
export interface RepairRow { job: string; repo: string; status: RepairStatus; elapsedMinutes: number | null; enqueuedAt: string; finishedAt: string | null }
export interface SourceState { path: string; status: 'read' | 'unread'; rows: number }
export interface MainRepairTimeReport { v: 1; collectedAt: string; sources: { guardian: SourceState; finish: SourceState }; repairs: RepairRow[] }

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const time = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

function readRows(path: string, readFile: (p: string) => string): Record<string, unknown>[] | null {
  let raw: string;
  try { raw = readFile(path); } catch { return null; }
  const rows: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row as Record<string, unknown>);
    } catch { /* a torn line is skipped, not fatal */ }
  }
  return rows;
}

export function buildMainRepairTime(guardian: Record<string, unknown>[] | null, finish: Record<string, unknown>[] | null,
  now: Date, paths = { guardian: '', finish: '' }): MainRepairTimeReport {
  const finishedAt = new Map<string, string>();
  for (const r of finish ?? []) {
    // Earliest finish wins; reruns of the same job id do not move it.
    if (r.event === 'finish' && text(r.job) && time(r.at) && !(finishedAt.has(r.job) && Date.parse(finishedAt.get(r.job)!) <= Date.parse(r.at))) finishedAt.set(r.job, r.at);
  }
  const seen = new Set<string>();
  const repairs: RepairRow[] = [];
  for (const r of guardian ?? []) {
    if (r.event !== 'enqueue' || r.kind !== 'FIXUP-MAIN' || !text(r.job) || !text(r.repo) || !time(r.at) || seen.has(r.job)) continue;
    seen.add(r.job);
    const end = finish === null ? null : finishedAt.get(r.job) ?? now.toISOString();
    const status: RepairStatus = end === null ? 'unknown' : finishedAt.has(r.job) ? 'finished' : 'open';
    const minutes = end === null ? null : Math.round((Date.parse(end) - Date.parse(r.at)) / 600) / 100;
    repairs.push({ job: r.job, repo: r.repo, status, elapsedMinutes: minutes !== null && minutes >= 0 ? minutes : null,
      enqueuedAt: r.at, finishedAt: status === 'finished' ? end : null });
  }
  repairs.sort((a, b) => Date.parse(a.enqueuedAt) - Date.parse(b.enqueuedAt) || a.job.localeCompare(b.job));
  return { v: 1, collectedAt: now.toISOString(), repairs, sources: {
    guardian: { path: paths.guardian, status: guardian ? 'read' : 'unread', rows: guardian?.length ?? 0 },
    finish: { path: paths.finish, status: finish ? 'read' : 'unread', rows: finish?.length ?? 0 } } };
}

export async function cmdFleetMainRepairTime(args: string[], deps: FleetMainRepairTimeDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  let guardian = join(home(), 'guardian.jsonl');
  let finish = join(home(), 'jobs-finished.jsonl');
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output.error(`error: duplicate option\nusage: ${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--guardian' || arg === '--finish') {
      const value = args[++i];
      if (!value) { output.error(`error: ${arg} needs a file\nusage: ${USAGE}`); return 2; }
      if (arg === '--guardian') guardian = value; else finish = value;
    } else if (arg === '--json') json = true;
    else { output.error(`error: invalid argument\nusage: ${USAGE}`); return 2; }
  }
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const report = buildMainRepairTime(readRows(guardian, readFile), readRows(finish, readFile),
    (deps.now ?? (() => new Date()))(), { guardian, finish });
  if (json) output.log(JSON.stringify(report));
  else {
    for (const r of report.repairs) output.log(`${r.repo}\t${r.status}\t${r.elapsedMinutes ?? 'unknown'} min\t${r.job}`);
    for (const [name, s] of Object.entries(report.sources)) if (s.status === 'unread') output.error(`unread ${name} source: ${s.path}`);
    if (!report.repairs.length && report.sources.guardian.status === 'read') output.log('no FIXUP-MAIN repairs found');
  }
  return report.sources.guardian.status === 'read' && report.sources.finish.status === 'read' ? 0 : 1;
}
