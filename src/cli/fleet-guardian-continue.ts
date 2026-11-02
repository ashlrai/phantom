import { isAbsolute, resolve } from 'node:path';
import { cmdFleetGuardianResume } from './fleet-guardian-resume.js';

const LIMIT = 32 * 1024;
const valueFlags = new Set(['--manifest', '--output-dir', '--max-retries', '--timeout-ms', '--stop-file', '--duration-ms', '--interval-ms', '--idle-backoff-max-ms']);
const switches = new Set(['--stdin', '--apply', '--json', '--stream']);
const terminations = new Set(['planned', 'no-work', 'drained', 'exhausted', 'max-retries', 'stopped', 'deadline', 'refused', 'collision', 'cancelled', 'unsafe', 'observer-error', 'duration']);

type ResumeDeps = NonNullable<Parameters<typeof cmdFleetGuardianResume>[1]>;
type ContinueDeps = ResumeDeps & {
  readInput?: () => Promise<string | Uint8Array>;
  resume?: typeof cmdFleetGuardianResume;
};

async function readStdin(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > LIMIT) throw new Error();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
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
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag) || (!switches.has(flag) && !valueFlags.has(flag))) {
      process.stderr.write('error: invalid guardian-continue arguments\n'); return 2;
    }
    seen.add(flag);
    if (valueFlags.has(flag) && (!args[i + 1] || args[i + 1]!.startsWith('--'))) {
      process.stderr.write('error: invalid guardian-continue arguments\n'); return 2;
    }
    if (valueFlags.has(flag)) i++;
  }
  if (!seen.has('--stdin') || (seen.has('--json') && seen.has('--stream'))) {
    process.stderr.write('error: invalid guardian-continue arguments\n'); return 2;
  }
  let session: string | null;
  try { session = sessionFrom(await (deps.readInput ?? readStdin)()); } catch { session = null; }
  if (session === null) { process.stderr.write('error: invalid guardian-continue summary\n'); return 2; }
  const { readInput: _readInput, resume, ...resumeDeps } = deps;
  return (resume ?? cmdFleetGuardianResume)(['--checkpoint-dir', session, ...args.filter(arg => arg !== '--stdin')], resumeDeps);
};
