import { homedir } from 'node:os';
import { join } from 'node:path';
import { readResourceLedger, type ResourceLedgerV1 } from '../core/fleet/runs-resource-ledger.js';
import { probePersonalQuota } from '../core/fleet/personal-quota-probe.js';
import type { CodexSessionUsage } from '../core/fleet/codex-session-usage.js';

const MAX_AGE = 2 * 60 * 60 * 1000;
type Deps = { now?: () => number; ledger?: () => Promise<ResourceLedgerV1>; probe?: (home: string) => Promise<CodexSessionUsage> };

/** Inspect captured timestamps, never the controller's tick time. Refresh is an ephemeral observation. */
export async function staleResources(deps: Deps = {}) {
  const now = (deps.now ?? Date.now)();
  const ledger = await (deps.ledger ?? readResourceLedger)();
  const resources = ledger.lanes.map(row => {
    const at = row.observation?.asOf ?? row.quotaEvidence?.measuredQuota?.observedAt ?? row.quotaEvidence?.statusQuota?.observedAt ?? null;
    const parsed = at === null ? NaN : Date.parse(at);
    const ageMs = Number.isFinite(parsed) && parsed <= now ? now - parsed : null;
    return { resource: row.lane, observedAt: ageMs === null ? null : at, ageMs, stale: ageMs === null ? null : ageMs > MAX_AGE,
      refresh: 'not-attempted' as 'not-attempted' | 'current' | 'failed', refreshedAt: null as string | null,
      weeklyUsedPct: null as number | null };
  });
  const personal = resources.find(row => row.resource === 'codex-personal');
  if (personal?.stale) {
    try {
      const reading = await (deps.probe ?? probePersonalQuota)(join(homedir(), '.codex-2'));
      const at = reading.observedAt === null ? NaN : Date.parse(reading.observedAt);
      const weekly = reading.secondary;
      const checkedAt = (deps.now ?? Date.now)();
      if (!Number.isFinite(at) || at > checkedAt || checkedAt - at > MAX_AGE || !weekly ||
          weekly.windowMinutes !== null && weekly.windowMinutes <= 315 ||
          !Number.isFinite(weekly.usedPercent) || weekly.usedPercent < 0 || weekly.usedPercent > 100) throw new Error('unavailable');
      personal.refresh = 'current'; personal.refreshedAt = reading.observedAt; personal.weeklyUsedPct = weekly.usedPercent;
    } catch { personal.refresh = 'failed'; }
  }
  return { schema: 'resources.stale.v1', generatedAt: new Date(now).toISOString(), resources };
}

export async function cmdResourceStale(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: phm resources stale [--json]\nReports reading ages and refreshes stale personal Codex usage. Refresh results are not persisted.'); return 0;
  }
  if (args.some(arg => arg !== '--json') || args.length > 1) { console.error('Usage: phm resources stale [--json]'); return 2; }
  const report = await staleResources();
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else for (const row of report.resources) console.log(`${row.resource}: ${row.ageMs === null ? 'reading age unknown' : `read ${Math.floor(row.ageMs / 60000)} min ago`}; refresh ${row.refresh}`);
  return 0;
}
