import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readEmailDropConfig } from '../core/comms/email-drop-config.js';
import { awaitEmailOutbox, type AwaitOptions, type AwaitResult } from '../core/comms/email-outbox-await.js';

const USAGE = 'Usage: ashlr fleet email-outbox-await --name ARTIFACT.reply.eml --timeout-ms N [--poll-ms N] [--dir ABS] [--json]';
type Deps = Partial<Pick<AwaitOptions, 'now' | 'read' | 'sleep' | 'signal'>> & { runsDir?: string; readConfig?: typeof readEmailDropConfig };

export async function cmdFleetEmailOutboxAwait(args: string[], deps: Deps = {}): Promise<number> {
  const now = deps.now ?? Date.now;
  const started = now();
  const values = new Map<string, string>();
  let json = false;
  const usage = (): number => { console.error(USAGE); return 2; };
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (!['--name', '--timeout-ms', '--poll-ms', '--dir'].includes(key) || values.has(key)) return usage();
    const value = args[++i];
    if (!value || value.startsWith('--')) return usage();
    values.set(key, value);
  }
  const name = values.get('--name');
  const number = (key: string, fallback?: number): number => {
    const value = values.get(key);
    return value === undefined ? (fallback ?? NaN) : (/^\d+$/.test(value) ? Number(value) : NaN);
  };
  const timeoutMs = number('--timeout-ms');
  const pollMs = number('--poll-ms', 1000);
  const dir = values.get('--dir');
  if (!name || !name.toLowerCase().endsWith('.reply.eml') || name.includes('..') || /[/\\\0]/.test(name) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
      !Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 10_000 ||
      (dir !== undefined && (!isAbsolute(dir) || dir.includes('\0')))) return usage();

  const output = (result: AwaitResult): number => {
    if (json) console.log(JSON.stringify(result));
    else console.log(`email-outbox-await: ${result.name} ${result.cancelled ? 'cancelled' : result.timedOut ? 'timed-out' : result.reason === 'source-failure' ? 'source-failure' : result.state}${result.reason && result.reason !== 'source-failure' ? ` (${result.reason})` : ''}`);
    return result.cancelled ? 130 : result.timedOut || result.reason === 'source-failure' || result.state === 'stuck' ? 1 : 0;
  };
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  deps.signal?.addEventListener('abort', cancel, { once: true });
  if (deps.signal?.aborted) cancel();
  try {
    if (controller.signal.aborted) return output({ name, cancelled: true, timedOut: false });
    let outboxDir = dir;
    if (!outboxDir) {
      const remaining = timeoutMs - (now() - started);
      if (remaining <= 0) return output({ name, cancelled: false, timedOut: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const boundary = new Promise<'cancelled' | 'timedOut'>((resolve) => {
        onAbort = () => resolve('cancelled');
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => resolve('timedOut'), remaining);
      });
      let config: Awaited<ReturnType<typeof readEmailDropConfig>> | 'cancelled' | 'timedOut';
      try {
        config = await Promise.race([Promise.resolve().then(() => (deps.readConfig ?? readEmailDropConfig)(deps.runsDir ?? join(homedir(), '.ashlr-runs'))), boundary]);
      } finally {
        clearTimeout(timer);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      }
      if (controller.signal.aborted || config === 'cancelled') return output({ name, cancelled: true, timedOut: false });
      if (config === 'timedOut' || now() - started >= timeoutMs) return output({ name, cancelled: false, timedOut: true });
      if (config.state === 'invalid' || !config.config) return output({ name, reason: 'source-failure', cancelled: false, timedOut: false });
      outboxDir = config.config.outboxDir ?? join(config.config.inboxDir, '..', 'outbox');
    }
    if (controller.signal.aborted) return output({ name, cancelled: true, timedOut: false });
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) return output({ name, cancelled: false, timedOut: true });
    return output(await awaitEmailOutbox({ dir: outboxDir, name, timeoutMs: remaining, pollMs, signal: controller.signal, now: deps.now, read: deps.read, sleep: deps.sleep }));
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    deps.signal?.removeEventListener('abort', cancel);
  }
}
