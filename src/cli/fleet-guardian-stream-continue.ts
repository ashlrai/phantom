import { Readable } from 'node:stream';
import { cmdFleetGuardianContinue } from './fleet-guardian-continue.js';

const LIMIT = 32 * 1024;
const values = new Set(['--manifest', '--output-dir', '--max-retries', '--timeout-ms', '--stop-file', '--duration-ms', '--interval-ms', '--idle-backoff-max-ms', '--max-passes']);
values.add('--input-timeout-ms');
const switches = new Set(['--stdin', '--apply', '--json', '--stream']);
type Deps = {
  input?: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>;
  delegate?: typeof cmdFleetGuardianContinue;
};

export const cmdFleetGuardianStreamContinue = async (args: string[], deps: Deps = {}): Promise<number> => {
  const seen = new Set<string>();
  const forwarded: string[] = [];
  let timeout = 30_000;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag) || (!switches.has(flag) && !values.has(flag))
      || (values.has(flag) && (!args[i + 1] || args[i + 1]!.startsWith('--')))) {
      process.stderr.write('error: invalid guardian-stream-continue arguments\n'); return 2;
    }
    seen.add(flag);
    if (flag === '--input-timeout-ms') {
      const value = args[++i]!;
      if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 300_000) {
        process.stderr.write('error: invalid guardian-stream-continue arguments\n'); return 2;
      }
      timeout = Number(value);
    } else {
      forwarded.push(flag);
      if (values.has(flag)) forwarded.push(args[++i]!);
    }
  }
  if (!seen.has('--stdin') || (seen.has('--json') && seen.has('--stream'))) {
    process.stderr.write('error: invalid guardian-stream-continue arguments\n'); return 2;
  }
  let summary: string | undefined;
  const line = Buffer.allocUnsafe(LIMIT);
  let length = 0;
  const acceptLine = (): void => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(line.subarray(0, length));
    length = 0;
    if (!text.trim()) return;
    if (summary !== undefined) throw new Error();
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = (value as Record<string, unknown>).record;
    if (record === 'summary') summary = text;
    else if (record !== 'attempt' && record !== 'pass') throw new Error();
  };
  const input = deps.input ?? process.stdin;
  let cleanup = (): void => {};
  let next: () => Promise<IteratorResult<string | Uint8Array>>;
  if (input instanceof Readable) {
    let wake: (() => void) | undefined;
    let failure: unknown;
    const ready = (): void => { wake?.(); };
    const failed = (error: Error): void => { failure = error; ready(); };
    input.on('readable', ready);
    input.on('end', ready);
    input.on('error', failed);
    cleanup = () => {
      input.off('readable', ready); input.off('end', ready); input.off('error', failed);
    };
    next = async () => {
      while (true) {
        if (failure) throw failure;
        const chunk: string | Uint8Array | null = input.read() as string | Uint8Array | null;
        if (chunk !== null) return { value: chunk, done: false };
        if (input.readableEnded) return { value: undefined, done: true };
        await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
      }
    };
  } else {
    try {
      const iterator = Symbol.asyncIterator in input ? input[Symbol.asyncIterator]() : input[Symbol.iterator]();
      next = async () => iterator.next();
      cleanup = () => { try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* best effort */ } };
    } catch {
      process.stderr.write('error: invalid guardian-stream-continue stream\n'); return 2;
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), timeout); });
  try {
    while (true) {
      const result = await Promise.race([next(), deadline]);
      if (result.done) break;
      const chunk = result.value;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (let offset = 0; offset < bytes.length;) {
        const end = bytes.indexOf(10, offset);
        const stop = end < 0 ? bytes.length : end;
        const count = stop - offset;
        if (length + count > LIMIT) throw new Error();
        line.set(bytes.subarray(offset, stop), length);
        length += count;
        if (end < 0) break;
        acceptLine();
        offset = end + 1;
      }
    }
    if (length !== 0 || summary === undefined) throw new Error();
  } catch {
    process.stderr.write('error: invalid guardian-stream-continue stream\n'); return 2;
  } finally {
    clearTimeout(timer);
    cleanup();
  }
  return (deps.delegate ?? cmdFleetGuardianContinue)(forwarded, { readInput: async () => summary! });
};
