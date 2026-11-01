import { dirname, isAbsolute } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { taskReadyFrontier } from './task-ready-frontier.js';
import { readRunsSwitches } from './runs-switches.js';
import { runContextWorker, type ContextWorkerIO } from './context-worker-run.js';

type Task = { id: string; dependsOn?: string[]; snapshot: string; prompt: string; argv: string[] };
type Row = { id: string; status: string; exitCode: number | null };
const id = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const path = (s: unknown): s is string => typeof s === 'string' && isAbsolute(s) && !s.includes('\0') && s.length <= 4096;

/**
 * Sequential dependency-graph runner whose nodes launch through the existing
 * context worker: every ready node's literal argv runs with the bounded cited
 * pack on stdin, resolved live at launch time. Validation of the whole
 * manifest happens before any child; a failed prerequisite blocks only its
 * descendants. dependsOn orders execution; the snapshot file owns which
 * upstream jobs are cited — graph data never becomes a command.
 */
export async function graphContextRun(file: string, apply = false, io: ContextWorkerIO = {}): Promise<{ status: string; nodes: Row[] }> {
  let tasks: Task[], order: string[] = [];
  try {
    if (!path(file)) throw Error();
    const read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: 262144, remainingBytes: 262144 });
    if (!read.ok) throw Error();
    const v = JSON.parse(read.text);
    if (v.version !== 1 || Object.keys(v).some(k => !['version', 'tasks'].includes(k)) || !Array.isArray(v.tasks) || v.tasks.length > 32) throw Error();
    tasks = v.tasks;
    for (const t of tasks) {
      if (!t || Object.keys(t).some(k => !['id', 'dependsOn', 'snapshot', 'prompt', 'argv'].includes(k)) || !id(t.id) ||
        !path(t.snapshot) || !path(t.prompt) ||
        !Array.isArray(t.argv) || !t.argv.length || t.argv.length > 128 || !t.argv[0] ||
        t.argv.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 8192) ||
        (t.dependsOn !== undefined && (!Array.isArray(t.dependsOn) || t.dependsOn.length > 32 || !t.dependsOn.every(id)))) throw Error();
    }
    const ids = new Set(tasks.map(t => t.id));
    if (ids.size !== tasks.length || tasks.some(t => t.dependsOn?.some(d => !ids.has(d)))) throw Error();
    while (order.length < tasks.length) {
      const ready = taskReadyFrontier(tasks, order);
      if (!ready.length) throw Error();
      order.push(...ready);
    }
  } catch { return { status: 'invalid', nodes: [] }; }
  if (!apply) return { status: 'preview', nodes: order.map(id => ({ id, status: 'planned', exitCode: null })) };

  // Worker output and diagnostics stay off the JSON result stream.
  const workerIO: ContextWorkerIO = { stdout: io.stderr ?? process.stderr, stderr: io.stderr ?? process.stderr };
  const results = new Map<string, Row>();
  let cancelled = false;
  const cancel = (): void => { cancelled = true; };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    for (const nodeId of order) {
      const task = tasks.find(t => t.id === nodeId)!;
      if (cancelled) { results.set(nodeId, { id: nodeId, status: 'cancelled', exitCode: null }); continue; }
      if ((task.dependsOn ?? []).some(d => results.get(d)?.status !== 'success')) {
        results.set(nodeId, { id: nodeId, status: 'blocked', exitCode: null }); continue;
      }
      const switches = await readRunsSwitches();
      const refused = switches.sourceState === 'degraded' || switches.switches.some(s => s.on && ['ORCH_OFF', 'PAUSE', 'HOLD', 'QUEUE_DISABLE'].includes(s.id));
      // Cancellation must win even when delivered during the asynchronous control read.
      if (cancelled || refused) {
        results.set(nodeId, { id: nodeId, status: cancelled ? 'cancelled' : 'refused', exitCode: null }); continue;
      }
      const exitCode = await runContextWorker({ snapshot: task.snapshot, prompt: task.prompt, argv: task.argv }, workerIO);
      results.set(nodeId, { id: nodeId, status: cancelled ? 'cancelled' : exitCode === 0 ? 'success' : 'failed', exitCode });
    }
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  const nodes = order.map(nodeId => results.get(nodeId)!);
  return { status: nodes.every(n => n.status === 'success') && !cancelled ? 'complete' : 'failed', nodes };
}
