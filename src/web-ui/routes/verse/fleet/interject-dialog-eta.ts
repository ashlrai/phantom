import { etaText, nextPassEta } from './next-pass-eta.js';

export function dialogDescription(newestPassMs: number | null, nowMs: number): string {
  const eta = nextPassEta(newestPassMs, nowMs);
  if (eta.kind === 'unknown' || newestPassMs === null) {
    return "Lands in the leaders' inbox. Leader passes run about every 15 min; no pass has reported yet.";
  }
  const age = Math.max(0, Math.floor((nowMs - newestPassMs) / 60_000));
  const text = etaText(eta);
  return eta.kind === 'overdue'
    ? `Lands in the leaders' inbox. Next leader pass is ${text.replace('pass overdue', 'overdue')} (last pass ${age} min ago)`
    : `Lands in the leaders' inbox. Next leader pass ${text.replace('next pass ', '')}, last pass ${age} min ago.`;
}

export function landedText(landedAtMs: number, newestPassMs: number | null, nowMs: number): string {
  const date = new Date(landedAtMs);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const eta = nextPassEta(newestPassMs, nowMs);
  return eta.kind === 'unknown' ? `Landed at ${time} · read on the next leader pass`
    : `Landed at ${time} · expected to be read ${etaText(eta)}`;
}
