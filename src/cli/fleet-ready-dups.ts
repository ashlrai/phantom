import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseMergedJobs } from './fleet-worktrees.js';

const usage = 'Usage: phm fleet ready-dups [--json]\nShow duplicate, missing-prompt and already-merged ready queue rows. Read-only.';
type Reason = 'duplicate' | 'missingPrompt' | 'merged';
interface ReadyRow { line: number; id: string | null; lane: string | null; reasons: Reason[] }
interface Counts { rows: number; duplicate: number; missingPrompt: number; merged: number }
const safe = (value: string): string | null => /^[A-Za-z0-9._-]{1,100}$/.test(value) ? value : null;
const emptyCounts = (): Counts => ({ rows: 0, duplicate: 0, missingPrompt: 0, merged: 0 });

/** Count affected rows, not distinct IDs; a row can have several reasons. */
export async function inspectReadyDups(ready: string, jobs: string, root: string): Promise<{ schema: string; total: Counts; lanes: Record<string, Counts>; rows: ReadyRow[] }> {
  const entries = ready.split(/\r?\n/).flatMap((text, index) => {
    if (!text.trim() || text.trimStart().startsWith('#')) return [];
    const [id = '', , lane = '', , prompt = ''] = text.split('\t');
    if (id === 'id' && lane === 'lane') return [];
    return [{ line: index + 1, id, lane, prompt }];
  });
  const frequencies = new Map<string, number>();
  for (const row of entries) if (row.id) frequencies.set(row.id, (frequencies.get(row.id) ?? 0) + 1);
  // A torn or malformed ledger cannot establish that an ID has no merged outcome.
  for (const line of jobs.split(/\r?\n/)) if (line.trim()) JSON.parse(line);
  const merged = parseMergedJobs(jobs);
  const rows: ReadyRow[] = [];
  const total = emptyCounts();
  const lanes: Record<string, Counts> = Object.create(null) as Record<string, Counts>;
  for (const row of entries) {
    const reasons: Reason[] = [];
    if ((frequencies.get(row.id) ?? 0) > 1) reasons.push('duplicate');
    let missing = !row.prompt;
    if (row.prompt) {
      try { missing = !(await stat(isAbsolute(row.prompt) ? row.prompt : join(root, row.prompt))).isFile(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') missing = true;
        else throw error;
      }
    }
    if (missing) reasons.push('missingPrompt');
    if (merged.has(row.id)) reasons.push('merged');
    if (!reasons.length) continue;
    const lane = safe(row.lane);
    const counts = lanes[lane ?? '(unknown)'] ??= emptyCounts();
    for (const target of [total, counts]) { target.rows++; for (const reason of reasons) target[reason]++; }
    rows.push({ line: row.line, id: safe(row.id), lane, reasons });
  }
  return { schema: 'fleet.ready-dups.v1', total, lanes, rows };
}

export async function cmdFleetReadyDups(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const root = process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs');
  try {
    const [ready, jobs] = await Promise.all([readFile(join(root, 'queue', 'ready.tsv'), 'utf8'), readFile(join(root, 'metrics', 'jobs.jsonl'), 'utf8')]);
    const report = await inspectReadyDups(ready, jobs, root);
    if (args[0] === '--json') console.log(JSON.stringify(report));
    else {
      console.log(`Affected ready rows: ${report.total.rows} (duplicate: ${report.total.duplicate}, missing prompt: ${report.total.missingPrompt}, merged: ${report.total.merged})`);
      for (const [lane, count] of Object.entries(report.lanes)) console.log(`${lane}: ${count.rows} rows (duplicate: ${count.duplicate}, missing prompt: ${count.missingPrompt}, merged: ${count.merged})`);
      for (const row of report.rows) console.log(`line ${row.line}: ${row.id ?? '(invalid id)'} [${row.lane ?? 'unknown'}] ${row.reasons.join(', ')}`);
    }
    return 0;
  } catch {
    console.error('fleet ready-dups: queue, metrics or prompt evidence unavailable');
    return 1;
  }
}
