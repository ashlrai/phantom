import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lintQueue } from '../core/queue/lint.js';

export async function cmdQueueLint(args: string[]): Promise<number> {
  if (args.some(a => a !== '--json') || args.filter(a => a === '--json').length > 1) { console.error('Usage: phm queue lint [--json]'); return 2; }
  const home = homedir();
  const runs = resolve(process.env.ASHLR_RUNS_DIR ?? join(home, '.ashlr-runs'));
  try {
    const [router, ready] = await Promise.all(['router-queue.md', 'ready.tsv'].map(file => readFile(join(runs, 'queue', file), 'utf8')));
    const report = await lintQueue(router!, ready!, runs, home, Date.now());
    if (args.includes('--json')) console.log(JSON.stringify(report));
    else {
      for (const [label, rows] of Object.entries({ 'Earlier claim or completion': report.duplicates, 'Invalid dispatcher row': report.invalid, 'Older than 2 hours': report.old, 'Unknown age': report.unknownAge })) {
        for (const row of rows) console.log(`${label}: line ${row.line}, ${row.id ?? 'unknown id'}: ${row.reason}`);
      }
      if (!report.duplicates.length && !report.invalid.length && !report.old.length && !report.unknownAge.length) console.log('No queue issues found.');
    }
    return 0;
  } catch { console.error('queue lint: unable to read router-queue.md or ready.tsv'); return 1; }
}
