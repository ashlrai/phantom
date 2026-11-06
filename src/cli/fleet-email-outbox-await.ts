import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readEmailDropConfig } from '../core/comms/email-drop-config.js';
import { awaitEmailOutbox, type AwaitOptions, type AwaitResult } from '../core/comms/email-outbox-await.js';

const USAGE = 'Usage: ashlr fleet email-outbox-await --name ARTIFACT.reply.eml --timeout-ms N [--poll-ms N] [--dir ABS] [--json]';
type Deps = Partial<Pick<AwaitOptions, 'now' | 'read' | 'sleep' | 'signal'>> & { runsDir?: string };

export async function cmdFleetEmailOutboxAwait(args: string[], deps: Deps = {}): Promise<number> {
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
      const config = await readEmailDropConfig(deps.runsDir ?? join(homedir(), '.ashlr-runs'));
      if (controller.signal.aborted) return output({ name, cancelled: true, timedOut: false });
      if (config.state === 'invalid' || !config.config) return output({ name, reason: 'source-failure', cancelled: false, timedOut: false });
      outboxDir = config.config.outboxDir ?? join(config.config.inboxDir, '..', 'outbox');
    }
    return output(await awaitEmailOutbox({ dir: outboxDir, name, timeoutMs, pollMs, signal: controller.signal, now: deps.now, read: deps.read, sleep: deps.sleep }));
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    deps.signal?.removeEventListener('abort', cancel);
  }
}
