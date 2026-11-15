/** Records Claude's native weekly usage for the resource ledger; writes only with --write. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  refreshClaudeQuota, type ClaudeQuotaReadingV1, type ClaudeQuotaProbe as Probe,
} from '../core/fleet/claude-quota-reading.js';
import { probeClaudeAccountUsage } from '../core/resources/claude-account-usage.js';

const usage = 'Usage: ashlr fleet claude-quota [--root <dir>] [--write] [--json]';

export function formatClaudeQuota(reading: ClaudeQuotaReadingV1): string {
  if (!reading.windows.length) return `claude quota unavailable: ${reading.reason}`;
  return reading.windows.map(w => `${w.id}: ${w.usedPct}% resets ${w.resetAt ?? 'unknown'}`).join('\n');
}

export async function cmdFleetClaudeQuota(args: string[], probe: Probe = probeClaudeAccountUsage, now = () => new Date()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nProbes Claude's native weekly usage once. With --write, stores the percentages (no account details) at <root>/metrics/claude-quota.json (default ~/.ashlr-runs) for the resource ledger. Exits 0 even when no fresh reading is available.`);
    return 0;
  }
  let root = join(homedir(), '.ashlr-runs');
  let json = false; let write = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg) || !['--json', '--write', '--root'].includes(arg)) { console.error(`error: invalid fleet claude-quota arguments\n${usage}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--write') write = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('-')) { console.error(`error: --root needs a directory\n${usage}`); return 2; }
      root = value;
    }
  }
  let reading: ClaudeQuotaReadingV1;
  try {
    ({ reading } = await refreshClaudeQuota({ root, write, probe, now }));
  } catch {
    console.error('fleet claude-quota: could not write reading');
    return 1;
  }
  console.log(json ? JSON.stringify(reading) : formatClaudeQuota(reading));
  return 0;
}
