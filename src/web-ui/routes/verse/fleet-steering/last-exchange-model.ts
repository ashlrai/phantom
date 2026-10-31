import { nextPassEta } from '../fleet/next-pass-eta.js';
import { passSummary, type LeaderJournalV1 } from '../leader-journal/leader-journal-model.js';
import { naiveClock, type SteeringEntry } from './steering-model.js';

const easternClock = (atMs: number): string => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
}).format(atMs);

/** Inbox timestamps are local wall clocks; only journal timestamps are instants. */
export function lastExchange(entries: SteeringEntry[], journal: LeaderJournalV1 | null | undefined, nowMs: number) {
  const newestOrder = [...entries].sort((a, b) =>
    (naiveClock(b.at) ?? -Infinity) - (naiveClock(a.at) ?? -Infinity))[0];
  const order = newestOrder ? { at: newestOrder.at, source: newestOrder.source, preview: newestOrder.text.slice(0, 120) } : null;
  const newestPass = journal?.passes.filter((pass) => Number.isFinite(Date.parse(pass.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const atMs = newestPass ? Date.parse(newestPass.at) : null;
  const pass = newestPass && atMs !== null ? {
    atMs, agoText: `${Math.max(0, Math.floor((nowMs - atMs) / 60_000))} min ago`, summary: passSummary(newestPass),
  } : null;
  const eta = pass ? nextPassEta(pass.atMs, nowMs) : null;
  const tone: 'neutral' | 'ok' | 'warning' | 'danger' = eta?.kind === 'overdue'
    ? eta.minutes > 30 ? 'danger' : 'warning' : pass ? 'ok' : 'neutral';
  const orderText = order ? `You · ${order.at.slice(11, 16)} ET · ${order.source}: ${order.preview}` : 'You · no order recorded yet';
  const passText = pass ? `Leaders · last pass ${easternClock(pass.atMs)} (${pass.agoText}): ${pass.summary}` : 'Leaders · no pass recorded yet';
  const etaText = eta?.kind === 'due-in' ? ` · next pass due in about ${eta.minutes} min`
    : eta?.kind === 'overdue' ? ` · overdue by ${eta.minutes} min` : '';
  return { order, pass, eta, tone, text: `${orderText} — ${passText}${etaText}` };
}
