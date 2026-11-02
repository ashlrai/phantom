import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { BusSection } from './BusSection.js';
import { resetBusMissingForTest } from './bus-query.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';

const path = 'GET /api/verse/fleet/live/bus';
const fixture = (n: number) => ({
  v: 1,
  hops: [{ inputTokens: 100, outputTokens: 20 }],
  events: Array.from({ length: n }, (_, i) => ({
    at: new Date(Date.parse('2026-10-31T12:00:00Z') - i * 60_000).toISOString(),
    kind: 'launch',
    text: `Event ${i}`,
  })),
  sources: { hops: 'healthy', events: 'healthy' },
});

afterEach(() => { evictAll(); resetBusMissingForTest(); vi.unstubAllGlobals(); });

describe('BusSection show-all', () => {
  it('caps events at 25 and expands to show every event', async () => {
    stubFetch({ [path]: fixture(30) });
    renderMobile(<BusSection />);

    const toggle = await screen.findByRole('button', { name: 'Show all 30 events' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const section = screen.getByRole('region', { name: 'Bus' });
    expect(within(section).getAllByText(/^Event \d+$/)).toHaveLength(25);
    expect(within(section).getByText('Event 0')).toBeInTheDocument();
    expect(within(section).queryByText('Event 25')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(within(section).getAllByText(/^Event \d+$/)).toHaveLength(30);
    expect(within(section).getByText('Event 29')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });
});
