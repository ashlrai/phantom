import { isAbsolute } from 'node:path';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { drainContextReplySpool, DRAIN_MAX_LIMIT } from '../core/fleet/context-spool-drain.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet context-drain --spool-dir <absolute-directory> --json [--apply] [--limit <1..64>]';

/** Preview or republish pending context-reply spool records. Apply only calls
 * the existing per-record delivery path — it never executes argv or reruns a
 * worker. Output is counts and hashed record names only. */
export async function cmdFleetContextDrain(args: string[], io: ContextWorkerIO = {}, bus: BusInboxOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    (io.stdout ?? process.stdout).write(`${usage}\nDefault previews the bounded batch; --apply republishes each selected record through the existing spool delivery (workers are never rerun). Exit: 0 complete, 1 incomplete/retryable, 2 invalid or refused.\n`);
    return 0;
  }
  const invalid = (): number => { (io.stderr ?? process.stderr).write(`${usage}\n`); return 2; };
  const values = new Map<string, string>();
  let json = false, apply = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key === '--apply' && !apply) { apply = true; continue; }
    if (!['--spool-dir', '--limit'].includes(key) || values.has(key)) return invalid();
    const value = args[++i];
    if (!value || value.startsWith('--') || value.includes('\0')) return invalid();
    values.set(key, value);
  }
  const spoolDir = values.get('--spool-dir');
  const limitText = values.get('--limit');
  const limit = limitText === undefined ? undefined : Number(limitText);
  if (!json || spoolDir === undefined || !isAbsolute(spoolDir) ||
    (limit !== undefined && (!/^\d+$/.test(limitText!) || !Number.isSafeInteger(limit) || limit < 1 || limit > DRAIN_MAX_LIMIT))) {
    return invalid();
  }
  const report = drainContextReplySpool({ spoolDir, apply, limit }, bus);
  try { (io.stdout ?? process.stdout).write(`${JSON.stringify(sanitizePublicJson(report))}\n`); }
  catch { return 1; }
  return report.exitCode;
}
