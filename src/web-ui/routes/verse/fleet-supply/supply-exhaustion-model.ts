import { ledgerRows, type ResourceLedgerV1 } from '../usage/fleet-ledger-model.js';

type Exhaustion = { text: string; tone: 'ok' | 'warn' | 'bad'; atMs: number | null };

function clock(atMs: number, includeDate: boolean): string {
  const at = new Date(atMs);
  const date = includeDate ? `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ` : '';
  return date + at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
}

export function exhaustionByLane(ledger: ResourceLedgerV1 | null | undefined, nowMs: number): Map<string, Exhaustion> {
  const result = new Map<string, Exhaustion>();
  if (!ledger) return result;
  const descriptions = ledgerRows(ledger, nowMs);
  ledger.lanes.forEach((lane, index) => {
    if (lane.window === 'none') return;
    const reset = lane.resetAt === null ? null : Date.parse(lane.resetAt);
    const atMs = lane.projectedExhaustion === null ? null : Date.parse(lane.projectedExhaustion);
    if ((lane.usedPct !== null && lane.usedPct >= 100) || (lane.held && reset !== null)) {
      result.set(lane.lane, { text: `out of usage${reset === null ? '' : ` · resets ${clock(reset, true)}`}`, tone: 'bad', atMs: null });
    } else if (lane.window === 'credits') {
      if (lane.creditsRemaining !== null) result.set(lane.lane, { text: `credits: ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(lane.creditsRemaining)} left`, tone: 'ok', atMs: null });
    } else if (atMs !== null && atMs > nowMs) {
      const relative = descriptions[index]?.runsOut?.replace('runs out ', '');
      if (!relative) return;
      const delta = atMs - nowMs;
      const differentDay = new Date(atMs).toDateString() !== new Date(nowMs).toDateString();
      result.set(lane.lane, { text: `runs out ≈ ${clock(atMs, differentDay)} (${relative})`, tone: delta < 2 * 3_600_000 ? 'bad' : delta < 8 * 3_600_000 ? 'warn' : 'ok', atMs });
    }
  });
  return result;
}

export function soonestExhaustion(entries: ReadonlyMap<string, Exhaustion>): string | null {
  let soonest: [string, Exhaustion] | null = null;
  for (const entry of entries) {
    if (entry[1].atMs !== null && (soonest === null || entry[1].atMs < soonest[1].atMs!)) soonest = entry;
  }
  const relative = soonest?.[1].text.match(/\((in .+)\)$/)?.[1];
  return soonest && relative ? `${soonest[0]} runs out ${relative}` : null;
}
