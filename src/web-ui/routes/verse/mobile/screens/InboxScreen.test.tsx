/**
 * The Inbox on the phone: the whole leaders' inbox, newest first, each
 * entry's channel and priority as badges and the words whole behind a
 * six-line clamp; a chip row built from the sources present narrows the
 * list client-side; the dropped count and a degraded read stay honest;
 * a 404 is "not in this build yet", never an error.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { resetInboxReadMissingForTest } from '../inbox-read-query.js';
import { json, renderMobile, stubFetch } from '../mobile.test-support.js';
import { InboxScreen, refreshInboxScreen } from './InboxScreen.js';

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
      entry('2026-10-31 11:30', 'Telegram', 'middle from telegram', 'P1'),
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
});

describe('InboxScreen reads', () => {
  it('renders entries newest first, each with its source, priority when present, time and words', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs/inbox': payload() });
    mount();
    const newest = await screen.findByText('newest from the phone');
    const oldest = screen.getByText('first this morning');
    // Document order is newest first even though the wire shipped oldest first.
    expect(newest.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('middle from telegram')).toBeInTheDocument();
    // Source badges, and priority only where the sender set one.
    const newestCard = newest.closest('article')!;
    expect(within(newestCard).getByText('Phantom mobile')).toBeInTheDocument();
    expect(within(newestCard).getByText('P0')).toBeInTheDocument();
    expect(within(newestCard).getByText(/ago|just now|unknown time/)).toBeInTheDocument();
    const oldestCard = oldest.closest('article')!;
    expect(within(oldestCard).getByText('Phantom desktop')).toBeInTheDocument();
    expect(within(oldestCard).queryByText(/^P\d/)).not.toBeInTheDocument();
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('keeps line breaks in the words', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs/inbox': payload({ entries: [entry('2026-10-31 11:59', 'email', 'multi\nline')] }) });
    mount();
    expect(await screen.findByText((_content, el) => el !== null && el.tagName === 'P' && el.textContent === 'multi\nline')).toBeInTheDocument();
  });

  it('a source chip narrows the rows client-side and All restores them', async () => {
    const stub = stubFetch({ 'GET /api/verse/fleet/runs/inbox': payload() });
    mount();
    const group = await screen.findByRole('group', { name: 'Filter by source' });
    fireEvent.click(within(group).getByRole('button', { name: 'Telegram' }));
    expect(screen.getByText('middle from telegram')).toBeInTheDocument();
    expect(screen.queryByText('newest from the phone')).not.toBeInTheDocument();
    expect(screen.queryByText('first this morning')).not.toBeInTheDocument();
    fireEvent.click(within(group).getByRole('button', { name: 'All' }));
    expect(screen.getByText('newest from the phone')).toBeInTheDocument();
    // No second read: the filter is client-side over the page already held.
    expect(stub.calls).toHaveLength(1);
  });

  it('clamps a long message behind Show more', async () => {
    const long = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n');
    stubFetch({ 'GET /api/verse/fleet/runs/inbox': payload({ entries: [entry('2026-10-31 11:59', 'email', long)] }) });
    mount();
    const toggle = await screen.findByRole('button', { name: 'Show more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('prints the dropped count and warns when the read is degraded', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs/inbox': payload({ sourceState: 'degraded', dropped: 12 }) });
    mount();
    expect(await screen.findByText('12 older entries not shown')).toBeInTheDocument();
    expect(screen.getByText(/degraded — this may not be everything/)).toBeInTheDocument();
  });

  it('says Nothing yet when the inbox is empty', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs/inbox': payload({ entries: [] }) });
    mount();
    expect(await screen.findByText('Nothing yet.')).toBeInTheDocument();
    expect(screen.getByText('Use the box on Live runs.')).toBeInTheDocument();
  });

  it('a 404 is not-in-this-build: its own state, never a crash', async () => {
    stubFetch({});
    mount();
    expect(await screen.findByText('Inbox is not in this build yet.')).toBeInTheDocument();
    expect(screen.getByText('Update Phantom on your Mac to read it here.')).toBeInTheDocument();
  });

  it('other failures get the server’s reason and a retry', async () => {
    const stub = stubFetch({ 'GET /api/verse/fleet/runs/inbox': json({ error: 'The inbox is rebuilding.' }, 500) });
    mount();
    expect(await screen.findByText('Couldn’t load the inbox')).toBeInTheDocument();
    expect(screen.getByText('The inbox is rebuilding.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(stub.calls).toHaveLength(2));
  });

  it('backs out to More and pull-to-refresh forces a fresh read', async () => {
    const stub = stubFetch({ 'GET /api/verse/fleet/runs/inbox': payload() });
    const { context } = mount();
    expect(await screen.findByText('newest from the phone')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'more' });
    await act(async () => {
      await refreshInboxScreen();
    });
    expect(stub.calls.filter((c) => c.url === '/api/verse/fleet/runs/inbox?limit=100')).toHaveLength(2);
  });
});
