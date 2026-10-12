/** A separate desktop-only Devin dashboard reader, outside agent browser tools.
 * Its observations are UI-only and must never enter provider admission logic. */
export const DEVIN_READER_EVENT = 'ashlr:devin-reader';

export interface DevinDashboardUsage {
  weeklyUsedPercent: number;
  onDemandBalanceUsd: number;
  plan: 'Max';
  monthlyPriceUsd: number;
  resetProse: string | null;
  renewalProse: string | null;
  autoReload: boolean | null;
}

export type DevinReaderEvent =
  | { kind: 'status'; state: string }
  | { kind: 'snapshot'; source: 'devin-dashboard-organization'; accountVerified: false; orgId: string; observedAtMs: number; expiresAtMs: number; usage: DevinDashboardUsage };

type Bridge = { version?: unknown; send?: unknown };

type ReaderRequest = { op: 'open'; orgId: string } | { op: 'capture' | 'close' } | { op: 'auto'; enabled: boolean };

export function nativeDevinReader(win: Window = window): { send(op: ReaderRequest): boolean } | null {
  const bridge = (win as unknown as { __ASHLR_DESKTOP__?: { devinReader?: Bridge } }).__ASHLR_DESKTOP__?.devinReader;
  if (bridge?.version !== 1 || typeof bridge.send !== 'function') return null;
  return { send: bridge.send as (op: ReaderRequest) => boolean };
}

export function readDevinReaderEvent(event: Event, now: number = Date.now()): DevinReaderEvent | null {
  const data: unknown = (event as CustomEvent<unknown>).detail;
  if (!data || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  if (row.kind === 'status' && typeof row.state === 'string' && /^[a-z-]{1,60}$/.test(row.state)) {
    return { kind: 'status', state: row.state };
  }
  if (row.kind !== 'snapshot' || row.source !== 'devin-dashboard-organization' || row.accountVerified !== false
      || typeof row.orgId !== 'string' || !/^org-[A-Za-z0-9_-]{1,120}$/.test(row.orgId)
      || typeof row.observedAtMs !== 'number' || typeof row.expiresAtMs !== 'number'
      || !Number.isFinite(row.observedAtMs) || !Number.isFinite(row.expiresAtMs)
      || row.observedAtMs > now + 30_000 || row.expiresAtMs <= now || row.expiresAtMs - row.observedAtMs > 120_000
      || !row.usage || typeof row.usage !== 'object') return null;
  const usage = row.usage as Record<string, unknown>;
  if (usage.plan !== 'Max' || typeof usage.weeklyUsedPercent !== 'number' || !Number.isInteger(usage.weeklyUsedPercent)
      || usage.weeklyUsedPercent < 0 || usage.weeklyUsedPercent > 100
      || typeof usage.onDemandBalanceUsd !== 'number' || !Number.isFinite(usage.onDemandBalanceUsd) || usage.onDemandBalanceUsd < 0 || usage.onDemandBalanceUsd > 1_000_000
      || typeof usage.monthlyPriceUsd !== 'number' || !Number.isFinite(usage.monthlyPriceUsd) || usage.monthlyPriceUsd < 0 || usage.monthlyPriceUsd > 1_000_000
      || !(usage.autoReload === null || typeof usage.autoReload === 'boolean')
      || !(usage.resetProse === null || (typeof usage.resetProse === 'string' && /^Resets in \d{1,3} days?$/.test(usage.resetProse)))
      || !(usage.renewalProse === null || (typeof usage.renewalProse === 'string' && /^Renews on [A-Za-z]+ \d{1,2}, \d{4}$/.test(usage.renewalProse)))) return null;
  return { kind: 'snapshot', source: 'devin-dashboard-organization', accountVerified: false, orgId: row.orgId,
    observedAtMs: row.observedAtMs, expiresAtMs: row.expiresAtMs,
    usage: { weeklyUsedPercent: usage.weeklyUsedPercent, onDemandBalanceUsd: usage.onDemandBalanceUsd,
      plan: 'Max', monthlyPriceUsd: usage.monthlyPriceUsd,
      resetProse: usage.resetProse, renewalProse: usage.renewalProse, autoReload: usage.autoReload } };
}
