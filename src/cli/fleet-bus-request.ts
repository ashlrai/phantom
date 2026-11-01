import { dirname, isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_BUS_ENVELOPE_BYTES, parseBusEnvelope } from '../core/fleet/bus-envelope.js';
import { type BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { requestBusRoundtrip, type RequestDependencies, type RequestResult } from '../core/fleet/bus-request-roundtrip.js';
import { readBusRequestStdin } from '../core/fleet/bus-request-stdin.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

interface Dependencies extends RequestDependencies { output?: (text: string) => void; input?: Readable }

function redactFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFields);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /(?:api[_-]?key|token|secret|password|passwd|pwd|credentials?|private[_-]?key|access[_-]?key|auth(?:orization)?|connection[_-]?string)$/i.test(key)
      ? '[REDACTED]' : redactFields(item)]));
}

/** Convention-resolved CLI entry. Requests emit one scrubbed JSON receipt. */
export async function cmdFleetBusRequest(args: string[], options: BusInboxOptions = {}, deps: Dependencies = {}): Promise<number> {
  const start = performance.now();
  const invalid = (): RequestResult => ({ schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only', receipt: { status: 'not-attempted' },
    outcome: 'invalid-input', reply: null, cursor: 0, elapsedMs: Math.max(0, Math.floor(performance.now() - start)) });
  const emit = (result: RequestResult): number => {
    try { (deps.output ?? console.log)(JSON.stringify(sanitizePublicJson(redactFields(result)))); }
    catch { return 1; }
    return result.outcome === 'replied' ? 0 : result.outcome === 'invalid-input' ? 2 : 1;
  };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    try { (deps.output ?? console.log)(`ashlr fleet bus-request --file <absolute-path|-> --timeout-ms <ms> [--interval-ms <ms>]\nUse --file - to read one UTF-8 JSON envelope from stdin (maximum ${MAX_BUS_ENVELOPE_BYTES} bytes). Input and reply share the invocation timeout.\nRouting labels do not authenticate peers.`); return 0; }
    catch { return 1; }
  }
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const match = /^(--file|--timeout-ms|--interval-ms)(?:=(.*))?$/.exec(args[i]!);
    if (!match || Object.hasOwn(values, match[1]!)) return emit(invalid());
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--')) return emit(invalid());
    values[match[1]!] = value;
  }
  const number = (value: string | undefined): number => value && /^\d+$/.test(value) ? Number(value) : NaN;
  const timeout = number(values['--timeout-ms']), interval = values['--interval-ms'] === undefined ? 250 : number(values['--interval-ms']);
  const file = values['--file'];
  if (!file || (file !== '-' && !isAbsolute(file)) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000 ||
      !Number.isSafeInteger(interval) || interval < 100 || interval > 60000) return emit(invalid());
  const controller = new AbortController(), stop = (): void => controller.abort();
  deps.signal?.addEventListener('abort', stop, { once: true });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (deps.signal?.aborted) stop();
    if (controller.signal.aborted) return emit({ ...invalid(), outcome: 'cancelled' });
    let text: string;
    if (file === '-') {
      const read = await readBusRequestStdin(deps.input ?? process.stdin, start + timeout, controller.signal);
      if (read.status !== 'ok') return emit({ ...invalid(), outcome: read.status });
      text = read.text;
    } else {
      let read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: MAX_BUS_ENVELOPE_BYTES, remainingBytes: MAX_BUS_ENVELOPE_BYTES });
      while (!read.ok && read.reason === 'changed-during-read') {
        const remaining = start + timeout - performance.now();
        if (remaining <= 0) return emit({ ...invalid(), outcome: 'timeout' });
        try { await delay(Math.min(interval, remaining), undefined, { signal: controller.signal }); } catch { return emit({ ...invalid(), outcome: 'cancelled' }); }
        if (performance.now() >= start + timeout) return emit({ ...invalid(), outcome: 'timeout' });
        read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: MAX_BUS_ENVELOPE_BYTES, remainingBytes: MAX_BUS_ENVELOPE_BYTES });
      }
      if (!read.ok) return emit(invalid());
      text = read.text;
    }
    const parsed = parseBusEnvelope(text);
    if (!parsed.ok) return emit(invalid());
    return emit(await requestBusRoundtrip(parsed.value, timeout, interval, options, { ...deps, signal: controller.signal, startedAt: start }));
  } finally {
    deps.signal?.removeEventListener('abort', stop);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}
