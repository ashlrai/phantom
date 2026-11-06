import { NEEDS_WAIT_MAX_MS } from '../core/fleet/needs-mason-wait.js';
import { NEEDS_WAIT_GROUP_MAX_IDS, validateNeedsWaitGroup, waitNeedsMasonGroup, type NeedsWaitGroupOptions } from '../core/fleet/needs-mason-wait-group.js';

const usage = 'Usage: ashlr fleet needs-wait-group <nm-id>... --timeout-ms N [--poll-ms N] [--runs-dir DIR] [--stop-file PATH] [--json]';
export async function cmdFleetNeedsWaitGroup(args: string[], deps: Partial<Pick<NeedsWaitGroupOptions, 'now' | 'sleep' | 'budgetSleep' | 'signal' | 'stopExists' | 'stopSleep'>> & { emit?: (line: string) => void } = {}): Promise<number> {
  const emit = deps.emit ?? console.log;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { emit(`${usage}\nSIGINT or SIGTERM cancels unresolved items and exits 130.`); return 0; }
  const invalid = (): number => { process.stderr.write(`error: invalid arguments\n${usage}\n`); return 2; };
  const ids: string[] = [];
  let timeoutMs = 0, pollMs = 1000, runsDir: string | undefined, stopFile: string | undefined, json = false, i = 0;
  while (i < args.length && !args[i]!.startsWith('-')) { if (ids.length > NEEDS_WAIT_GROUP_MAX_IDS) return invalid(); ids.push(args[i++]!); }
  const seen = new Set<string>();
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--timeout-ms', '--poll-ms', '--runs-dir', '--stop-file', '--json'].includes(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') { json = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('-')) return invalid();
    if (arg === '--runs-dir') { runsDir = value; continue; }
    if (arg === '--stop-file') { stopFile = value; continue; }
    if (!/^\d+$/.test(value)) return invalid();
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > NEEDS_WAIT_MAX_MS) return invalid();
    if (arg === '--timeout-ms') timeoutMs = n; else pollMs = n;
  }
  if (!timeoutMs || !validateNeedsWaitGroup(ids, timeoutMs, pollMs)) return invalid();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  deps.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (deps.signal?.aborted) abort();
    const { outcome, items } = await waitNeedsMasonGroup({ ids, timeoutMs, pollMs, runsDir, now: deps.now, sleep: deps.sleep, budgetSleep: deps.budgetSleep, signal: controller.signal, stopFile, stopExists: deps.stopExists, stopSleep: deps.stopSleep });
    emit(json ? JSON.stringify({ outcome, items }) : [`${outcome} (${items.length} ids)`, ...items.map(it => `${it.status} ${it.id}`)].join('\n'));
    return outcome === 'resolved' ? 0 : outcome === 'cancelled' ? 130 : 1;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    deps.signal?.removeEventListener('abort', abort);
  }
}
