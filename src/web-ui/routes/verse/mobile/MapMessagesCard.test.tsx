import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { MapMessages } from '../../../../core/fleet/map-messages.js';
import { MapMessagesCard } from './MapMessagesCard.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';

function read(count: number): MapMessages {
  const messages = Array.from({ length: count }, (_, i) => ({ id: `m${i}`, from: 'claude', to: 'codex', fromNode: 'lane:claude', toNode: 'lane:codex',
    kind: 'ask' as const, summary: `question ${i}`, at: `2026-11-18T12:${String(59 - i).padStart(2, '0')}:00.000Z` }));
  return { schema: 'fleet.map-messages.v1', version: 1, generatedAt: '2026-11-18T13:00:00.000Z', since: '2026-11-18T12:00:00.000Z', source: 'available', messages, matched: count, skipped: 0 };
}
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('MapMessagesCard', () => {
  it('lists only the last 10 messages as plain lines', async () => {
    stubFetch({ 'GET /api/fleet/map/messages': read(14) });
    renderMobile(<MapMessagesCard />);
    expect(await screen.findAllByText('claude to codex (ask)')).toHaveLength(10);
    expect(screen.getByText('question 0')).toBeInTheDocument();
    expect(screen.queryByText('question 10')).not.toBeInTheDocument();
  });

  it('says so when there are none, and when the read fails', async () => {
    stubFetch({ 'GET /api/fleet/map/messages': read(0) });
    renderMobile(<MapMessagesCard />);
    expect(await screen.findByText('No agent messages lately')).toBeInTheDocument();
    cleanup(); evictAll();
    stubFetch({ 'GET /api/fleet/map/messages': () => json({ error: 'down' }, 503) });
    renderMobile(<MapMessagesCard />);
    expect(await screen.findByText('Couldn’t read agent messages')).toBeInTheDocument();
  });
});
