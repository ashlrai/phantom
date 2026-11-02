import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { taskReadyFrontier } from './task-ready-frontier.js';
import { readRunsSwitches } from './runs-switches.js';

type Task = { id: string; dependsOn?: string[]; argv: string[]; cwd?: string };
type Row = { id: string; status: string; exitCode: number | null };
/** A node's terminal row as delivered to the progress hook. */
export interface GraphArgvNodeResult { id: string; status: string; exitCode: number | null }
export interface GraphArgvRunOptions {
  /** Stop launching new nodes after a spawned node fails; running nodes finish. */
  failFast?: boolean;
  /** Awaited once per node after it reaches a terminal row, strictly one
   * delivery at a time and before any dependent it unblocks is scheduled.
   * A rejection stops new launches (running children still finish and are
   * delivered) and the run reports failed. */
  onNodeTerminal?: (node: GraphArgvNodeResult) => void | Promise<void>;
  /** Shared cap, in bytes, on child stdout+stderr forwarded to this process's
   * stderr across the whole run (default and maximum 262144, minimum 1). This
   * is a resource bound on diagnostics, not a secrets control: output past
   * the cap is still drained but dropped so noisy children cannot block. */
  outputBudgetBytes?: number;
}
/** Written to the diagnostic destination once per run when the shared output
 * budget is spent. Charged to a separate small allowance, never to the data
 * budget, so byte accounting for child output stays exact. */
const OUTPUT_TRUNCATION_MARKER = '\n[phm] graph child output truncated: shared diagnostic budget exhausted\n';
/** SIGTERM to SIGKILL escalation once a node is stopped. Bounded so a child
 * that swallows SIGTERM still dies shortly after the deadline or a cancel. */
const TERM_TO_KILL_MS = 250;
/** How long 'close' may lag behind process exit or a group SIGKILL before the
 * local pipe ends are dropped and the row settles anyway. 'close' waits for
 * both exit and stdio EOF, and a descendant that left the group (its own
 * setsid) can hold an inherited pipe open forever — without this bound one
 * escaped process would stall the whole run on a pipe EOF that never comes. */
const CLOSE_SETTLE_MS = 500;
/** Bounded diagnostic forwarding for child stdio. At most `budget` bytes reach
 * `dest` per run across every stream of every node; once the budget is spent
 * chunks are dropped while sources keep flowing, so a noisy child can never
 * block on a full pipe and is never buffered or killed for being loud.
 * Backpressure is honoured by pausing the reporting source until `dest`
 * drains: state stays bounded by the live pipe set (at most two per child)
 * plus one pending 'drain' listener, and no byte queue beyond the pipes' own
 * high-water marks is grown. */
