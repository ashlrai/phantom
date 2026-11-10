import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lintQueue } from '../core/queue/lint.js';

const usage = 'Usage: ashlr fleet queue-lint [--json]';
export async function cmdFleetQueueLint(args: string[], deps: { home?: string; runsDir?: string; now?: number; out?: (s: string) => void; error?: (s: string) => void } = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { out(usage); return 0; }
  if (args.some(a => a !== '--json') || args.length > 1) { error(usage); return 2; }
  const home = deps.home ?? homedir();
  const runs = resolve(deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(home, '.ashlr-runs'));
  try {
    const [router, ready] = await Promise.all(['router-queue.md', 'ready.tsv'].map(file => readFile(join(runs, 'queue', file), 'utf8')));
    const report = await lintQueue(router!, ready!, runs, home, deps.now ?? Date.now());
    if (args.includes('--json')) out(JSON.stringify(report));
    else {
      for (const [label, rows] of Object.entries({ 'Earlier claim or completion': report.duplicates, 'Invalid dispatcher row': report.invalid, 'Older than 2 hours': report.old, 'Unknown age': report.unknownAge })) {
        for (const row of rows) out(`${label}: line ${row.line}, ${row.id ?? 'unknown id'}: ${row.reason}`);
      }
      if (!report.duplicates.length && !report.invalid.length && !report.old.length && !report.unknownAge.length) out('No queue issues found.');
    }
    return 0;
  } catch {
    const message = 'Unable to read queue files';
    error(args.includes('--json') ? JSON.stringify({ schema: 'queue.lint.error.v1', error: message }) : message);
    return 1;
  }
}
