/** The readings behind `fleet meter-drop`: the same ones `phm pools` shows.
 *  Running counts come from the daemon status (`lanes.<lane>.running`, via the
 *  resource ledger); usage samples are the ledger's current reading plus the
 *  stored usage history. Read-only; a failed read gives no evidence, never a guess. */
import { join } from 'node:path';
import type { LaneTruthReaders, MeterSample } from './lane-truth.js';
import { readResourceLedger, type ResourceLedgerV1 } from './runs-resource-ledger.js';
import { ledgerUsageReadings, readUsageSamples } from './usage-history.js';

/** History older than this is dropped, except the newest older row, which is the value the meter held at the start. */
export const METER_LOOKBACK_MS = 3 * 3_600_000;

export function defaultMeterDropReaders(home: string, now: number): LaneTruthReaders {
  const runsDir = join(home, '.ashlr-runs');
  let ledger: Promise<ResourceLedgerV1> | undefined;
  const readLedger = (): Promise<ResourceLedgerV1> => ledger ??= readResourceLedger({ runsDir, now: () => now });
  return {
    async lanes() {
      const { lanes } = await readLedger();
      return lanes.map(l => ({ lane: l.lane, target: l.target, running: l.running, queued: null, held: l.held }));
    },
    async meters() {
      const [current, history] = await Promise.all([readLedger().then(ledgerUsageReadings), readUsageSamples({ runsDir, nowMs: now })]);
      // The history dedupes unchanged values, so the current reading is what proves the meter is still there.
      const rows = [...history, ...current].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
      const baseline = new Map<string, number>();
      for (const r of rows) if (Date.parse(r.observed_at) < now - METER_LOOKBACK_MS) baseline.set(r.pool, Date.parse(r.observed_at));
      return rows
        .filter(r => Date.parse(r.observed_at) >= (baseline.get(r.pool) ?? 0))
        .map((r): MeterSample => ({ provider: r.pool, window: 'weekly', usedPercent: r.used_pct, resetAt: r.reset_at, sampledAt: r.observed_at }));
    },
  };
}
