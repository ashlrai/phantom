import { nextPassEta } from '../fleet/next-pass-eta.js';
import { newestLeaderPassMs, parseInboxAt } from '../fleet/interject-ack-model.js';
import { passSummary, type LeaderJournalV1 } from '../leader-journal/leader-journal-model.js';
import { naiveClock, type SteeringEntry } from './steering-model.js';

const easternClock = (atMs: number): string => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
}).format(atMs);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function pendingOrders(runs: unknown, nowMs: number) {
  const data = record(runs);
  const leaders = Array.isArray(data.leaders) ? data.leaders.flatMap((value: unknown) => {
    const age = record(value).ageSeconds;
    return typeof age === 'number' || age === null ? [{ ageSeconds: age }] : [];
  }) : undefined;
  const newestPassMs = newestLeaderPassMs(leaders, Date.parse(typeof data.generatedAt === 'string' ? data.generatedAt : ''));
  const inbox = Array.isArray(data.inbox) ? data.inbox : [];
  const count = inbox.filter((value: unknown) => {
    const at = record(value).at;
    const entryMs = typeof at === 'string' ? parseInboxAt(at, nowMs) : null;
    // Unparseable inbox timestamps cannot be compared and are not counted.
    return entryMs !== null && (newestPassMs === null || entryMs > newestPassMs);
  }).length;
  return { count, newestPassMs, eta: nextPassEta(newestPassMs, nowMs) };
}

export function pendingText(view: ReturnType<typeof pendingOrders>): { text: string; tone: 'ok' | 'warning' | 'danger' } {
  if (view.count === 0) return { text: 'All orders seen by a leader', tone: 'ok' };
  const timing = view.eta.kind === 'due-in' ? `due in ${view.eta.minutes} min`
    : view.eta.kind === 'overdue' ? `overdue by ${view.eta.minutes} min` : 'next pass time unknown';
  const tone = view.eta.kind === 'overdue' ? view.eta.minutes > 30 ? 'danger' : 'warning' : 'ok';
  return { text: `${view.count} ${view.count === 1 ? 'order' : 'orders'} waiting for the next leader pass · ${timing}`, tone };
}

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
