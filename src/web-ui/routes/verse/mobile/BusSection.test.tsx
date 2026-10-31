import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { BusSection } from './BusSection.js';
import { resetBusMissingForTest } from './bus-query.js';
import { stubFetch } from './mobile.test-support.js';

const path = 'GET /api/verse/fleet/live/bus';
const fixture = () => ({
  v: 1,
  hops: [{ inputTokens: 1200, outputTokens: 40 }, { inputTokens: 300, outputTokens: 20 }],
  events: [
    { at: '2026-10-31T10:00:00Z', kind: 'launch', text: 'Worker launched' },
    { at: '2026-10-31T11:00:00Z', kind: 'inbox', text: 'Check the lane' },
  ],
  sources: { hops: 'healthy', events: 'healthy' },
});

afterEach(() => { evictAll(); resetBusMissingForTest(); vi.unstubAllGlobals(); });

describe('BusSection', () => {
  it('renders hop totals and newest-first events with an inbox badge', async () => {
    stubFetch({ [path]: fixture() });
    render(<BusSection />);
    const section = await screen.findByRole('region', { name: 'Bus' });
    expect(within(section).getByText('2 hops · in 1,500 / out 60 tokens')).toBeInTheDocument();
    expect(within(section).getByText('You')).toBeInTheDocument();
    expect(within(section).getByText('launch')).toBeInTheDocument();
    expect(within(section).getByText('Check the lane').compareDocumentPosition(within(section).getByText('Worker launched')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the section when the route is missing', async () => {
    const { calls } = stubFetch({});
    const { container } = render(<BusSection />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows the empty state and incomplete sources', async () => {
    stubFetch({ [path]: { ...fixture(), hops: [], events: [], sources: { hops: 'missing', events: 'degraded' } } });
    render(<BusSection />);
    expect(await screen.findByText('No bus activity yet.')).toBeInTheDocument();
    expect(screen.getByText('Some bus data may be incomplete: hops missing, events degraded.')).toBeInTheDocument();
  });
});
