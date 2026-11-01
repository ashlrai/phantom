import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { taskReadyFrontier } from './task-ready-frontier.js';
import { readRunsSwitches } from './runs-switches.js';

type Task = { id: string; dependsOn?: string[]; argv: string[]; cwd?: string };
type Row = { id: string; status: string; exitCode: number | null };
export async function graphArgvRun(file: string, apply = false, timeoutMs = 900000, concurrency = 1): Promise<{ status: string; nodes: Row[] }> {
  let tasks: Task[];
  const order: string[] = [];
  try {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 || !isAbsolute(file) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw Error();
    const read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: 262144, remainingBytes: 262144 });
    if (!read.ok) throw Error();
    const v = JSON.parse(read.text);
    if (v.version !== 1 || Object.keys(v).some(k => !['version', 'tasks'].includes(k)) || !Array.isArray(v.tasks) || v.tasks.length > 32) throw Error();
    tasks = v.tasks;
    const id = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
    for (const t of tasks) {
      if (!t || Object.keys(t).some(k => !['id', 'dependsOn', 'argv', 'cwd'].includes(k)) || !id(t.id) ||
        !Array.isArray(t.argv) || !t.argv.length || t.argv.length > 128 || !t.argv[0] ||
        t.argv.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 8192) ||
        (t.cwd !== undefined && (typeof t.cwd !== 'string' || !t.cwd || t.cwd.includes('\0') || !isAbsolute(t.cwd) || !statSync(t.cwd).isDirectory())) ||
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
  const results = new Map<string, Row>();
  const active = new Map<string, { stop: () => void; done: Promise<void> }>();
  let cancelled = false;
  const cancel = (): void => { cancelled = true; for (const child of active.values()) child.stop(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    while (results.size < order.length) {
      for (const id of order) {
        if (results.has(id) || active.has(id)) continue;
        const task = tasks.find(t => t.id === id)!;
        const dependencies = task.dependsOn ?? [];
        if (cancelled) { results.set(id, { id, status: 'cancelled', exitCode: null }); continue; }
        if (dependencies.some(d => results.has(d) && results.get(d)!.status !== 'success')) {
          results.set(id, { id, status: 'blocked', exitCode: null }); continue;
        }
        if (active.size >= concurrency || dependencies.some(d => !results.has(d))) continue;
        const switches = await readRunsSwitches();
        const refused = switches.sourceState === 'degraded' || switches.switches.some(s => s.on && ['ORCH_OFF', 'PAUSE', 'HOLD', 'QUEUE_DISABLE'].includes(s.id));
        // Cancellation must win even when delivered during the asynchronous control read.
        if (cancelled || refused) {
          results.set(id, { id, status: cancelled ? 'cancelled' : 'refused', exitCode: null }); continue;
        }
        let stop = (): void => {};
        const done = new Promise<Row>(resolve => {
          const child = spawn(task.argv[0]!, task.argv.slice(1), { cwd: task.cwd, shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout.pipe(process.stderr, { end: false }); child.stderr.pipe(process.stderr, { end: false });
          let timedOut = false, failed = false;
          let escalation: ReturnType<typeof setTimeout> | undefined;
          stop = () => { child.kill('SIGTERM'); escalation ??= setTimeout(() => child.kill('SIGKILL'), 250); };
          const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
          child.on('error', () => { failed = true; });
          child.on('close', code => {
            clearTimeout(timer); clearTimeout(escalation);
            resolve({ id, status: cancelled ? 'cancelled' : timedOut ? 'timeout' : !failed && code === 0 ? 'success' : 'failed', exitCode: code });
          });
        }).then(row => { results.set(id, row); active.delete(id); });
        active.set(id, { stop, done });
      }
      // A child can close during a later node's control read. Revisit newly ready work
      // before waiting on the remaining children when capacity is available.
      if (active.size < concurrency && tasks.some(task => !results.has(task.id) && !active.has(task.id) &&
        (task.dependsOn ?? []).every(id => results.get(id)?.status === 'success'))) continue;
      if (active.size) await Promise.race([...active.values()].map(child => child.done));
    }
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  const nodes = order.map(id => results.get(id)!);
  return { status: nodes.every(n => n.status === 'success') && !cancelled ? 'complete' : 'failed', nodes };
}
