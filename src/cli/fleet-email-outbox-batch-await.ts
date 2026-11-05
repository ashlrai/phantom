import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEmailDropConfig } from '../core/comms/email-drop-config.js';
import { awaitEmailOutboxBatch, type BatchOptions, type BatchResult } from '../core/comms/email-outbox-batch-await.js';

const USAGE = 'Usage: ashlr fleet email-outbox-batch-await --stdin --timeout-ms N [--poll-ms N] [--json]';
type Deps = Partial<Pick<BatchOptions, 'now' | 'read' | 'sleep' | 'signal'>> & {
  runsDir?: string;
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  signals?: Pick<NodeJS.Process, 'on' | 'removeListener'>;
};

export async function cmdFleetEmailOutboxBatchAwait(args: string[], deps: Deps = {}): Promise<number> {
  const values = new Map<string, string>();
  let json = false; let stdin = false;
  const usage = (): number => { (deps.stderr ?? console.error)(USAGE); return 2; };
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key === '--stdin' && !stdin) { stdin = true; continue; }
    if (!['--timeout-ms', '--poll-ms'].includes(key) || values.has(key)) return usage();
    const value = args[++i];
    if (!value || value.startsWith('--')) return usage();
    values.set(key, value);
  }
  const number = (key: string, fallback: number): number => {
    const value = values.get(key);
    return value === undefined ? fallback : (/^\d+$/.test(value) ? Number(value) : NaN);
  };
  const timeoutMs = number('--timeout-ms', NaN); const pollMs = number('--poll-ms', 1000);
  if (!stdin || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
      !Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 10_000) return usage();
  let input = Buffer.alloc(0);
  try {
    for await (const chunk of deps.stdin ?? process.stdin) {
      const bytes = Buffer.from(chunk);
      if (input.length + bytes.length > 16 * 1024) return usage();
      input = Buffer.concat([input, bytes]);
    }
  } catch { return usage(); }
  let names: unknown;
  try { names = JSON.parse(input.toString('utf8')) as unknown; } catch { return usage(); }
  if (!Array.isArray(names) || names.length < 1 || names.length > 50 ||
      !names.every((name: unknown) => typeof name === 'string' && name.toLowerCase().endsWith('.reply.eml') && !name.includes('..') && !/[/\\\0]/.test(name)) ||
      new Set(names).size !== names.length) return usage();
  const output = (result: BatchResult): number => {
    (deps.stdout ?? console.log)(json ? JSON.stringify(result) : result.rows.map((row) => `${row.name}: ${row.state}${row.reason ? ` (${row.reason})` : ''}`).join('\n') + (result.cancelled ? '\ncancelled' : result.sourceFailure ? '\nsource-failure' : result.timedOut ? '\ntimed-out' : ''));
    return result.cancelled ? 130 : result.timedOut || result.sourceFailure || result.rows.some((row) => row.state === 'stuck') ? 1 : 0;
  };
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  const signals = deps.signals ?? process;
  signals.on('SIGINT', cancel); signals.on('SIGTERM', cancel);
  deps.signal?.addEventListener('abort', cancel, { once: true });
  if (deps.signal?.aborted) cancel();
  const empty = (): BatchResult => ({ rows: (names as string[]).map((name) => ({ name, state: 'missing' })), timedOut: false, cancelled: controller.signal.aborted, sourceFailure: !controller.signal.aborted });
  try {
    if (controller.signal.aborted) return output(empty());
    const config = await readEmailDropConfig(deps.runsDir ?? join(homedir(), '.ashlr-runs'));
    if (controller.signal.aborted || !config.config || config.state === 'invalid') return output(empty());
    const dir = config.config.outboxDir ?? join(config.config.inboxDir, '..', 'outbox');
    return output(await awaitEmailOutboxBatch({ dir, names: names as string[], timeoutMs, pollMs, signal: controller.signal, now: deps.now, read: deps.read, sleep: deps.sleep }));
  } finally {
    signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel);
    deps.signal?.removeEventListener('abort', cancel);
  }
}
