import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CommsStatusCard } from './CommsStatusCard.js';

function show(sendPolicy?: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: 1, generatedAt: new Date().toISOString(), drafts: null, emailOutbox: null, sources: { drafts: 'degraded', emailOutbox: 'degraded' }, ...(sendPolicy === undefined ? {} : { sendPolicy }) })));
  render(<CommsStatusCard visible />);
}
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('unconfirmed shows the drafts-only line and both copy pills', async () => {
  show({ confirmed: false, teamIdentities: 2, channels: ['imessage', 'slack'] });
  expect(await screen.findByText(/Team sends: drafts only\. You have not confirmed ~\/\.ashlr\/comms\.toml yet\./)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Copy the line you add to comms\.toml yourself: confirmedByMason = true/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Copy the path of the file you edit yourself: ~\/\.ashlr\/comms\.toml/ })).toBeInTheDocument();
});
it('confirmed shows the line and no pills', async () => {
  show({ confirmed: true, teamIdentities: 2, channels: ['imessage', 'slack'] });
  expect(await screen.findByText('Team sends: confirmed by you · 2 team identities (imessage, slack)')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('a payload without sendPolicy renders as before', async () => {
  show();
  await screen.findByText('Drafts unavailable');
  expect(screen.queryByText(/Team sends/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
