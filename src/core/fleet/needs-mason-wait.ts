import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { scrubSecrets } from '../util/scrub.js';

export type NeedsWaitStatus = 'resolved' | 'timeout' | 'unknown' | 'unavailable' | 'cancelled';
export const NEEDS_WAIT_MAX_MS = 2_147_483_647;
export const NEEDS_WAIT_ID = /^nm-[0-9a-f]{12}$/;
const MAX_BYTES = 32 * 1024;

// Keep the identity and marker rules aligned with needs-mason-resolve.ts.
function inspectLedger(path: string, id: string): 'resolved' | 'open' | 'unknown' | 'unavailable' {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return 'unavailable';
    // Read one byte beyond the limit to detect growth after fstat.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, length);
      if (!n) break;
      length += n;
    }
    if (length > MAX_BYTES) return 'unavailable';
    let found = false;
    for (const raw of scrubSecrets(bytes.subarray(0, length).toString('utf8')).split(/\r?\n/)) {
      const line = raw.trim();
      const marker = /^[-*]\s+\[[xX]\]\s+resolved\s+(nm-[0-9a-f]{12})\b/.exec(line);
      if (marker) { if (marker[1] === id) return 'resolved'; continue; }
      const body = line.replace(/^[-*]\s+/, '');
      if (!body || body.startsWith('#') || /\bresolved\b/i.test(body) || /^\[[xX]\]/.test(body)) continue;
      const clean = body.replace(/^\[ \]\s+/, '').slice(0, 300).trim();
      if (clean && `nm-${createHash('sha256').update(clean).digest('hex').slice(0, 12)}` === id) found = true;
    }
    return found ? 'open' : 'unknown';
  } catch { return 'unavailable'; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export interface NeedsWaitOptions {
  id: string; timeoutMs: number; pollMs: number; runsDir?: string;
  now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; signal?: AbortSignal;
}

export async function waitNeedsMason(options: NeedsWaitOptions): Promise<NeedsWaitStatus> {
  const { id, timeoutMs, pollMs } = options;
  if (!NEEDS_WAIT_ID.test(id) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > NEEDS_WAIT_MAX_MS ||
      !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > NEEDS_WAIT_MAX_MS) throw new RangeError('Invalid wait options');
  const path = join(options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'NEEDS-MASON.md');
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (controller.signal.aborted) return 'cancelled';
      const status = inspectLedger(path, id);
      if (status !== 'open') return status;
      const remaining = deadline - now();
      if (remaining <= 0) return 'timeout';
      try { await sleep(Math.min(pollMs, remaining), controller.signal); }
      catch { return controller.signal.aborted ? 'cancelled' : 'unavailable'; }
      if (controller.signal.aborted) return 'cancelled';
      if (now() >= deadline) return 'timeout';
    }
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    options.signal?.removeEventListener('abort', abort);
  }
}
