import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const usage = 'Usage: ashlr fleet queue-lint [--json]\nRead-only check of READY router queue lines and the dispatcher invalid-line count.';
export type QueueLintReader = (path: string) => Promise<string>;
type MissingField = 'id' | 'priority' | 'pool' | 'tier' | 'repo' | 'goal';
export interface QueueLintFailure { line: number; id: string | null; missing: MissingField }

const READY_PREFIX = /^- READY(?:\s|$)/;
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*/;
const ID_DECOR = /^[*_`[\s]*/;
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;
const PRIORITY_FIELD = /^(?:P\d+|priority\s*=\s*P?\d+)(?:\s+[^=;]*)?$/i;
const ATTR_FIELD = (name: string): RegExp => new RegExp(`^${name}\\s*=\\s*\\S+$`, 'i');

/**
 * First balanced `(...)` group after the id, then `:` and the goal text.
 * `goal` is null when the group closes without a following colon. Returns
 * null only when the header has no balanced field group at all.
 */
function fieldGroupAndGoal(rest: string): { attrs: string; goal: string | null } | null {
  const open = rest.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < rest.length; i++) {
    if (rest[i] === '(') depth++;
    else if (rest[i] === ')') {
      depth--;
      if (depth === 0) {
        const after = rest.slice(i + 1);
        const colon = /^\s*:/.exec(after);
        return { attrs: rest.slice(open + 1, i), goal: colon ? after.slice(colon[0].length).trim() : null };
      }
    }
  }
  return null;
}

/** Report only identifiers and missing fields, never queue goals or raw status. */
export function lintQueue(text: string): QueueLintFailure[] {
  const failures: QueueLintFailure[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!READY_PREFIX.test(line)) continue;
    const afterReady = line.replace(READY_PREFIX, '');
    const rest = afterReady.replace(ID_DECOR, '');
    const idMatch = ID_TOKEN.exec(rest);
    const id = idMatch && VALID_ID.test(idMatch[0]) ? idMatch[0] : null;
    if (!id) { failures.push({ line: index + 1, id, missing: 'id' }); continue; }
    const group = fieldGroupAndGoal(rest.slice(idMatch![0].length));
    const fields = group?.attrs.split(/[,;\n]/).map(field => field.trim()) ?? [];
    const absent: MissingField | undefined = !group ? 'priority'
      : !fields.some(field => PRIORITY_FIELD.test(field)) ? 'priority'
      : !fields.some(field => ATTR_FIELD('pool').test(field)) ? 'pool'
      : !fields.some(field => ATTR_FIELD('tier').test(field)) ? 'tier'
      : !fields.some(field => ATTR_FIELD('repo').test(field)) ? 'repo'
      : !group.goal ? 'goal' : undefined;
    if (absent) failures.push({ line: index + 1, id, missing: absent });
  }
  return failures;
}

export async function cmdFleetQueueLint(args: string[], reader: QueueLintReader = path => readFile(path, 'utf8')): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  const root = join(resolve(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')), 'queue');
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