function diagnosticForwarder(dest: NodeJS.WritableStream, budget: number): (chunk: Buffer, source: Readable) => void {
  let remaining = budget, markerAllowance = 256, marked = false, waiting = false;
  const paused = new Set<Readable>();
  const resumeAll = (): void => { for (const source of [...paused]) { paused.delete(source); source.resume(); } };
  const onDrain = (): void => { waiting = false; resumeAll(); };
  const mark = (): void => {
    if (marked) return;
    marked = true;
    const marker = Buffer.from(OUTPUT_TRUNCATION_MARKER).subarray(0, markerAllowance);
    markerAllowance -= marker.length;
    dest.write(marker);
  };
  return (chunk, source) => {
    if (remaining <= 0) { mark(); return; }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    remaining -= slice.length;
    const flushed = dest.write(slice);
    if (remaining <= 0) {
      if (slice.length < chunk.length) mark();
      if (waiting) { waiting = false; dest.off('drain', onDrain); }
      resumeAll();
    }
    else if (!flushed && !paused.has(source)) {
      paused.add(source); source.pause();
      if (!waiting) { waiting = true; dest.once('drain', onDrain); }
    }
  };
}
export async function graphArgvRun(file: string, apply = false, timeoutMs = 900000, concurrency = 1, options: GraphArgvRunOptions = {}): Promise<{ status: string; nodes: Row[] }> {
  // One monotonic deadline bounds the whole apply: control reads and every
  // child share it, so a graph can never multiply the caller's budget.
  const deadline = performance.now() + timeoutMs;
  const expired = (): boolean => performance.now() >= deadline;
  let tasks: Task[];
  let outputBudget = 262144;
  const order: string[] = [];
  try {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 || !isAbsolute(file) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw Error();
    if (options.outputBudgetBytes !== undefined) {
      if (!Number.isSafeInteger(options.outputBudgetBytes) || options.outputBudgetBytes < 1 || options.outputBudgetBytes > 262144) throw Error();
      outputBudget = options.outputBudgetBytes;
    }
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
  // Child stdio forwards to stderr as diagnostics under one shared byte budget;
  // stdout is reserved for machine-readable CLI output and never sees it.
  const forward = diagnosticForwarder(process.stderr, outputBudget);
  const results = new Map<string, Row>();
  const active = new Map<string, { stop: () => void; done: Promise<void> }>();
  let cancelled = false, halted = false, nodeFailed = false;
  const cancel = (): void => { cancelled = true; for (const child of active.values()) child.stop(); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  // Terminal rows are delivered to the progress hook one at a time, in record
  // order. A row only enters `results` after its delivery settles, so a
  // dependent never becomes eligible mid-hook; the node stays in `active`
  // until then so the loop waits on the delivery instead of spinning.
  let delivered: Promise<void> = Promise.resolve();
  const record = async (id: string, row: Row): Promise<void> => {
    delivered = delivered.then(() => options.onNodeTerminal?.({ ...row })).catch(() => { halted = true; });
    await delivered;
    results.set(id, row);
  };
  try {
    while (results.size < order.length) {
      for (const id of order) {
        if (results.has(id) || active.has(id)) continue;
        const task = tasks.find(t => t.id === id)!;
        const dependencies = task.dependsOn ?? [];
        if (cancelled) { await record(id, { id, status: 'cancelled', exitCode: null }); continue; }
        if (expired()) { await record(id, { id, status: 'deadline-exhausted', exitCode: null }); continue; }
        if (dependencies.some(d => results.has(d) && results.get(d)!.status !== 'success')) {
          await record(id, { id, status: 'blocked', exitCode: null }); continue;
        }
        if (halted) { await record(id, { id, status: 'cancelled', exitCode: null }); continue; }
        if (options.failFast && nodeFailed) {
          if (dependencies.some(d => active.has(d))) continue;
          await record(id, { id, status: 'fail-fast-skipped', exitCode: null }); continue;
        }
        if (active.size >= concurrency || dependencies.some(d => !results.has(d))) continue;
        const switches = await readRunsSwitches();
        const refused = switches.sourceState === 'degraded' || switches.switches.some(s => s.on && ['ORCH_OFF', 'PAUSE', 'HOLD', 'QUEUE_DISABLE'].includes(s.id));
        const remaining = deadline - performance.now();
        // Cancellation must win even when delivered during the asynchronous control
        // read; the same window can also exhaust the shared deadline.
        if (cancelled || halted || remaining <= 0 || (options.failFast && nodeFailed) || refused) {
          await record(id, { id, status: cancelled || halted ? 'cancelled' : remaining <= 0 ? 'deadline-exhausted' : options.failFast && nodeFailed ? 'fail-fast-skipped' : 'refused', exitCode: null }); continue;
        }
        let stop = (): void => {};
        const done = new Promise<Row>(resolve => {
          // Each node runs as its own process group on POSIX (detached): a
          // deadline or cancel then stops the WHOLE tree, not just the direct
          // child — cancelled work cannot keep running underneath the row.
          // The pgid equals the child's pid, so kill(-pid) can only ever name
          // this node's group: the runner's own group and unrelated groups
          // are never signalled. Platforms without process groups (win32)
          // keep the portable direct-child fallback.
          const useGroup = process.platform !== 'win32';
          let child: ChildProcessByStdio<null, Readable, Readable>;
          try {
            child = spawn(task.argv[0]!, task.argv.slice(1), { cwd: task.cwd, shell: false, detached: useGroup, stdio: ['ignore', 'pipe', 'pipe'] });
          } catch { resolve({ id, status: 'failed', exitCode: null }); return; }
          child.stdout.on('data', (chunk: Buffer) => forward(chunk, child.stdout));
          child.stderr.on('data', (chunk: Buffer) => forward(chunk, child.stderr));
          let timedOut = false, failed = false, settled = false;
          let code: number | null = null;
          let escalation: ReturnType<typeof setTimeout> | undefined;
          let settle: ReturnType<typeof setTimeout> | undefined;
          const signalTree = (signal: 'SIGTERM' | 'SIGKILL'): void => {
            const pid = child.pid;
            if (useGroup && typeof pid === 'number' && pid > 0) {
              // ESRCH means the group is already empty — or the fresh child
              // has not run setsid yet, in which case the direct child is
              // still signalled to cover that narrow window.
              try { process.kill(-pid, signal); return; } catch { /* group gone: fall back to the child */ }
            }
            try { child.kill(signal); } catch { /* already exited */ }
          };
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer); clearTimeout(escalation); clearTimeout(settle);
            const status = cancelled ? 'cancelled' : timedOut ? 'timeout' : !failed && code === 0 ? 'success' : 'failed';
            if (status !== 'success') nodeFailed = true;
            resolve({ id, status, exitCode: code });
          };
          // Last resort for 'close': drop the local pipe ends and release the
          // process handle so nothing in the child's tree can stall the run.
          const abandon = (): void => {
            child.stdout.destroy(); child.stderr.destroy();
            child.unref();
            finish();
          };
          const armSettle = (): void => { if (!settle) { settle = setTimeout(abandon, CLOSE_SETTLE_MS); settle.unref(); } };
          stop = () => {
            signalTree('SIGTERM');
            if (!escalation) { escalation = setTimeout(() => { signalTree('SIGKILL'); armSettle(); }, TERM_TO_KILL_MS); escalation.unref(); }
          };
          const timer = setTimeout(() => { timedOut = true; stop(); }, remaining);
          child.on('error', () => { failed = true; });
          child.on('exit', exitCode => {
            code = exitCode;
            // The leader is gone but its group may not be: leftover members
            // would keep consuming memory and hold the stdio pipes open,
            // stalling 'close' — sweep them before the row settles. A member
            // that escaped the group is covered by armSettle instead.
            signalTree('SIGKILL');
            armSettle();
          });
          child.on('close', closeCode => { code = closeCode; finish(); });
        }).then(row => record(id, row)).then(() => { active.delete(id); });
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
  return { status: nodes.every(n => n.status === 'success') && !cancelled && !halted ? 'complete' : 'failed', nodes };
}
