import { isAbsolute } from 'node:path';
import { isFleetJobId } from '../core/fleet/runs-job-detail.js';
import { jobWindowLive, jobWindowText, type FleetJobWindowV1 } from '../core/fleet/job-window.js';
import { getFleetJobWindow } from '../core/fleet/runs-job-window.js';

export const showUsage = 'phm job show <id> [--tail N] [--follow] [--json] [--runs-dir <abs>] [--help]';
export const showHelp = 'One window into a fleet job: its state in plain words, lane, model, repo, tier, start, finish and PR, then its last N log lines (1..200, default 40), every line redacted. --follow prints new lines while the job runs, then its final state. --json prints the fleet.job.window.v1 object (one per line with --follow). Exit 1 when the job is unknown on this machine.';

export interface JobShowDeps {
  window?: typeof getFleetJobWindow;
  out?: (line: string) => void;
  err?: (line: string) => void;
  signal?: AbortSignal;
  intervalMs?: number;
  /** Wait `ms` or until `signal` aborts. Injectable so tests run without timers. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * `phm job show <id>` — the CLI face of fleet.job.window.v1, the same window
 * the desktop and phone job views read. Exit codes: 0 ok, 1 unknown job or
 * read failure, 2 bad usage.
 *
 * --follow polls getFleetJobWindow with the previous log cursor as `after`,
 * so each poll prints only lines written since; it stops once the job is no
 * longer running (or on Ctrl-C, which still exits 0).
 */
export async function cmdJobShow(args: string[], deps: JobShowDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const invalid = (): number => { err(`Usage: ${showUsage}`); return 2; };
  let id: string | undefined;
  let tail = 40;
  let runsDir: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { out(`Usage: ${showUsage}\n${showHelp}`); return 0; }
    if (arg.startsWith('-')) {
      if (flags.has(arg)) return invalid();
      flags.add(arg);
    }
    if (arg === '--json' || arg === '--follow') continue;
    if (arg === '--tail') {
      const raw = args[++i];
      const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 200) return invalid();
      tail = n;
    } else if (arg === '--runs-dir') {
      const dir = args[++i];
      if (!dir || dir.startsWith('-') || !isAbsolute(dir)) return invalid();
      runsDir = dir;
    } else if (!id && !arg.startsWith('-') && isFleetJobId(arg)) {
      id = arg;
    } else return invalid();
  }
  if (!id) return invalid();
  const json = flags.has('--json');
  const read = deps.window ?? getFleetJobWindow;
  const base = { lines: tail, ...(runsDir ? { runsDir } : {}) };
  try {
    let w: FleetJobWindowV1 = await read(id, base);
    if (json) out(JSON.stringify(w));
    else for (const line of jobWindowText(w)) out(line);
    if (w.state === 'unknown') return 1;
    if (!flags.has('--follow') || !jobWindowLive(w)) return 0;

    const controller = new AbortController();
    const stop = (): void => controller.abort();
    deps.signal?.addEventListener('abort', stop, { once: true });
    if (deps.signal?.aborted) controller.abort();
    if (!deps.signal) process.once('SIGINT', stop);
    const wait = deps.wait ?? abortableWait;
    const intervalMs = deps.intervalMs ?? 2000;
    try {
      let more = false;
      while (!controller.signal.aborted) {
        if (!more) await wait(intervalMs, controller.signal);
        if (controller.signal.aborted) break;
        const prev = w;
        // A null cursor means no live log yet: re-read the snapshot. Its lines are
        // all new then, since a running job with no log had none to show.
        w = await read(id, { ...base, after: prev.log.cursor ?? undefined });
        more = w.log.more;
        const fresh = w.log.lines;
        if (json) {
          if (fresh.length > 0 || w.state !== prev.state) out(JSON.stringify(w));
        } else {
          for (const line of fresh) out(line);
        }
        if (!jobWindowLive(w)) {
          if (!json) {
            out(`Job ${w.job}: ${w.stateLine}`);
            if (w.reason) out(w.reason);
          }
          break;
        }
      }
    } finally {
      deps.signal?.removeEventListener('abort', stop);
      process.removeListener('SIGINT', stop);
    }
    return 0;
  } catch {
    err('error: job window unavailable');
    return 1;
  }
}
