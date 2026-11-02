import { isAbsolute, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { cmdFleetGuardianResume } from './fleet-guardian-resume.js';

const LIMIT = 32 * 1024;
const valueFlags = new Set(['--manifest', '--output-dir', '--max-retries', '--timeout-ms', '--stop-file', '--duration-ms', '--interval-ms', '--idle-backoff-max-ms', '--input-timeout-ms']);
const switches = new Set(['--stdin', '--apply', '--json', '--stream']);
const terminations = new Set(['planned', 'no-work', 'drained', 'exhausted', 'max-retries', 'stopped', 'deadline', 'refused', 'collision', 'cancelled', 'unsafe', 'observer-error', 'duration']);

type ResumeDeps = NonNullable<Parameters<typeof cmdFleetGuardianResume>[1]>;
type ContinueDeps = ResumeDeps & {
  readInput?: (signal: AbortSignal) => Promise<string | Uint8Array>;
  inputStream?: Readable;
  resume?: typeof cmdFleetGuardianResume;
};

function readStdin(stream: Readable, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolveInput, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onError = (): void => { cleanup(); reject(new Error()); };
    const onAbort = (): void => { cleanup(); reject(new Error()); };
    const onEnd = (): void => { cleanup(); resolveInput(Buffer.concat(chunks)); };
    const onReadable = (): void => {
      let chunk: Buffer | string | null;
      while ((chunk = stream.read() as Buffer | string | null) !== null) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > LIMIT) { onError(); return; }
        chunks.push(bytes);
      }
    };
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (stream.readableEnded) onEnd();
    else onReadable();
  });
}

function sessionFrom(input: string | Uint8Array): string | null {
  const bytes = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
  if (bytes.length > LIMIT) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  const count = (n: unknown): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const drain = Array.isArray(s.attempted) && Array.isArray(s.planned);
  const loop = count(s.passes);
  if (s.mode !== 'apply' || (s.record !== undefined && s.record !== 'summary') || s.truncated !== undefined
    || typeof s.termination !== 'string' || !terminations.has(s.termination)
    || !count(s.attempts) || !count(s.verified) || !count(s.refused) || (!drain && !loop)
    || !Object.hasOwn(s, 'latestOutput') || !(s.latestOutput === null || typeof s.latestOutput === 'string')
    || typeof s.session !== 'string' || !isAbsolute(s.session) || s.session.length > 4096
    || s.session.includes('\0') || resolve(s.session) !== s.session) return null;
  return s.session;
}

// The input identifies a session only. Resume validates the private checkpoint
// and owns all continuation behavior, including whether apply is requested.
export const cmdFleetGuardianContinue = async (args: string[], deps: ContinueDeps = {}): Promise<number> => {
  const seen = new Set<string>();
  let inputTimeout = 30_000;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag) || (!switches.has(flag) && !valueFlags.has(flag))) {
      process.stderr.write('error: invalid guardian-continue arguments\n'); return 2;
    }
    seen.add(flag);
    if (valueFlags.has(flag) && (!args[i + 1] || args[i + 1]!.startsWith('--'))) {
      process.stderr.write('error: invalid guardian-continue arguments\n'); return 2;
    }
    if (valueFlags.has(flag)) {
      const value = args[++i]!;
      if (flag === '--input-timeout-ms') {
        if (!/^[1-9]\d*$/.test(value) || Number(value) > 300_000) {
          process.stderr.write('error: invalid guardian-continue arguments\n'); return 2;
        }
        inputTimeout = Number(value);
      } else forwarded.push(flag, value);
    } else if (flag !== '--stdin') forwarded.push(flag);
  }
  if (!seen.has('--stdin') || (seen.has('--json') && seen.has('--stream'))) {
    process.stderr.write('error: invalid guardian-continue arguments\n'); return 2;
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = Symbol('input timeout');
  let input: string | Uint8Array | typeof timeout;
  try {
    const deadline = new Promise<typeof timeout>(resolveDeadline => {
      timer = setTimeout(() => { resolveDeadline(timeout); controller.abort(); }, inputTimeout);
    });
    const read = deps.readInput ?? ((signal: AbortSignal) => readStdin(deps.inputStream ?? process.stdin, signal));
    input = await Promise.race([Promise.resolve().then(() => read(controller.signal)), deadline]);
  } catch {
    process.stderr.write('error: invalid guardian-continue summary\n'); return 2;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
  if (input === timeout) { process.stderr.write('error: guardian-continue input timed out\n'); return 2; }
  const session = sessionFrom(input);
  if (session === null) { process.stderr.write('error: invalid guardian-continue summary\n'); return 2; }
  const { readInput: _readInput, inputStream: _inputStream, resume, ...resumeDeps } = deps;
  return (resume ?? cmdFleetGuardianResume)(['--checkpoint-dir', session, ...forwarded], resumeDeps);
};
