import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { graphArgvRun } from './graph-argv-run.js';

type Row = { id: string; status: string; exitCode: number | null };
type Task = { id: string; dependsOn?: string[]; argv: string[]; cwd?: string };
/** ids only: the report never echoes argv, cwd or raw child output. */
export interface GraphTargetResult {
  status: string;
  target: string;
  selected: string[];
  skipped: string[];
  nodes: Row[];
}
const limit = 262144;
const result = (status: string, target: string, selected: string[] = [], skipped: string[] = [], nodes: Row[] = []): GraphTargetResult =>
  ({ status, target, selected, skipped, nodes });

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
 * Runs one manifest node plus its transitive dependsOn closure — nothing else.
 * The ORIGINAL manifest is fully validated by a `graphArgvRun` preview before
 * any selection, and selection is computed only from bytes proven stable across
 * that validation, so an invalid unrelated branch or a changing source launches
 * nothing. --apply writes a private reduced manifest carrying the selected task
 * objects verbatim and delegates the single real run to `graphArgvRun`, keeping
 * control switches, cancellation and the shared deadline with the executor.
 */
export async function graphTargetRun(file: string, target: string, apply = false, timeoutMs = 900000, concurrency = 1): Promise<GraphTargetResult> {
  if (!isAbsolute(file) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) return result('invalid', target);
  let manifest: string;
  try { manifest = read(file); } catch { return result('invalid', target); }
  const plan = await graphArgvRun(file, false, timeoutMs, concurrency);
  if (plan.status !== 'preview') return result('invalid', target);
  try { if (read(file) !== manifest) return result('unstable', target); }
  catch { return result('unstable', target); }
  let tasks: Task[];
  try {
    const parsed = JSON.parse(manifest) as { tasks?: unknown };
    if (!Array.isArray(parsed.tasks)) throw Error();
    tasks = parsed.tasks as Task[];
  } catch { return result('unstable', target); }
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (!byId.has(target)) return result('invalid-target', target);
  // Transitive dependsOn closure. The reduced manifest keeps the original task
  // objects in original order, so argv, cwd and dependency order are exact.
  const wanted = new Set([target]);
  const queue = [target];
  for (let i = 0; i < queue.length; i++) {
    for (const dependency of byId.get(queue[i]!)?.dependsOn ?? []) {
      if (!wanted.has(dependency)) { wanted.add(dependency); queue.push(dependency); }
    }
  }
  const selected = tasks.filter(task => wanted.has(task.id));
  const selectedIds = selected.map(task => task.id);
  const skipped = tasks.filter(task => !wanted.has(task.id)).map(task => task.id);
  if (!apply) return result('preview', target, selectedIds, skipped,
    selectedIds.map(id => ({ id, status: 'planned', exitCode: null })));
  let scratch = '';
  try {
    scratch = mkdtempSync(join(tmpdir(), 'ashlr-graph-target-'));
    const reduced = join(scratch, 'graph.json');
    writePrivateFileAtomically(join(scratch, 'graph.tmp'), reduced,
      JSON.stringify({ version: 1, tasks: selected }), { anchorPath: scratch, label: 'reduced graph' });
    const run = await graphArgvRun(reduced, true, timeoutMs, concurrency);
    return result(run.status, target, selectedIds, skipped, run.nodes);
  } catch { return result('failed', target, selectedIds, skipped); }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}
