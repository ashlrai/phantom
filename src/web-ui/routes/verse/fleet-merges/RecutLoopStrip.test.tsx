import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { RecutLoopStrip } from './RecutLoopStrip.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); evictAll(); });
it('renders recent state', async () => {
  vi.mocked(apiGet).mockResolvedValue({ v: 1, off: false, lastTickAt: new Date().toISOString() });
  render(<RecutLoopStrip visible />);
  expect(await screen.findByText(/Recut loop last ran less than a minute ago/)).toBeInTheDocument();
});
it('hides a missing route', async () => {
  vi.mocked(apiGet).mockRejectedValue(new ApiError('missing', 404, '/api/verse/health/recut-loop'));
  const view = render(<RecutLoopStrip visible />);
  await vi.waitFor(() => expect(getQuerySnapshot('verse-recut-loop').data).toBeNull());
  expect(view.container).toBeEmptyDOMElement();
});
