import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAppsRecoveryHistory } from '../core/fleet/apps-recovery-history.js';

const usage = 'Usage: ashlr fleet apps-history [--root <dir>] [--after <cursor>] [--limit <1..100>] [--invocation-id <uuid>] [--json]';
export async function cmdFleetAppsHistory(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const invalid = (): number => { console.error(`error: invalid fleet apps-history arguments\n${usage}`); return 2; };
  let root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), after = 0, limit = 25, invocationId: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!['--root', '--after', '--limit', '--invocation-id', '--json'].includes(arg) || seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') continue;
    const value = args[++i];
    if (!value || value.startsWith('-')) return invalid();
    if (arg === '--root') root = value;
    else if (arg === '--invocation-id') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return invalid();
      invocationId = value;
    } else {
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid();
      if (arg === '--after') after = Number(value);
      else { limit = Number(value); if (limit < 1 || limit > 100) return invalid(); }
    }
  }
  const result = readAppsRecoveryHistory(root, after, limit, invocationId);
  console.log(JSON.stringify(result));
  return result.availability === 'available' ? 0 : result.availability === 'invalid-cursor' ? 2 : 1;
}
