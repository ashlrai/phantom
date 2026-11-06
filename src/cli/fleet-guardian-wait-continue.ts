import { isAbsolute, parse, resolve } from 'node:path';
import { cmdFleetGuardianContinue } from './fleet-guardian-continue.js';
import { readReceiptFile } from './fleet-self-loop-await.js';

type Delegate = typeof cmdFleetGuardianContinue;
export interface GuardianWaitContinueDependencies {
  read?: typeof readReceiptFile;
  delegate?: Delegate;
  /** Forwarded to guardian-continue (for example an injected `resume`). */
  continueDeps?: Parameters<Delegate>[1];
  output?: (line: string) => void;
  /** Monotonic milliseconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// Same ceiling guardian-continue applies to its stdin summary.
const LIMIT = 32 * 1024;
const DEFAULT_POLL_MS = 100;

const bounded = (raw: string | undefined, min: number, max: number): number | undefined => {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
};

// `fleet guardian-wait-continue --result-file <abs path> --wait-ms <1..60000>
// [--poll-ms <10..1000>] [guardian-continue args]` waits for the receipt that a
// concurrent `guardian-record` is still writing, then hands its bytes to
// guardian-continue exactly like guardian-continue-file does. --wait-ms is the
// total receipt wait and is unrelated to the downstream --timeout-ms. Only a
// missing file is polled, sequentially; the first receipt available is the one
// used. At most one continuation happens: waiting is not a retry policy, and
// --apply is never added here.
export async function cmdFleetGuardianWaitContinue(args: string[], deps: GuardianWaitContinueDependencies = {}): Promise<number> {
  const fail = (reason: string, code: number): number => {
    (deps.output ?? (line => { process.stderr.write(line); }))(`error: guardian-wait-continue: ${reason}\n`);
    return code;
  };
  let path: string | undefined;
  let wait: number | undefined;
  let poll: number | undefined;
  let waitSeen = false;
  let pollSeen = false;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--result-file') {
      const value = args[++i];
      if (path !== undefined || !value || !isAbsolute(value) || value.includes('\0')
        || resolve(value) !== value || value === parse(value).root) return fail('invalid arguments', 2);
      path = value;
    } else if (arg === '--wait-ms') {
      if (waitSeen) return fail('invalid arguments', 2);
      waitSeen = true;
      wait = bounded(args[++i], 1, 60_000);
    } else if (arg === '--poll-ms') {
      if (pollSeen) return fail('invalid arguments', 2);
      pollSeen = true;
      poll = bounded(args[++i], 10, 1000);
    } else if (arg === '--stdin') return fail('invalid arguments', 2);
    else forwarded.push(arg);
  }
  if (path === undefined || wait === undefined || (pollSeen && poll === undefined)) return fail('invalid arguments', 2);

  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const read = deps.read ?? readReceiptFile;
  const deadline = now() + wait;
  const interval = poll ?? Math.min(DEFAULT_POLL_MS, wait);
  const timedOut = Symbol('timed out');

  let bytes: Buffer | undefined;
  for (;;) {
    // The total deadline also bounds a read that never settles.
    let timer: NodeJS.Timeout | undefined;
    const pending = read(path);
    pending.catch(() => {});
    const result = await Promise.race([
      pending.catch(() => 'unreadable' as const),
      new Promise<typeof timedOut>(done => { timer = setTimeout(() => done(timedOut), Math.max(0, deadline - now())); }),
    ]).finally(() => clearTimeout(timer));
    if (result === timedOut) return fail('timed out waiting for receipt', 1);
    if (result === 'unreadable' || result.kind === 'refused') return fail('receipt unreadable', 2);
    if (result.kind === 'text') { bytes = Buffer.from(result.text, 'utf8'); break; }
    const remaining = deadline - now();
    if (remaining <= 0) return fail('timed out waiting for receipt', 1);
    await sleep(Math.min(interval, remaining));
    if (now() >= deadline) return fail('timed out waiting for receipt', 1);
  }
  if (bytes.length > LIMIT) return fail('receipt too large', 2);

  const captured = bytes;
  return (deps.delegate ?? cmdFleetGuardianContinue)(['--stdin', ...forwarded], { ...deps.continueDeps, readInput: async () => captured });
}
