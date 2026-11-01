import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { graphArgvRun } from './graph-argv-run.js';

type Row = { id: string; status: string; exitCode: number | null };
type Task = { id: string; dependsOn?: string[]; argv: string[] };
type Result = { status: string; nodes: Row[]; retained: string[]; retried: string[] };
const invalid = (): Result => ({ status: 'invalid', nodes: [], retained: [], retried: [] });
const limit = 262144;
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
function existing(file: string): string | null {
  try { lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return read(file);
}
function validRows(value: unknown, digest: string, order: string[], tasks: Task[]): Row[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid checkpoint');
  const doc = value as Record<string, unknown>;
  if (Object.keys(doc).sort().join(',') !== 'digest,nodes,version' || doc.version !== 1 || doc.digest !== digest ||
    !Array.isArray(doc.nodes) || doc.nodes.length !== order.length) throw Error('invalid checkpoint');
  const rows = doc.nodes as Row[];
  const allowed = ['success', 'failed', 'blocked', 'cancelled', 'timeout', 'refused'];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'exitCode,id,status' ||
      !order.includes(row.id) || !allowed.includes(row.status) ||
      !(row.exitCode === null || (Number.isInteger(row.exitCode) && row.exitCode >= 0 && row.exitCode <= 255)) ||
      (row.status === 'success' && row.exitCode !== 0) || (row.status === 'failed' && row.exitCode === 0) ||
      (['blocked', 'refused'].includes(row.status) && row.exitCode !== null)) throw Error('invalid row');
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  if (byId.size !== order.length || tasks.some(task => byId.get(task.id)?.status === 'success' &&
    (task.dependsOn ?? []).some(id => byId.get(id)?.status !== 'success'))) throw Error('inconsistent checkpoint');
  return order.map(id => byId.get(id)!);
}

/** Checkpoints coordinate local retries; they do not grant permission to launch work. */
export async function graphResumeRun(file: string, checkpoint: string, apply = false, timeoutMs = 900000, concurrency = 1): Promise<Result> {
  let fd: number | undefined, lock = '', lockIdentity: ReturnType<typeof fstatSync> | undefined, scratch = '', started = false;
  try {
    if (!isAbsolute(file) || !isAbsolute(checkpoint)) return invalid();
    const target = join(realpathSync(dirname(checkpoint)), basename(checkpoint));
    const source = join(realpathSync(dirname(file)), basename(file));
    if (source === target || source === `${target}.lock`) return invalid();
    if (apply) {
      lock = `${target}.lock`;
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      lockIdentity = fstatSync(fd);
      if (!assurePrivateStoragePath(lock, 'file', 'secure-created', { anchorPath: dirname(lock) }).ok) throw Error('unsafe lock');
    }
    const manifest = read(file);
    const plan = await graphArgvRun(file, false, timeoutMs, concurrency);
    if (plan.status !== 'preview' || read(file) !== manifest) return invalid();
    const tasks = (JSON.parse(manifest) as { tasks: Task[] }).tasks;
    const digest = createHash('sha256').update(manifest, 'utf8').digest('hex');
    const order = plan.nodes.map(row => row.id);
    const initial = existing(target);
    const rows = initial === null ? [] : validRows(JSON.parse(initial), digest, order, tasks);
    const retained = rows.filter(row => row.status === 'success').map(row => row.id);
    const done = new Set(retained);
    const retried = order.filter(id => !done.has(id));
    if (!apply) return { status: 'preview', nodes: plan.nodes.map(row => done.has(row.id) ? rows.find(r => r.id === row.id)! : row), retained, retried };
    if (!retried.length && initial !== null) return { status: 'complete', nodes: rows, retained, retried };
    scratch = mkdtempSync(join(tmpdir(), 'ashlr-graph-resume-'));
    const reduced = join(scratch, 'graph.json');
    const retryTasks = tasks.filter(task => !done.has(task.id)).map(task => ({ ...task,
      ...(task.dependsOn ? { dependsOn: task.dependsOn.filter(id => !done.has(id)) } : {}) }));
    writePrivateFileAtomically(join(scratch, 'graph.tmp'), reduced, JSON.stringify({ version: 1, tasks: retryTasks }), { anchorPath: scratch, label: 'reduced graph' });
    started = true;
    // Persist a full-schema checkpoint as each node settles so an interrupted
    // run keeps completed work: retained successes plus every settled row, with
    // unfinished nodes written as 'cancelled' so validRows accepts the document
    // while only successes are retained on the next resume. `lastCheckpoint`
    // tracks the bytes this invocation published so its own writes are not
    // mistaken for an outside edit; a real replacement refuses the write.
    const settled = new Map<string, Row>(rows.filter(row => done.has(row.id)).map(row => [row.id, row]));
    let lastCheckpoint = initial, persistFailed = false;
    const checkpointNow = (): void => {
      if (existing(target) !== lastCheckpoint || read(file) !== manifest) throw Error('checkpoint changed');
      const nodes = order.map(id => settled.get(id) ?? { id, status: 'cancelled', exitCode: null });
      const text = `${JSON.stringify({ version: 1, digest, nodes })}\n`;
      writePrivateFileAtomically(join(dirname(target), `.${basename(target)}.${randomBytes(16).toString('hex')}.tmp`), target,
        text, { anchorPath: dirname(target), label: 'checkpoint' });
      lastCheckpoint = text;
    };
    const run = await graphArgvRun(reduced, true, timeoutMs, concurrency, {
      onNodeTerminal: row => {
        settled.set(row.id, row);
        try { checkpointNow(); } catch (error) { persistFailed = true; throw error; }
      },
    });
    if (!['complete', 'failed'].includes(run.status)) return invalid();
    const combined = new Map([...rows.filter(row => done.has(row.id)), ...run.nodes].map(row => [row.id, row]));
    const nodes = order.map(id => combined.get(id)!);
    if (existing(target) !== lastCheckpoint || read(file) !== manifest) return { status: 'failed', nodes, retained, retried };
    if (lastCheckpoint !== `${JSON.stringify({ version: 1, digest, nodes })}\n`) checkpointNow();
    return { status: persistFailed ? 'failed' : run.status, nodes, retained, retried };
  } catch { return started ? { status: 'failed', nodes: [], retained: [], retried: [] } : invalid(); }
  finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (fd !== undefined) {
      try {
        const named = lstatSync(lock);
        if (lockIdentity && named.dev === lockIdentity.dev && named.ino === lockIdentity.ino) unlinkSync(lock);
      } catch { /* Do not remove a replaced lock. */ } finally { closeSync(fd); }
    }
  }
}
