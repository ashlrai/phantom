import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { graphArgvRun } from './graph-argv-run.js';

type Row = { id: string; status: string; exitCode: number | null };
type Task = { id: string; dependsOn?: string[]; argv: string[]; cwd?: string };
/** ids only: the report never echoes argv, cwd or raw child output. */
export interface GraphGoalsResult {
  status: string;
  targets: string[];
  selected: string[];
  skipped: string[];
  nodes: Row[];
}
const limit = 262144;
const result = (status: string, targets: string[], selected: string[] = [], skipped: string[] = [], nodes: Row[] = []): GraphGoalsResult =>
  ({ status, targets, selected, skipped, nodes });

/** Two bounded stable reads plus a raw byte check: a mutating manifest throws. */
function read(file: string): string {
  const value = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: limit, remainingBytes: limit });
  if (!value.ok) throw Error('unsafe file');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw Error('unsafe file');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const again = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: limit, remainingBytes: limit });
    if (!again.ok || again.text !== value.text || !bytes.subarray(0, length).equals(Buffer.from(value.text, 'utf8'))) throw Error('changed file');
    return value.text;
  } finally { closeSync(fd); }
}

/**
 * Runs selected manifest nodes plus their union of transitive dependsOn prerequisites.
 * The ORIGINAL manifest is fully validated by a `graphArgvRun` preview before
 * any selection, and selection is computed only from bytes proven stable across
 * that validation, so an invalid unrelated branch or a changing source launches
 * nothing. --apply writes a private reduced manifest carrying the selected task
 * objects verbatim and delegates the single real run to `graphArgvRun`, keeping
 * control switches, cancellation and the shared deadline with the executor.
 */
export async function graphGoalsRun(file: string, targets: string[], apply = false, timeoutMs = 900000, concurrency = 1): Promise<GraphGoalsResult> {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 32
    || targets.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    || new Set(targets).size !== targets.length) return result('invalid-target', []);
  if (!isAbsolute(file) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) return result('invalid', targets);
  let manifest: string;
  try { manifest = read(file); } catch { return result('invalid', targets); }
  const plan = await graphArgvRun(file, false, timeoutMs, concurrency);
  if (plan.status !== 'preview') return result('invalid', targets);
  try { if (read(file) !== manifest) return result('unstable', targets); }
  catch { return result('unstable', targets); }
  let tasks: Task[];
  try {
    const parsed = JSON.parse(manifest) as { tasks?: unknown };
    if (!Array.isArray(parsed.tasks)) throw Error();
    tasks = parsed.tasks as Task[];
  } catch { return result('unstable', targets); }
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (targets.some(target => !byId.has(target))) return result('invalid-target', targets);
  // Transitive dependsOn closure. The reduced manifest keeps the original task
  // objects in original order, so argv, cwd and dependency order are exact.
  const wanted = new Set(targets);
  const queue = [...targets];
  for (let i = 0; i < queue.length; i++) {
    for (const dependency of byId.get(queue[i]!)?.dependsOn ?? []) {
      if (!wanted.has(dependency)) { wanted.add(dependency); queue.push(dependency); }
    }
  }
  const selected = tasks.filter(task => wanted.has(task.id));
  const selectedIds = selected.map(task => task.id);
  const skipped = tasks.filter(task => !wanted.has(task.id)).map(task => task.id);
  if (!apply) return result('preview', targets, selectedIds, skipped,
    selectedIds.map(id => ({ id, status: 'planned', exitCode: null })));
  let scratch = '';
  try {
    scratch = mkdtempSync(join(tmpdir(), 'ashlr-graph-goals-'));
    const reduced = join(scratch, 'graph.json');
    writePrivateFileAtomically(join(scratch, 'graph.tmp'), reduced,
      JSON.stringify({ version: 1, tasks: selected }), { anchorPath: scratch, label: 'reduced graph' });
    const run = await graphArgvRun(reduced, true, timeoutMs, concurrency);
    return result(run.status, targets, selectedIds, skipped, run.nodes);
  } catch { return result('failed', targets, selectedIds, skipped); }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}
