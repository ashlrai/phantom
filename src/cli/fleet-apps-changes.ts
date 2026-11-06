/** Read-only, bounded observation of fleet app inventory changes. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FLEET_APPS } from '../core/verse/fleet-apps-api.js';
import { selfCliPrefix, type AppsEnsureChildRunner } from './fleet-apps-ensure.js';

const exec = promisify(execFile);
const usage = 'Usage: ashlr fleet apps-changes --duration-ms <1..300000> [--interval-ms <100..60000>] [--root <dir>] [--stop-file <path>] [--app <name>]... [--jsonl]';
export type State = 'running' | 'stopped' | 'unknown';
export interface FleetAppsChangesDeps {
  runChild?: AppsEnsureChildRunner;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

function inventory(code: number | null, stdout: string, selected: ReadonlySet<number>): { states: State[]; valid: boolean } {
  const states: State[] = FLEET_APPS.map(() => 'unknown');
  try {
    const data: unknown = JSON.parse(stdout);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { states, valid: false };
    const view = data as Record<string, unknown>;
    if ((code !== 0 && code !== 1) || view.v !== 1 || view.available !== true ||
        typeof view.generatedAt !== 'string' || !Number.isFinite(Date.parse(view.generatedAt)) || !Array.isArray(view.apps) ||
        (view.degraded !== undefined && typeof view.degraded !== 'boolean')) return { states, valid: false };
    // Exit 1 is the status command's documented degraded-inventory result.
    if (code === 1 && view.degraded !== true) return { states, valid: false };
    const counts = FLEET_APPS.map(() => 0);
    const validRows = FLEET_APPS.map(() => false);
    for (const item of view.apps as unknown[]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const i = (FLEET_APPS as readonly unknown[]).indexOf(row.app);
      if (i < 0) continue;
      counts[i]!++;
      validRows[i] = counts[i] === 1 && typeof row.checkedAt === 'string' && Number.isFinite(Date.parse(row.checkedAt)) &&
        (row.running === null || typeof row.running === 'boolean');
      states[i] = validRows[i] ? row.running === true ? 'running' : row.running === false ? 'stopped' : 'unknown' : 'unknown';
    }
    return { states, valid: validRows.some((valid, i) => valid && selected.has(i)) };
  } catch { return { states, valid: false }; }
}

export async function cmdFleetAppsChanges(args: string[], deps: FleetAppsChangesDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const invalid = (): number => { console.error(`error: invalid fleet apps-changes arguments\n${usage}`); return 2; };
  let duration = 0, interval = 1000, root: string | undefined, stopFile: string | undefined, jsonl = false;
  const seen = new Set<string>();
  const requestedApps = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!['--duration-ms', '--interval-ms', '--root', '--stop-file', '--jsonl', '--app'].includes(flag) || (flag !== '--app' && seen.has(flag))) return invalid();
    seen.add(flag);
    if (flag === '--jsonl') { jsonl = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('-')) return invalid();
    if (flag === '--root') { root = value; continue; }
    if (flag === '--stop-file') { stopFile = resolve(value); continue; }
    if (flag === '--app') {
      const index = (FLEET_APPS as readonly string[]).indexOf(value);
      if (index < 0) return invalid();
      requestedApps.add(index);
      continue;
    }
    if (!/^[0-9]{1,9}$/.test(value)) return invalid();
    const n = Number(value);
    if (flag === '--duration-ms') { if (n < 1 || n > 300000) return invalid(); duration = n; }
    else { if (n < 100 || n > 60000) return invalid(); interval = n; }
  }
  if (!duration) return invalid();
  let result: Awaited<ReturnType<typeof observeFleetAppsChanges>>;
  try { result = await observeFleetAppsChanges({ durationMs: duration, intervalMs: interval, root, stopFile, apps: [...requestedApps].map(i => FLEET_APPS[i]!) }, deps, event => {
    if (jsonl) process.stdout.write(`${JSON.stringify(event)}\n`);
    else if (event.type === 'summary') console.log(`Summary: ${event.outcome}, ${event.samples} samples, ${event.transitions} transitions`);
    else console.log(`${event.time} ${event.type} ${event.app}: ${event.state}`);
  }); } catch { console.error('fleet apps-changes: cannot resolve the ashlr CLI entry'); return 1; }
  return result.outcome === 'complete' ? 0 : 1;
}

type ChangeEvent = { type: 'baseline' | 'transition'; app: string; state: State; time: string };
type SummaryEvent = { type: 'summary'; outcome: 'complete' | 'cancelled' | 'unavailable'; samples: number; transitions: number };
export async function observeFleetAppsChanges(
  options: { durationMs: number; intervalMs?: number; root?: string; stopFile?: string; apps?: readonly string[]; maxEvents?: number },
  deps: FleetAppsChangesDeps = {}, onEvent?: (event: ChangeEvent | SummaryEvent) => void,
): Promise<{ v: 1; outcome: SummaryEvent['outcome']; samples: number; transitions: number; events: ChangeEvent[]; truncated: boolean }> {
  const { durationMs: duration, intervalMs: interval = 1000, root } = options;
  const selected = options.apps?.length ? new Set(options.apps.map(app => (FLEET_APPS as readonly string[]).indexOf(app))) : new Set(FLEET_APPS.map((_, i) => i));
  const events: ChangeEvent[] = [];
  let truncated = false;
  let runChild = deps.runChild;
  if (!runChild && !deps.signal?.aborted) {
    const prefix = selfCliPrefix();
    if (prefix === null) throw new Error('Cannot resolve CLI entry');
    runChild = async (argv, options) => {
      try {
        const { stdout } = await exec(process.execPath, [...prefix, ...argv], { encoding: 'utf8', timeout: options.timeoutMs, signal: options.signal, maxBuffer: 1024 * 1024, windowsHide: true });
        return { code: 0, stdout };
      } catch (error) {
        const e = error as { code?: unknown; stdout?: unknown };
        return { code: typeof e.code === 'number' ? e.code : null, stdout: typeof e.stdout === 'string' ? e.stdout : '' };
      }
    };
  }
  const now = deps.now ?? (() => performance.now());
  const start = now(), wallStart = performance.now();
  const remaining = (): number => Math.max(0, duration - Math.max(0, now() - start, performance.now() - wallStart));
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  }));
  let fileStopped = false, fileError = false;
  const bounded = async <T>(ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let stop!: () => void;
    const limit = new Promise<undefined>(resolve => { stop = () => { controller.abort(); resolve(undefined); }; });
    deps.signal?.addEventListener('abort', stop, { once: true });
    try {
      if (deps.signal?.aborted || remaining() <= 0) return undefined;
      timer = setTimeout(stop, Math.max(1, ms));
      const checkFile = async (): Promise<boolean> => {
        if (!options.stopFile) return false;
        try {
          await stat(options.stopFile);
          if (!finished) { fileStopped = true; stop(); }
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          if (!finished) { fileError = true; stop(); }
          return true;
        }
      };
      const work = (async (): Promise<T | undefined> => {
        if (await checkFile() || finished || controller.signal.aborted) return undefined;
        const watch = async (): Promise<void> => {
          if (finished || await checkFile() || finished) return;
          poll = setTimeout(() => { void watch(); }, 100);
        };
        if (options.stopFile) poll = setTimeout(() => { void watch(); }, 100);
        return operation(controller.signal);
      })().catch(() => undefined);
      return await Promise.race([work, limit]);
    } finally { finished = true; clearTimeout(timer); clearTimeout(poll); deps.signal?.removeEventListener('abort', stop); }
  };
  const emit = (event: ChangeEvent): void => {
    if (events.length < (options.maxEvents ?? Infinity)) events.push(event);
    else truncated = true;
    onEvent?.(event);
  };
  let previous: State[] | undefined, samples = 0, transitions = 0, valid = false;
  while (!deps.signal?.aborted && !fileStopped && !fileError && remaining() > 0) {
    const budget = Math.max(1, Math.ceil(remaining()));
    const result = await bounded(budget, signal => runChild!(['fleet', 'apps-status', ...(root === undefined ? [] : ['--root', root]), '--json'], { timeoutMs: budget, signal }));
    if (deps.signal?.aborted || fileStopped || fileError) break;
    const parsed = result ? inventory(result.code, result.stdout, selected) : { states: FLEET_APPS.map((): State => 'unknown'), valid: false };
    valid ||= parsed.valid;
    samples++;
    const time = new Date().toISOString();
    parsed.states.forEach((state, i) => {
      if (!selected.has(i)) return;
      if (!previous || previous[i] !== state) {
        const type = previous ? 'transition' : 'baseline';
        if (previous) transitions++;
        emit({ type, app: FLEET_APPS[i], state, time });
      }
    });
    previous = parsed.states;
    if (remaining() <= 0) break;
    await bounded(Math.min(interval, remaining()), signal => sleep(Math.min(interval, remaining()), signal));
  }
  const outcome = deps.signal?.aborted || fileStopped ? 'cancelled' : fileError ? 'unavailable' : valid ? 'complete' : 'unavailable';
  onEvent?.({ type: 'summary', outcome, samples, transitions });
  return { v: 1, outcome, samples, transitions, events, truncated };
}
