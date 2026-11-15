import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lintQueue } from '../core/queue/lint.js';

const usage = 'Usage: ashlr fleet queue-lint [--json]';

function dispatcherInvalidCount(status: string): number | null {
  try {
    const parsed: unknown = JSON.parse(status);
    const count = parsed !== null && typeof parsed === 'object' && 'invalid_queue_lines' in parsed ? parsed.invalid_queue_lines : undefined;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

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
    const errors: string[] = [];
    const status = await readFile(join(runs, 'queue', 'status.json'), 'utf8').catch(() => null);
    const invalidQueueLines = status === null ? null : dispatcherInvalidCount(status);
    if (invalidQueueLines === null) errors.push('Dispatcher count unavailable');
    const full = { ...report, invalid_queue_lines: invalidQueueLines, errors };
    if (args.includes('--json')) out(JSON.stringify(full));
    else {
      for (const [label, rows] of Object.entries({ 'Missing READY field': report.missingFields, 'Earlier claim or completion': report.duplicates, 'Invalid dispatcher row': report.invalid, 'Older than 2 hours': report.old, 'Unknown age': report.unknownAge })) {
        for (const row of rows) out(`${label}: line ${row.line}, ${row.id ?? 'unknown id'}: ${row.reason}`);
      }
      out(`Dispatcher invalid lines: ${invalidQueueLines ?? 'unknown'}`);
      for (const message of errors) out(message);
      if (!report.missingFields.length && !report.duplicates.length && !report.invalid.length && !report.old.length && !report.unknownAge.length && invalidQueueLines === 0 && errors.length === 0) out('No queue issues found.');
    }
    return errors.length ? 1 : 0;
  } catch {
    const message = 'Unable to read queue files';
    error(args.includes('--json') ? JSON.stringify({ schema: 'queue.lint.error.v1', error: message }) : message);
    return 1;
  }
}
