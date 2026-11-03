import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readRecoveryBatchRequest, validateRecoveryBatchRequest, writeRecoveryBatchRequest } from '../core/fleet/apps-recovery-batch-request.js';
import { cmdFleetAppsRecoveryBatch } from './fleet-apps-recovery-batch.js';

const usage = 'Usage: ashlr fleet apps-recovery-resume --request <path> [--invocation <uuid> ...] --max-age-ms <n> --duration-ms <n> [--interval-ms <n>] [--root <dir>] [--stop-file <path>] [--wait-all] [--stream] [--json]';

type Deps = { waiter?: typeof cmdFleetAppsRecoveryBatch };
export async function cmdFleetAppsRecoveryResume(args: string[], deps: Deps = {}): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0; }
  const invalid = (): number => { console.error(`error: invalid arguments\n${usage}`); return 2; };
  const seen = new Set<string>(), ids: string[] = [], forwarded: string[] = [];
  let requestPath = '', root: string | undefined, maxAge = 0, duration = 0, interval = 1000;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!['--request', '--invocation', '--root', '--max-age-ms', '--duration-ms', '--interval-ms', '--stop-file', '--wait-all', '--stream', '--json'].includes(arg) || (arg !== '--invocation' && seen.has(arg))) return invalid();
    seen.add(arg);
    if (['--wait-all', '--stream', '--json'].includes(arg)) { forwarded.push(arg); continue; }
    const value = args[++i];
    if (!value || value.startsWith('-') || value.includes('\0')) return invalid();
    if (arg === '--request') requestPath = value;
    else if (arg === '--invocation') ids.push(value.toLowerCase());
    else if (arg === '--root') root = resolve(value);
    else if (arg === '--stop-file') forwarded.push(arg, value);
    else {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid();
      const n = Number(value);
      if (arg === '--max-age-ms') maxAge = n;
      else if (arg === '--duration-ms') duration = n;
      else interval = n;
      forwarded.push(arg, value);
    }
  }
  if (!requestPath || maxAge < 1 || duration < 1 || duration > 300000 || interval < 100 || interval > 60000) return invalid();
  let request;
  if (ids.length) {
    try {
      const selectedRoot = root ?? (process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'));
      if (!selectedRoot || selectedRoot.includes('\0')) return invalid();
      request = validateRecoveryBatchRequest({ version: 1, invocationIds: ids, root: resolve(selectedRoot) });
    }
    catch { return invalid(); }
  }
  try {
    if (request) {
      writeRecoveryBatchRequest(requestPath, request);
    } else {
      request = readRecoveryBatchRequest(requestPath);
      if (root !== undefined && root !== request.root) return invalid();
    }
  } catch { console.error('error: unable to create or read recovery request'); return 1; }
  return (deps.waiter ?? cmdFleetAppsRecoveryBatch)([...request.invocationIds.flatMap(id => ['--invocation', id]), '--root', request.root, ...forwarded]);
}
