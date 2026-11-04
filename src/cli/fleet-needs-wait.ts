import { NEEDS_WAIT_ID, NEEDS_WAIT_MAX_MS, waitNeedsMason, type NeedsWaitOptions } from '../core/fleet/needs-mason-wait.js';

const usage = 'Usage: ashlr fleet needs-wait <nm-id> --timeout-ms N [--poll-ms N] [--runs-dir DIR] [--stop-file PATH] [--json]';
export async function cmdFleetNeedsWait(args: string[], deps: Partial<Pick<NeedsWaitOptions, 'now' | 'sleep' | 'signal'>> & { emit?: (line: string) => void } = {}): Promise<number> {
  const emit = deps.emit ?? console.log;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { emit(usage); return 0; }
  const invalid = (): number => { process.stderr.write(`error: invalid arguments\n${usage}\n`); return 2; };
  const id = args[0];
  if (!id || !NEEDS_WAIT_ID.test(id)) return invalid();
  let timeoutMs = 0, pollMs = 1000, runsDir: string | undefined, stopFile: string | undefined, json = false;
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
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
  if (!timeoutMs) return invalid();
  const status = await waitNeedsMason({ id, timeoutMs, pollMs, runsDir, stopFile, now: deps.now, sleep: deps.sleep, signal: deps.signal });
  emit(json ? JSON.stringify({ status, id }) : `${status} ${id}`);
  return status === 'resolved' ? 0 : 1;
}
