import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import type { DirtyLandedReport } from './fleet-dirty-landed.js';
import { cmdFleetDirtyLanded } from './fleet-dirty-landed.js';
import { recutDropJob } from '../core/fleet/recut-drop-body.js';
import { countQueuedDropJobPrompts, DROP_JOB_QUEUE_LIMIT, DropJobExistsError, dropJobExists,
  resolveDropJobRoot, validateDropJob, writeDropJob } from '../core/fleet/drop-job-writer.js';

const USAGE = 'Usage: ashlr fleet recut-sweep [--json] [--apply] [--runs-dir <abs>] [--limit N]';
export interface FleetRecutSweepDeps {
  gh?: CloudGh;
  remote?: string;
  now?: () => number;
  output?: (text: string) => void;
  error?: (text: string) => void;
  dropRoot?: string;
}

export async function cmdFleetRecutSweep(args: string[], deps: FleetRecutSweepDeps = {}): Promise<number> {
  const output = deps.output ?? console.log, error = deps.error ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { output(USAGE); return 0; }
  let json = false, apply = false, runsDir: string | undefined, limit = 2;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--apply') apply = true;
    else if (arg === '--runs-dir' && isAbsolute(args[i + 1] ?? '')) runsDir = args[++i];
    else if (arg === '--limit' && /^\d+$/.test(args[i + 1] ?? '')) {
      limit = Number(args[++i]);
      if (!Number.isSafeInteger(limit) || limit > 5) { error(USAGE); return 2; }
    } else { error(USAGE); return 2; }
  }
  const result = { v: 1, inspected: 0, candidates: 0, planned: [] as { pr: number; id: string; remainingPaths: string[] }[],
    written: 0, skipped: [] as { pr: number; reason: string }[], error: undefined as string | undefined };
  const finish = (code: number, message?: string) => {
    if (message) result.error = message;
    output(json ? JSON.stringify(result) : `recut-sweep: ${JSON.stringify(result)}`);
    return code;
  };
  try {
    let text = '';
    const code = await cmdFleetDirtyLanded(['--json'], { ...deps, output: t => { text = t; },
      now: () => new Date((deps.now ?? Date.now)()) });
    if (code !== 0) return finish(1, 'dirty-landed report unreadable');
    const report = JSON.parse(text) as DirtyLandedReport;
    if (report.schema !== 'fleet.dirty-landed.v1' || !Array.isArray(report.prs)) return finish(1, 'dirty-landed report unreadable');
    result.inspected = report.prs.length;
    const root = resolveDropJobRoot(runsDir), dropRoot = resolveDropJobRoot(deps.dropRoot ?? root);
    const ledger = join(root, 'queue', 'recut-sweep.jsonl');
    let history = '';
    try { history = await readFile(ledger, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const recut = new Set(history.split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line) as { pr: number; headSha: string };
      if (!Number.isSafeInteger(row.pr) || !/^[a-f0-9]{40}$/.test(row.headSha)) throw new Error('ledger');
      return `${row.pr}:${row.headSha}`;
    }));
    const now = (deps.now ?? Date.now)();
    for (const pr of [...report.prs].sort((a, b) => a.number - b.number)) {
      const job = recutDropJob(pr, now);
      const skip = (reason: string) => result.skipped.push({ pr: pr.number, reason });
      if ('reason' in job) { skip(job.reason); continue; }
      result.candidates++;
      if (recut.has(`${pr.number}:${pr.head}`)) { skip('already-recut'); continue; }
      if (result.planned.length >= limit) continue;
      result.planned.push({ pr: pr.number, id: job.id, remainingPaths: pr.remainingPaths });
      if (!apply) continue;
      if (!validateDropJob(job).ok) { skip('invalid'); continue; }
      if (await dropJobExists(dropRoot, job.id)) { skip('exists'); continue; }
      if (await countQueuedDropJobPrompts(dropRoot) >= DROP_JOB_QUEUE_LIMIT) { skip('full'); break; }
      await mkdir(join(root, 'queue'), { recursive: true });
      try { await writeDropJob(dropRoot, job, () => new Date(now)); }
      catch (e) { if (e instanceof DropJobExistsError) { skip('exists'); continue; } throw e; }
      result.written++;
      await appendFile(ledger, `${JSON.stringify({ at: new Date(now).toISOString(), pr: pr.number, headSha: pr.head, id: job.id })}\n`, { mode: 0o600 });
    }
    return finish(0);
  } catch { return finish(1, 'recut-sweep read or write failed'); }
}
