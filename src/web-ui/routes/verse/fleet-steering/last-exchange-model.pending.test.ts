import { expect, it } from 'vitest';
import { nextPassEta } from '../fleet/next-pass-eta.js';
import { pendingOrders, pendingText } from './last-exchange-model.js';

const now = Date.parse('2026-10-31T04:20:00Z');
const runs = (times: string[], ageSeconds: number | null = 8 * 60) => ({
  generatedAt: new Date(now).toISOString(),
  leaders: [{ ageSeconds }],
  inbox: times.map(at => ({ at, source: 'fake', text: 'fake order' })),
});

it('counts parseable orders strictly after the newest pass', () => {
  const view = pendingOrders(runs(['2026-10-31 00:13', '2026-10-31 00:19', '2026-10-31 00:12', 'bad timestamp']), now);
  expect(view.count).toBe(2);
  expect(view.newestPassMs).toBe(now - 8 * 60_000);
  expect(pendingText(view)).toEqual({ text: '2 orders waiting for the next leader pass · due in 7 min', tone: 'ok' });
});

it('reports all orders seen when they precede the pass', () => {
  const view = pendingOrders(runs(['2026-10-31 00:10', '2026-10-31 00:11']), now);
  expect(view.count).toBe(0);
  expect(pendingText(view)).toEqual({ text: 'All orders seen by a leader', tone: 'ok' });
});

it('counts all parseable orders when no pass is known', () => {
  const view = pendingOrders(runs(['2026-10-31 00:10', 'bad timestamp'], null), now);
  expect(view.count).toBe(1);
  expect(view.newestPassMs).toBeNull();
  expect(view.eta).toEqual(nextPassEta(null, now));
  expect(pendingText(view)).toEqual({ text: '1 order waiting for the next leader pass · next pass time unknown', tone: 'ok' });
});

it('uses warning and danger tones for overdue passes', () => {
  const warning = pendingOrders(runs(['2026-10-31 00:19'], 45 * 60), now);
  expect(pendingText(warning)).toEqual({ text: '1 order waiting for the next leader pass · overdue by 30 min', tone: 'warning' });
  const danger = pendingOrders(runs(['2026-10-31 00:19'], 46 * 60), now);
  expect(pendingText(danger)).toEqual({ text: '1 order waiting for the next leader pass · overdue by 31 min', tone: 'danger' });
});
