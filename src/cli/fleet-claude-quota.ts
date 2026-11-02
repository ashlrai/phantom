/** Records Claude's native weekly usage for the resource ledger; writes only with --write. */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  readClaudeQuotaReading, toClaudeQuotaReading, writeClaudeQuotaReading,
  type ClaudeQuotaReadingV1,
} from '../core/fleet/claude-quota-reading.js';
import { probeClaudeAccountUsage, type ClaudeAccountUsageResult } from '../core/resources/claude-account-usage.js';
import type { ClaudeAccountStatusOptions } from '../core/resources/claude-account-status.js';

const usage = 'Usage: ashlr fleet claude-quota [--root <dir>] [--write] [--json]';
export type Probe = (options: ClaudeAccountStatusOptions) => Promise<ClaudeAccountUsageResult>;

function findClaude(pathEnv = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'claude');
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate; } } catch { /* next */ }
  }
  return null;
}

export function formatClaudeQuota(reading: ClaudeQuotaReadingV1): string {
  if (!reading.windows.length) return `claude quota unavailable: ${reading.reason}`;
  return reading.windows.map(w => `${w.id}: ${w.usedPct}% resets ${w.resetAt ?? 'unknown'}`).join('\n');
}

/**
 * One bounded refresh of the stored Claude weekly reading. With minAgeMs > 0 a
 * stored reading observed within that window — and not in the future — is
 * returned 'skipped-fresh' without spawning the probe, which bounds how often
 * the claude CLI runs when a caller (self-tick) fires on a timer. write persists
 * the reading; a write failure throws so the caller can mark the step failed.
 */
export async function refreshClaudeQuota(opts: {
  root: string;
  write: boolean;
  probe?: Probe;
  now?: () => Date;
  findCommand?: () => string | null;
  minAgeMs?: number;
}): Promise<{ state: 'probed' | 'skipped-fresh'; reading: ClaudeQuotaReadingV1 }> {
  const now = opts.now ?? (() => new Date());
  const minAgeMs = opts.minAgeMs ?? 0;
  if (minAgeMs > 0) {
    const existing = await readClaudeQuotaReading(opts.root);
    if (existing !== null) {
      const at = Date.parse(existing.observedAt);
      const nowMs = now().getTime();
      if (Number.isFinite(at) && at <= nowMs && nowMs - at <= minAgeMs) {
        return { state: 'skipped-fresh', reading: existing };
      }
    }
  }
  const observedAt = now().toISOString();
  let reading: ClaudeQuotaReadingV1;
  const command = (opts.findCommand ?? findClaude)();
  if (!command) reading = { v: 1, observedAt, reason: 'claude-not-found', fresh: false, windows: [] };
  else {
    const probe = opts.probe ?? probeClaudeAccountUsage;
    try { reading = toClaudeQuotaReading(await probe({ command: [command], cwd: opts.root, timeoutMs: 20_000 }), observedAt); }
    catch { reading = { v: 1, observedAt, reason: 'probe-failed', fresh: false, windows: [] }; }
  }
  if (opts.write) await writeClaudeQuotaReading(opts.root, reading);
  return { state: 'probed', reading };
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
