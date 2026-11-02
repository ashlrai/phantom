/**
 * The Inbox when the Mac is out of reach: the last read stays on screen,
 * dated, under a "can't reach your Mac" banner — never passed off as
 * current — and the empty state still offers the way to the interject box.
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { resetInboxReadMissingForTest } from '../inbox-read-query.js';
import { MobileContext } from '../mobile-context.js';
import { permissionsFor, renderMobile, stubFetch } from '../mobile.test-support.js';
import { InboxScreen } from './InboxScreen.js';

const entry = (at: string, source: string, text: string, priority: string | null = null) => ({ at, source, priority, text });

function payload(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sourceState: 'healthy',
    limit: 100,
    source: null,
    dropped: 0,
    entries: [
      entry('2026-10-31 10:00', 'Phantom desktop', 'first this morning'),
      entry('2026-10-31 11:59', 'Phantom mobile', 'newest from the phone', 'P0'),
    ],
    ...partial,
  };
}

function mount(overrides: Parameters<typeof renderMobile>[1] = {}) {
  return renderMobile(<InboxScreen />, overrides);
}

afterEach(() => {
  evictAll();
  resetInboxReadMissingForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('InboxScreen when the Mac is unreachable', () => {
  it('dates the last read under a banner instead of passing it off as current', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs/inbox': payload() });
    const view = mount({ reachability: 'unreachable' });
    expect(await screen.findByText('newest from the phone')).toBeInTheDocument();
    // The read resolved just now, so the banner starts at "just now"…
    expect(screen.getByText('Can’t reach your Mac. Showing the last inbox read (updated just now).')).toBeInTheDocument();
    // …and ages with the data, not with the render.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    view.rerender(<MobileContext.Provider value={view.context}><InboxScreen /></MobileContext.Provider>);
    expect(screen.getByText('Can’t reach your Mac. Showing the last inbox read (updated 6 min ago).')).toBeInTheDocument();
  });

  it('keeps the empty state honest and offers the way to the interject box', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs/inbox': payload({ entries: [] }) });
    const { context } = mount({ reachability: 'unreachable', permissions: permissionsFor('unlocked') });
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Live runs' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'runs' });
  });
});
