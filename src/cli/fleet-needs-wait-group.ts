import { type Readable } from 'node:stream';
import { NEEDS_WAIT_MAX_MS } from '../core/fleet/needs-mason-wait.js';
import { NEEDS_WAIT_GROUP_MAX_IDS, validateNeedsWaitGroup, waitNeedsMasonGroup, type NeedsWaitGroupOptions } from '../core/fleet/needs-mason-wait-group.js';

const MAX_INPUT_BYTES = 16 * 1024;
const usage = 'Usage: ashlr fleet needs-wait-group <nm-id>... --timeout-ms N [--poll-ms N] [--runs-dir DIR] [--stop-file PATH] [--json]\n  --ids-stdin: read a JSON array of ids from stdin (mutually exclusive with positional ids).';
export async function cmdFleetNeedsWaitGroup(args: string[], deps: Partial<Pick<NeedsWaitGroupOptions, 'now' | 'sleep' | 'budgetSleep' | 'signal' | 'stopExists' | 'stopSleep'>> & { emit?: (line: string) => void; input?: Readable } = {}): Promise<number> {
  const emit = deps.emit ?? console.log;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { emit(`${usage}\nExample: echo '["nm-aabbccdd1122","nm-aabbccdd3344"]' | ashlr fleet needs-wait-group --ids-stdin --timeout-ms 60000\nSIGINT or SIGTERM cancels unresolved items and exits 130.`); return 0; }
  const invalid = (): number => { process.stderr.write(`error: invalid arguments\n${usage}\n`); return 2; };
  let timeoutMs = 0, pollMs = 1000, runsDir: string | undefined, stopFile: string | undefined, json = false, ids: string[] | null = null, i = 0;
  let stdinMode = false;
  // Scan args for --ids-stdin flag and parse options
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--ids-stdin') {
      if (stdinMode) return invalid();
      stdinMode = true;
      continue;
    }
    if (arg.startsWith('-') && !arg.startsWith('--')) return invalid();
  }
  // Shared controller: created early so signal handlers from collection reach it
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  deps.signal?.addEventListener('abort', abort, { once: true });
  try {
    // Parse positional args and flags, validating structure before reading stdin
    if (stdinMode) {
      // Collect positional ids: must be empty when --ids-stdin is present
      i = 0;
      while (i < args.length && !args[i]!.startsWith('-')) {
        if (ids === null) ids = [];
        return invalid(); // no positional ids allowed with --ids-stdin
      }
      const seen = new Set<string>();
      for (i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--ids-stdin') continue;
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
      if (!timeoutMs) return invalid();
      // Read stdin: collect bytes, validate, parse JSON array
      const bytes = await collectStdin(deps.input ?? process.stdin, MAX_INPUT_BYTES, timeoutMs, deps.signal, abort, controller);
      if (bytes === null) {
        // Signal arrived during collection: run the wait group which returns cancelled (130)
        if (controller.signal.aborted) {
          ids = ['nm-000000000000'];
        } else {
          return invalid();
        }
      } else {
        let parsed: unknown;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { return invalid(); }
        if (!Array.isArray(parsed)) return invalid();
        if (parsed.length === 0) return invalid();
        if (parsed.length > NEEDS_WAIT_GROUP_MAX_IDS) return invalid();
        for (const item of parsed) {
          if (typeof item !== 'string') return invalid();
        }
        ids = parsed as string[];
      }
    } else {
      // Original positional-id path: unchanged behavior
      ids = [];
      for (i = 0; i < args.length && !args[i]!.startsWith('-'); i++) {
        if (ids.length > NEEDS_WAIT_GROUP_MAX_IDS) return invalid();
        ids.push(args[i]!);
      }
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
    }
    if (!timeoutMs || !validateNeedsWaitGroup(ids, timeoutMs, pollMs)) return invalid();
    if (deps.signal?.aborted) abort();
    const { outcome, items } = await waitNeedsMasonGroup({ ids, timeoutMs, pollMs, runsDir, now: deps.now, sleep: deps.sleep, budgetSleep: deps.budgetSleep, signal: controller.signal, stopFile, stopExists: deps.stopExists, stopSleep: deps.stopSleep });
    emit(json ? JSON.stringify({ outcome, items }) : [`${outcome} (${items.length} ids)`, ...items.map(it => `${it.status} ${it.id}`)].join('\n'));
    return outcome === 'resolved' ? 0 : outcome === 'cancelled' ? 130 : 1;
  } finally {
    process.off('SIGINT', abort); process.off('SIGTERM', abort);
    deps.signal?.removeEventListener('abort', abort);
  }
}

function collectStdin(input: Readable, maxBytes: number, timeoutMs: number, parentSignal?: AbortSignal, onAbort?: () => void, outerController?: AbortController): Promise<Buffer | null> {
  if (input.isTTY || input.readableEnded || input.destroyed || parentSignal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout>;
    const detach = (): void => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      input.removeListener('close', onEnd);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      parentSignal?.removeEventListener('abort', onParentAbort);
      input.pause();
    };
    const finish = (value: Buffer | null): void => { detach(); resolve(value); };
    // Timeout-based failure: does NOT call onAbort (just returns null → invalid arguments)
    timer = setTimeout(() => finish(null), timeoutMs);
    const onEnd = (): void => finish(Buffer.concat(chunks, size));
    const onSigint = (): void => { detach(); if (onAbort) onAbort(); finish(null); };
    const onSigterm = (): void => { detach(); if (onAbort) onAbort(); finish(null); };
    const onParentAbort = (): void => { detach(); finish(null); };
    const onData = (chunk: unknown): void => {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return finish(null);
      size += chunk.byteLength;
      if (size > maxBytes) return finish(null);
      chunks.push(Buffer.from(chunk));
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
    input.once('close', onEnd);
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    if (input.readableEnded || input.destroyed || parentSignal?.aborted) finish(null);
  });
}
