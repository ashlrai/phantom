/**
 * Refreshes Claude's native weekly reading when the `claude` lane is held, so
 * reset-release sees a real reset instead of waiting for a hand-run
 * `fleet claude-quota --write`. Never throws; stores only what
 * toClaudeQuotaReading keeps (window ids, percentages, reset times).
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { probeClaudeAccountUsage, type ClaudeAccountUsageResult } from '../resources/claude-account-usage.js';
import type { ClaudeAccountStatusOptions } from '../resources/claude-account-status.js';
import { readLaneTargets } from './runs-lane-targets.js';
import { readClaudeQuotaReading, toClaudeQuotaReading, writeClaudeQuotaReading } from './claude-quota-reading.js';

export type ClaudeProbeOutcome = 'not-held' | 'fresh' | 'probed' | 'unavailable';
export type Probe = (options: ClaudeAccountStatusOptions) => Promise<ClaudeAccountUsageResult>;

const DEFAULT_MAX_AGE_MS = 30 * 60_000;

export function findClaude(pathEnv = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'claude');
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate; } } catch { /* next */ }
  }
  return null;
}

export async function refreshHeldClaudeQuota(opts: {
  runsDir: string; now: () => number; probe?: Probe; findCommand?: () => string | null; maxAgeMs?: number;
}): Promise<ClaudeProbeOutcome> {
  try {
    const nowMs = opts.now();
    const targets = await readLaneTargets({ runsDir: opts.runsDir, now: () => new Date(nowMs) });
    if (!targets.lanes.some(l => l.lane === 'claude' && l.held)) return 'not-held';
    const existing = await readClaudeQuotaReading(opts.runsDir);
    if (existing) {
      const age = nowMs - Date.parse(existing.observedAt);
      if (age >= 0 && age < (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) return 'fresh';
    }
    const command = (opts.findCommand ?? findClaude)();
    if (!command) return 'unavailable';
    const result = await (opts.probe ?? probeClaudeAccountUsage)({ command: [command], cwd: opts.runsDir, timeoutMs: 20_000 });
    await writeClaudeQuotaReading(opts.runsDir, toClaudeQuotaReading(result, new Date(nowMs).toISOString()));
    return 'probed';
  } catch {
    return 'unavailable';
  }
}
