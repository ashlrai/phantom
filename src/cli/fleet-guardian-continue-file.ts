import { isAbsolute, parse, resolve } from 'node:path';
import { cmdFleetGuardianContinue } from './fleet-guardian-continue.js';
import { readReceiptFile } from './fleet-self-loop-await.js';

type Delegate = typeof cmdFleetGuardianContinue;
export interface GuardianContinueFileDependencies {
  read?: typeof readReceiptFile;
  delegate?: Delegate;
  /** Forwarded to guardian-continue (for example an injected `resume`). */
  continueDeps?: Parameters<Delegate>[1];
  output?: (line: string) => void;
}

// Same ceiling guardian-continue applies to its stdin summary.
const LIMIT = 32 * 1024;

// `fleet guardian-continue-file --result-file <abs path> [guardian-continue args]`
// reads the private receipt written by `guardian-record` through the bounded
// no-follow reader and hands its bytes to guardian-continue as if they came on
// stdin. Checkpoint validation, preview/apply and the exit code stay with that
// command; this one never adds --apply, retries, or writes anything.
export async function cmdFleetGuardianContinueFile(args: string[], deps: GuardianContinueFileDependencies = {}): Promise<number> {
  const fail = (reason: string, code: number): number => {
    (deps.output ?? (line => { process.stderr.write(line); }))(`error: guardian-continue-file: ${reason}\n`);
    return code;
  };
  let path: string | undefined;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--result-file') {
      const value = args[++i];
      if (path !== undefined || !value || !isAbsolute(value) || value.includes('\0')
        || resolve(value) !== value || value === parse(value).root) return fail('invalid arguments', 2);
      path = value;
    } else if (arg === '--stdin') return fail('invalid arguments', 2);
    else forwarded.push(arg);
  }
  if (path === undefined) return fail('invalid arguments', 2);

  let bytes: Buffer;
  try {
    const result = await (deps.read ?? readReceiptFile)(path);
    if (result.kind === 'missing') return fail('receipt missing', 2);
    if (result.kind === 'refused') return fail('receipt unreadable', 2);
    bytes = Buffer.from(result.text, 'utf8');
  } catch { return fail('receipt unreadable', 2); }
  if (bytes.length > LIMIT) return fail('receipt too large', 2);

  return (deps.delegate ?? cmdFleetGuardianContinue)(['--stdin', ...forwarded], { ...deps.continueDeps, readInput: async () => bytes });
}
