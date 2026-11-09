import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CommsStatusCard } from './CommsStatusCard.js';

const block = {
  configuration: { state: 'configured', reason: 'CONFIG_ENABLED' },
  chatDb: { state: 'readable', reason: 'DB_READABLE' },
  cursor: { state: 'present', reason: 'CURSOR_BASELINE_PRESENT' },
  ackSource: 'ok', lastAckAt: new Date(Date.now() - 240_000).toISOString(), acks24h: 1, nextStep: null,
};
function show(imessage?: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ version: 1, generatedAt: new Date().toISOString(), drafts: null, emailOutbox: null, sources: { drafts: 'degraded', emailOutbox: 'degraded' }, ...(imessage === undefined ? {} : { imessage }) })));
  render(<CommsStatusCard visible />);
}
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows reading and ack evidence', async () => {
  show(block);
  expect(await screen.findByText('iMessage · reading Messages · last ack 4 min ago')).toBeInTheDocument();
});
it('shows the problem and next step', async () => {
  show({ ...block, chatDb: { state: 'unavailable', reason: 'DB_ACCESS_BLOCKED' }, nextStep: 'Review Full Disk Access.' });
  expect(await screen.findByText("iMessage · can't read Messages (Full Disk Access) · Review Full Disk Access.")).toBeInTheDocument();
});
it('hides the row for an older server', async () => {
  show();
  await screen.findByText('Drafts unavailable');
  expect(screen.queryByText(/iMessage/)).not.toBeInTheDocument();
});
