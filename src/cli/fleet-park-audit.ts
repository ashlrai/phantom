import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseParkedState, readSource, type Source } from '../core/fleet/runs-parked-queue.js';
import { scrubSecrets } from '../core/util/scrub.js';

export interface ParkAuditEntry { job: string; reason: string; modifiedAt: string }
export interface ParkAudit {
  version: 1;
  source: Source;
  parked: number | null;
  reasons: Array<{ reason: string; count: number }>;
  oldest: ParkAuditEntry[];
  unknownAge: number | null;
  malformed: number;
}

const JOB = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const usage = 'Usage: phm fleet park-audit [--json]\nCount parked jobs by reason and show the 10 oldest prompt files. Reads ASHLR_RUNS_DIR/queue/ready.tsv (default ~/.ashlr-runs).';

/** Read the queue without exposing prompt paths or contents. Unknown ages are counted separately. */
export async function readParkAudit(runsDir = process.env['ASHLR_RUNS_DIR'] || join(homedir(), '.ashlr-runs')): Promise<ParkAudit> {
  const source = await readSource(join(runsDir, 'queue', 'ready.tsv'), 2 * 1024 * 1024, false);
  const result: ParkAudit = { version: 1, source: source.state, parked: source.state === 'healthy' ? 0 : null,
    reasons: [], oldest: [], unknownAge: source.state === 'healthy' ? 0 : null, malformed: 0 };
  if (source.state !== 'healthy') return result;
  const counts = new Map<string, number>();
  const aged: ParkAuditEntry[] = [];
  let header: string[] | undefined;
  for (const line of source.text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const cells = line.split('\t').map(cell => cell.trim());
    const names = cells.map(cell => cell.toLowerCase().replace(/[^a-z]/g, ''));
    if (names.some(n => n === 'status' || n === 'state') && names.some(n => /^(id|job|jobid)$/.test(n))) {
      header = names; continue;
    }
    const first = parseParkedState(cells[0] ?? '');
    const third = parseParkedState(cells[2] ?? '');
    let state = first.parked ? first : third;
    let job = first.parked ? cells[1] : cells[0];
    let prompt = first.parked ? cells[5] : cells[4];
    if (!state.parked && header) {
      const statusIndex = header.findIndex(n => /^(status|state|pool|lane)$/.test(n) && parseParkedState(cells[header!.indexOf(n)] ?? '').parked);
      if (statusIndex >= 0) {
        state = parseParkedState(cells[statusIndex] ?? '');
        job = cells[header.findIndex(n => /^(id|job|jobid)$/.test(n))];
        prompt = cells[header.findIndex(n => /^(prompt|promptpath|path)$/.test(n))];
      }
    }
    if (!state.parked) continue;
    if (!job || !JOB.test(job)) { result.malformed++; result.source = 'degraded'; continue; }
    const reason = scrubSecrets(state.reason!);
    result.parked!++;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    try {
      if (!prompt) throw new Error('missing prompt');
      const info = await lstat(isAbsolute(prompt) ? prompt : join(runsDir, 'queue', prompt));
      if (!info.isFile() || !Number.isFinite(info.mtimeMs)) throw new Error('invalid prompt');
      aged.push({ job: scrubSecrets(job), reason, modifiedAt: info.mtime.toISOString() });
    } catch { result.unknownAge!++; }
  }
  result.reasons = [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  result.oldest = aged.sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt) || a.job.localeCompare(b.job) || a.reason.localeCompare(b.reason)).slice(0, 10);
  return result;
}

export async function cmdFleetParkAudit(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const report = await readParkAudit();
  if (args[0] === '--json') console.log(JSON.stringify(report));
  else if (report.parked === null) console.log(`Queue ${report.source}; parked jobs are unknown.`);
  else {
    const lines = [`Parked jobs: ${report.parked}${report.source === 'degraded' ? ' (incomplete queue)' : ''}`];
    for (const reason of report.reasons) lines.push(`${reason.reason}: ${reason.count}`);
    lines.push('Oldest prompt files:');
    if (!report.oldest.length) lines.push('  None with a known modification time.');
    for (const entry of report.oldest) lines.push(`  ${entry.modifiedAt}  ${entry.job}  ${entry.reason}`);
    if (report.unknownAge) lines.push(`Unknown prompt age: ${report.unknownAge}`);
    console.log(lines.join('\n'));
  }
  return report.source === 'healthy' ? 0 : 1;
}
