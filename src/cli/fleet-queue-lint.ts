import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: ashlr fleet queue-lint [--json]\nRead-only check of READY router queue lines and the dispatcher invalid-line count.';
export type QueueLintReader = (path: string) => Promise<string>;
type MissingField = 'id' | 'priority' | 'pool' | 'tier' | 'repo' | 'goal';
export interface QueueLintFailure { line: number; id: string | null; missing: MissingField }

/** Report only identifiers and missing fields, never queue goals or raw status. */
export function lintQueue(text: string): QueueLintFailure[] {
  const failures: QueueLintFailure[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.startsWith('- READY RQ-')) continue;
    const id = /^- READY (RQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?=\s|\(|$)/.exec(line)?.[1] ?? null;
    const metadata = /^- READY [^\s(]*\s*\(([^)]*)\)(.*)$/.exec(line);
    const fields = metadata?.[1]?.split(',').map(field => field.trim()) ?? [];
    const missing: MissingField | undefined = !id ? 'id'
      : !fields.some(field => /^P\d+(?:\s+[^=]*)?$/.test(field)) ? 'priority'
      : !fields.some(field => /^pool=\S+$/.test(field)) ? 'pool'
      : !fields.some(field => /^tier=\S+$/.test(field)) ? 'tier'
      : !fields.some(field => /^repo=\S+$/.test(field)) ? 'repo'
      : !/^\s*:\s*\S/.test(metadata?.[2] ?? '') ? 'goal' : undefined;
    if (missing) failures.push({ line: index + 1, id, missing });
  }
  return failures;
}

export async function cmdFleetQueueLint(args: string[], reader: QueueLintReader = path => readFile(path, 'utf8')): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const root = join(homedir(), '.ashlr-runs', 'queue');
  const errors: string[] = [];
  const [failures, dispatcherCount] = await Promise.all([
    reader(join(root, 'router-queue.md')).then(lintQueue).catch(() => { errors.push('Queue unavailable'); return null; }),
    reader(join(root, 'status.json')).then(text => {
      const status: unknown = JSON.parse(text);
      const count = status !== null && typeof status === 'object' && 'invalid_queue_lines' in status ? status.invalid_queue_lines : undefined;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid count');
      return count;
    }).catch(() => { errors.push('Dispatcher count unavailable'); return null; }),
  ]);
  const report = { schema: 'fleet.queue-lint.v1', readOnly: true, total: failures?.length ?? null,
    invalid_queue_lines: dispatcherCount, failures, errors: errors.sort() };
  console.log(args.includes('--json') ? JSON.stringify(report) : [
    `Invalid READY lines: ${report.total ?? 'unknown'}; dispatcher invalid lines: ${dispatcherCount ?? 'unknown'}`,
    ...(failures ?? []).map(row => `${row.id ?? '(missing id)'} (line ${row.line}): missing ${row.missing}`), ...report.errors,
  ].join('\n'));
  if ((report.total ?? 0) > 0 || (dispatcherCount ?? 0) > 0) console.warn('Warning: invalid queue lines found.');
  return errors.length || (report.total ?? 0) > 0 || (dispatcherCount ?? 0) > 0 ? 1 : 0;
}
