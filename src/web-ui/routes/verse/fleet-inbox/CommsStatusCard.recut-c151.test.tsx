import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CommsStatusCard } from './CommsStatusCard.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });

it('does not display a malformed send policy from the status endpoint', async () => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    version: 1, generatedAt: new Date().toISOString(), drafts: null, emailOutbox: null,
    sources: { drafts: 'degraded', emailOutbox: 'degraded' },
    sendPolicy: { confirmed: 'true', teamIdentities: 1, channels: ['slack'] },
  })));
  render(<CommsStatusCard visible />);
  await screen.findByText('Drafts unavailable');
  expect(screen.queryByText(/Team sends:/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
