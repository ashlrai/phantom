import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { controlSnapshot } from '../sections/section-fixtures.test-support.js';
import { FleetUsageCard } from './FleetUsageCard.js';
import { activityResponse, activityState, needsItem, renderMobile, stubFetch } from './mobile.test-support.js';
import { FleetScreen } from './screens/FleetScreen.js';
import { InboxScreen } from './screens/InboxScreen.js';
import { NeedsYouScreen } from './screens/NeedsYouScreen.js';

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-04T12:00:00Z'));
  vi.stubGlobal('innerWidth', 390);
});
afterEach(() => { evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// DOM snapshots complement the mobile CSS overflow and touch-target contracts.
// Keep the viewport wrapper in the snapshot so phone intent is reviewable.
it('390px fleet status', async () => {
  stubFetch({ 'GET /api/verse/control': controlSnapshot() });
  const view = renderMobile(<div style={{ width: 390 }}><FleetScreen /></div>);
  await screen.findByRole('heading', { name: 'Fleet' });
  await waitFor(() => expect(view.container.querySelector('[aria-busy="true"]')).toBeNull());
  expect(view.container).toMatchSnapshot();
});

it('390px shared chat inbox with desktop and phone channels', async () => {
  stubFetch({ 'GET /api/verse/fleet/runs': { inbox: [] },
    'GET /api/verse/fleet/runs/inbox': {
    v: 1, generatedAt: '2026-11-04T12:00:00Z', sourceState: 'healthy', limit: 100, source: null, dropped: 0,
    entries: [
      { at: '2026-11-04T11:58:00Z', source: 'Phantom desktop', priority: null, text: 'Check the mobile build.' },
      { at: '2026-11-04T11:59:00Z', source: 'Phantom mobile', priority: 'P1', text: 'The phone shares this inbox.' },
    ],
  } });
  const view = renderMobile(<div style={{ width: 390 }}><InboxScreen /></div>);
  await screen.findByText('The phone shares this inbox.');
  expect(view.container).toMatchSnapshot();
});

it('390px usage panel', async () => {
  stubFetch({ 'GET /api/verse/leader/resources': {
    v: 1, generatedAt: '2026-11-04T12:00:00Z', sources: { status: 'healthy', apiSpend: 'missing' },
    asOf: '2026-11-04T12:00:00Z', apiSpend: null,
    lanes: [{ lane: 'Codex', running: 2, target: 4, held: false, window: 'weekly', usedPct: 72,
      creditsRemaining: null, resetAt: null, burnPctPerHour: 1.4, tokensPerHour6h: null,
      projectedExhaustion: null, source: 'status' }],
  } });
  const view = renderMobile(<div style={{ width: 390 }}><FleetUsageCard /></div>);
  await screen.findByText('Codex');
  expect(view.container).toMatchSnapshot();
});

it('390px approve and held-lane decisions', async () => {
  stubFetch({ 'GET /api/verse/fleet/control/holds': {
    v: 1, generatedAt: '2026-11-04T12:00:00Z', sourceState: 'healthy',
    lanes: [{ lane: 'codex-personal', target: 0, floor: 0, ceiling: 8, held: true,
      heldReason: 'usage limit', heldUntil: null, lastChange: null, changedBy: 'autobackoff' }],
  } });
  const view = renderMobile(<div style={{ width: 390 }}><NeedsYouScreen /></div>, {
    activity: activityState(activityResponse({ needsYou: [needsItem()] })),
  });
  await screen.findByText('codex-personal is held');
  expect(screen.getByRole('button', { name: /Approve/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Hold repo:/ })).toBeInTheDocument();
  expect(view.container).toMatchSnapshot();
});
