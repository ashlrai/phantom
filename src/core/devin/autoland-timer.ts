import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runDevinAutoland } from './autoland.js';

export interface DevinAutolandTimerDeps {
  ready?: () => Promise<boolean>;
  pass?: (signal: AbortSignal) => Promise<unknown>;
  firstMs?: number;
  intervalMs?: number;
  deadlineMs?: number;
}
let stop: (() => void) | undefined;
let active = false;
export function ensureDevinAutolandTimer(deps: DevinAutolandTimerDeps = {}): void {
  if (stop) return;
  let stopped = false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const ready = deps.ready ?? (async () => {
    if (!existsSync(join(homedir(), '.ashlr-runs', 'bin', 'publish.sh'))) return false;
    return !('error' in await (await import('./service.js')).connectedClient());
  });
  const tick = async () => {
    if (stopped) return;
    if (active) { timer = setTimeout(() => { void tick(); }, deps.intervalMs ?? 10 * 60_000); timer.unref(); return; }
    active = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const passController = new AbortController();
    const abort = () => passController.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    const work = (async () => { if (!stopped && await ready() && !stopped) await (deps.pass ?? (signal => runDevinAutoland({ apply: true }, { signal })))(passController.signal); })();
    try {
      await Promise.race([work, new Promise<void>(resolve => { deadline = setTimeout(() => { passController.abort(); resolve(); }, deps.deadlineMs ?? 9 * 60_000); deadline.unref(); })]);
      // A timed-out pass retains the single-flight slot until it settles.
      await work;
    } catch { /* Resident maintenance must not break the daemon. */ }
    finally {
      if (deadline) clearTimeout(deadline);
      controller.signal.removeEventListener('abort', abort);
      active = false;
      if (!stopped) { timer = setTimeout(() => { void tick(); }, deps.intervalMs ?? 10 * 60_000); timer.unref(); }
    }
  };
  timer = setTimeout(() => { void tick(); }, deps.firstMs ?? 60_000);
  timer.unref();
  stop = () => { stopped = true; controller.abort(); clearTimeout(timer); };
}
export function stopDevinAutolandTimer(): void { stop?.(); stop = undefined; }
