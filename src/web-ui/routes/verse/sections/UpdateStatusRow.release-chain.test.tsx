import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { UpdateStatusRow } from './UpdateStatusRow.js';

const chain = { verdict: 'held', reason: 'Reason: attest failed', latestAutorun: { mtime: '2026-01-01T00:00:00Z' } };
const facts = { v: 1, sourceState: 'healthy', installedVersion: null, headSha: null, headAt: null, originSha: null, branch: 'master', behind: 0, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: true };
beforeEach(() => { evictAll(); resetDesktopUpdatesForTests(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('release-chain')
    ? new Response(JSON.stringify(body), { status }) : new Response(JSON.stringify(facts))));
  render(<ToastProvider><UpdateStatusRow /></ToastProvider>);
}
it('shows a stopped chain', async () => {
  setup(chain);
  expect(await screen.findByText(/Release chain stopped at desktop signing: Reason: attest failed/)).toHaveAttribute('title', chain.reason);
});
it('hides a healthy chain', async () => {
  setup({ ...chain, verdict: 'published' });
  await screen.findByText(/Up to date/);
  expect(screen.queryByText(/Release chain stopped/)).not.toBeInTheDocument();
});
it('quietly handles an older server', async () => {
  setup({}, 404);
  await screen.findByText(/Up to date/);
  expect(screen.queryByText(/Release chain stopped/)).not.toBeInTheDocument();
});
