import { fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { mobileAgentBusPageQuery } from './agent-bus-page-query.js';
import { BusSection } from './BusSection.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';

afterEach(() => { evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('renders newest rows, excerpts, a you chip and show-all', async () => {
  stubFetch({});
  vi.spyOn(mobileAgentBusPageQuery, 'fetch').mockResolvedValue({ v: 1, status: 'ok', nextCursor: 8,
    messages: Array.from({ length: 8 }, (_, i) => ({ cursor: i + 1, receivedAt: Date.now(),
      envelope: { id: `fake-${i}`, from: i === 7 ? 'mason' : 'leader', to: 'leaders', priority: 'P0', ttl: 10000, body: { text: `Message ${i}` } } })) });
  renderMobile(<BusSection />);
  expect(await screen.findByText('mason → leaders')).toBeInTheDocument();
  expect(screen.getByText('you')).toBeInTheDocument();
  expect(screen.getByText('Message 7')).toBeInTheDocument();
  expect(screen.queryByText('Message 0')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show all 8 messages' }));
  expect(screen.getByText('Message 0')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
});
it('shows the not-reachable line independently of the hop feed', async () => {
  stubFetch({});
  vi.spyOn(mobileAgentBusPageQuery, 'fetch').mockResolvedValue(null);
  renderMobile(<BusSection />);
  expect(await screen.findByText('Durable bus is not reachable from this phone yet')).toBeInTheDocument();
});
