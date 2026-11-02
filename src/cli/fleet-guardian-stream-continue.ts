import { cmdFleetGuardianContinue } from './fleet-guardian-continue.js';

const LIMIT = 32 * 1024;
const values = new Set(['--manifest', '--output-dir', '--max-retries', '--timeout-ms', '--stop-file', '--duration-ms', '--interval-ms', '--idle-backoff-max-ms']);
const switches = new Set(['--stdin', '--apply', '--json', '--stream']);
type Deps = {
  input?: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>;
  delegate?: typeof cmdFleetGuardianContinue;
};

export const cmdFleetGuardianStreamContinue = async (args: string[], deps: Deps = {}): Promise<number> => {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag) || (!switches.has(flag) && !values.has(flag))
      || (values.has(flag) && (!args[i + 1] || args[i + 1]!.startsWith('--')))) {
      process.stderr.write('error: invalid guardian-stream-continue arguments\n'); return 2;
    }
    seen.add(flag);
    if (values.has(flag)) i++;
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
  try {
    for await (const chunk of deps.input ?? process.stdin) {
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
  }
  return (deps.delegate ?? cmdFleetGuardianContinue)(args, { readInput: async () => summary! });
};
