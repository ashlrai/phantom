import { isAbsolute } from 'node:path';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import {
  watchContextReplySpool, validContextSpoolWatchOptions, type ContextSpoolWatchDeps,
} from '../core/fleet/context-spool-watch.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet context-watch --spool-dir <absolute-directory> --duration-ms <1..3600000> --interval-ms <100..60000> --limit <1..64> --json [--apply]';
const integer = (text: string | undefined): number | undefined =>
  text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;

/** Bounded watch that retries spooled context replies after a transient bus
 * failure. Preview runs one drain batch and exits; --apply repeats bounded
 * sweeps inside the duration, republishing each selected record through the
 * existing spool delivery (workers are never rerun, nothing else mutates).
 * Output is one summary of counts and the terminal reason — never bodies,
 * raw reply ids or filesystem paths. */
export async function cmdFleetContextWatch(
  args: string[], io: ContextWorkerIO = {}, bus: BusInboxOptions = {}, deps: ContextSpoolWatchDeps = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\nDefault performs one drain preview and exits; --apply sweeps the spool for the bounded duration, waiting --interval-ms between sweeps (an empty spool keeps being watched — new arrivals are delivered by later sweeps). reason is preview-complete, duration-expired (normal bounded completion), cancelled, unsafe or invalid; unresolved counts records still undelivered — it never reports them as delivered. Exit: 0 complete, 1 incomplete/cancelled/unresolved, 2 invalid or refused.\n`);
    return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const values = new Map<string, string>();
  let json = false, apply = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key === '--apply' && !apply) { apply = true; continue; }
    if (!['--spool-dir', '--duration-ms', '--interval-ms', '--limit'].includes(key) || values.has(key)) return invalid();
    const value = args[++i];
    if (!value || value.startsWith('--') || value.includes('\0')) return invalid();
    values.set(key, value);
  }
  const opts = {
    spoolDir: values.get('--spool-dir') ?? '',
    durationMs: integer(values.get('--duration-ms')) ?? -1,
    intervalMs: integer(values.get('--interval-ms')) ?? -1,
    limit: integer(values.get('--limit')) ?? -1,
    apply,
  };
  if (!json || !values.has('--spool-dir') || !values.has('--duration-ms') ||
    !values.has('--interval-ms') || !values.has('--limit') ||
    !isAbsolute(opts.spoolDir) || !validContextSpoolWatchOptions(opts)) {
    return invalid();
  }
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener('abort', stop, { once: true });
  }
  try {
    const report = await watchContextReplySpool(opts, bus, { ...deps, signal: controller.signal });
    try { (io.stdout ?? process.stdout).write(`${JSON.stringify(sanitizePublicJson(report))}\n`); }
    catch { return 1; }
    return report.exitCode;
  } finally {
    deps.signal?.removeEventListener('abort', stop);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

