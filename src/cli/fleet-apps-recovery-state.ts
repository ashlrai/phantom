import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAppsRecoveryInvocations } from '../core/fleet/apps-recovery-invocations.js';

const usage = 'Usage: ashlr fleet apps-recovery-state [--root <dir>] [--json]';
export async function cmdFleetAppsRecoveryState(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!['--root', '--json'].includes(arg) || seen.has(arg)) { console.error(`error: invalid arguments\n${usage}`); return 2; }
    seen.add(arg);
    if (arg === '--root') {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(`error: invalid arguments\n${usage}`); return 2; }
      root = value;
    }
  }
  const result = readAppsRecoveryInvocations(root);
  console.log(JSON.stringify(result));
  return result.availability === 'available' ? 0 : 1;
}
