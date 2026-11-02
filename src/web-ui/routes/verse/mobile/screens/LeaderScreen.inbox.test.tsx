import { screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { leaderState } from '../../command/fixtures.test-support.js';
import { msg } from '../../leader/thread-fixtures.test-support.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { LeaderScreen } from './LeaderScreen.js';

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

it('interleaves email as Mason plain text with its source badge', async () => {
  stubFetch({
    'GET /api/verse/leader/thread': { messages: [
      msg({ id: 'before', at: '2026-10-31T12:00:00Z', text: 'Before the order' }),
      msg({ id: 'after', at: '2026-10-31T12:02:00Z', text: 'After the order' }),
    ] },
    'GET /api/verse/leader/directives': { directives: [], retired: [] },
    'GET /api/verse/leader': leaderState('live'),
    'GET /api/verse/fleet/runs': {
      v: 1, lastTick: null, claudeLane: null, switches: [], lanes: [],
      mergesLastHour: { count: null }, codexPersonal: null,
      sources: { inbox: 'healthy' },
      inbox: [{ at: '2026-10-31T12:01:00Z', source: 'email', text: '<b>Fake email order</b>\nKeep this literal.' }],
    },
  });
  renderMobile(<LeaderScreen />);
  const order = await screen.findByText(/<b>Fake email order<\/b>/);
  expect(order.textContent).toBe('<b>Fake email order</b>\nKeep this literal.');
  expect(order.querySelector('b')).toBeNull();
  const bubble = order.closest('[data-from]')!;
  expect(bubble).toHaveAttribute('data-from', 'mason');
  expect(within(bubble as HTMLElement).getByText('Email')).toBeInTheDocument();
  expect(bubble.querySelector('time')).toHaveAttribute('dateTime', '2026-10-31T12:01:00.000Z');
  expect(screen.getByText('Before the order').compareDocumentPosition(order) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(order.compareDocumentPosition(screen.getByText('After the order')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
