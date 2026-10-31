export const LEADER_PASS_CADENCE_MS = 15 * 60_000;
export const GRACE_MS = 3 * 60_000;

export function nextPassEta(newestPassMs: number | null, nowMs: number, cadenceMs = LEADER_PASS_CADENCE_MS):
  { kind: 'due-in'; minutes: number } | { kind: 'overdue'; minutes: number } | { kind: 'unknown' } {
  if (newestPassMs === null || !Number.isFinite(newestPassMs) || !Number.isFinite(nowMs)) return { kind: 'unknown' };
  const due = newestPassMs + cadenceMs;
  return nowMs < due + GRACE_MS
    ? { kind: 'due-in', minutes: Math.max(1, Math.ceil((due - nowMs) / 60_000)) }
    : { kind: 'overdue', minutes: Math.max(1, Math.ceil((nowMs - due) / 60_000)) };
}

export function etaText(eta: ReturnType<typeof nextPassEta>): string {
  return eta.kind === 'unknown' ? 'next pass unknown' : eta.kind === 'due-in'
    ? `next pass in ~${eta.minutes} min` : `pass overdue by ${eta.minutes} min`;
}
