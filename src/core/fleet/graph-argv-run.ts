import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { taskReadyFrontier } from './task-ready-frontier.js';
import { readRunsSwitches } from './runs-switches.js';

type Task = { id: string; dependsOn?: string[]; argv: string[] };
type Row = { id: string; status: string; exitCode: number | null };
export async function graphArgvRun(file: string, apply = false, timeoutMs = 900000): Promise<{ status: string; nodes: Row[] }> {
  let tasks: Task[], order: string[] = [];
  try {
    if (!isAbsolute(file) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw Error();
    const read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: 262144, remainingBytes: 262144 });
    if (!read.ok) throw Error();
    const v = JSON.parse(read.text);
    if (v.version !== 1 || Object.keys(v).some(k => !['version', 'tasks'].includes(k)) || !Array.isArray(v.tasks) || v.tasks.length > 32) throw Error();
    tasks = v.tasks;
    const id = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
    for (const t of tasks) {
      if (!t || Object.keys(t).some(k => !['id', 'dependsOn', 'argv'].includes(k)) || !id(t.id) ||
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
  const nodes: Row[] = [];
  let cancelled = false;
  let stop: (() => void) | undefined;
  const cancel = (): void => { cancelled = true; stop?.(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    for (const id of order) {
      const task = tasks.find(t => t.id === id)!;
      const switches = await readRunsSwitches();
      const refused = switches.sourceState === 'degraded' || switches.switches.some(s => s.on && ['ORCH_OFF', 'PAUSE', 'HOLD', 'QUEUE_DISABLE'].includes(s.id));
      if (cancelled || refused || task.dependsOn?.some(d => nodes.find(n => n.id === d)?.status !== 'success')) {
        nodes.push({ id, status: cancelled ? 'cancelled' : refused ? 'refused' : 'blocked', exitCode: null }); continue;
      }
      const row = await new Promise<Row>(resolve => {
        const child = spawn(task.argv[0]!, task.argv.slice(1), { shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(process.stderr, { end: false }); child.stderr.pipe(process.stderr, { end: false });
        let timedOut = false, failed = false;
        let escalation: ReturnType<typeof setTimeout> | undefined;
        stop = () => { child.kill('SIGTERM'); escalation ??= setTimeout(() => child.kill('SIGKILL'), 250); };
        const timer = setTimeout(() => { timedOut = true; stop?.(); }, timeoutMs);
        child.on('error', () => { failed = true; });
        child.on('close', code => {
          clearTimeout(timer); clearTimeout(escalation); stop = undefined;
          resolve({ id, status: cancelled ? 'cancelled' : timedOut ? 'timeout' : !failed && code === 0 ? 'success' : 'failed', exitCode: code });
        });
      });
      nodes.push(row);
    }
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  return { status: nodes.every(n => n.status === 'success') && !cancelled ? 'complete' : 'failed', nodes };
}
