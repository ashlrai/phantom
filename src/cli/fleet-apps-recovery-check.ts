import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAppsRecoveryInvocations } from '../core/fleet/apps-recovery-invocations.js';
import { appsRecoveryVerdict } from '../core/fleet/apps-recovery-verdict.js';

const usage = 'Usage: ashlr fleet apps-recovery-check --invocation <uuid> --max-age-ms <positive integer> [--root <dir>] [--json]';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function cmdFleetAppsRecoveryCheck(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let invocation = '', maxAgeMs = 0;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!['--root', '--json', '--invocation', '--max-age-ms'].includes(arg) || seen.has(arg)) {
      console.error(`error: invalid arguments\n${usage}`); return 2;
    }
    seen.add(arg);
    if (arg === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('-')) { console.error(`error: invalid arguments\n${usage}`); return 2; }
    if (arg === '--root') root = value;
    if (arg === '--invocation') invocation = value;
    if (arg === '--max-age-ms') maxAgeMs = /^\d+$/.test(value) ? Number(value) : 0;
  }
  if (!uuid.test(invocation) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    console.error(`error: invalid arguments\n${usage}`); return 2;
  }
  const result = appsRecoveryVerdict(readAppsRecoveryInvocations(root), invocation, maxAgeMs, Date.now());
  console.log(JSON.stringify(result));
  return result.verdict === 'healthy' ? 0 : 1;
}
