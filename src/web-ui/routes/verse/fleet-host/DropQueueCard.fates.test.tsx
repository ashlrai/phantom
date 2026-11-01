import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { DropQueueCard } from './DropQueueCard.js';
beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mock(failed = false) {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T12:03:00Z'));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/drop-jobs')
    ? Response.json({ v: 1, items: [{ id: 'WAIT123', lane: 'codex', tier: 'mid', title: 'Fake waiting job', ageSeconds: 30, bytes: 20 }] })
    : failed ? Response.json({}, { status: 404 }) : Response.json({ v: 1, fates: [
      { id: 'ABC123', fate: 'ingested', at: '2026-11-01T12:00:00Z', lane: 'codex-personal', tier: 'mid', reason: null },
      { id: 'BAD123', fate: 'rejected', at: '2026-11-01T12:00:00Z', lane: null, tier: null, reason: 'denied-path' },
    ] })));
}
it('shows accepted and rejected rows and the summary beside waiting jobs', async () => {
  mock(); render(<DropQueueCard visible />);
  expect(await screen.findByText('ABC123 accepted 3m ago · codex-personal mid')).toBeInTheDocument();
  expect(screen.getByText('BAD123 rejected 3m ago · denied-path')).toHaveAttribute('data-tone', 'bad');
  expect(screen.getByText('last sweep: 1 accepted, 1 rejected')).toBeInTheDocument();
  expect(screen.getByText(/Fake waiting job/)).toBeInTheDocument();
});
it('keeps waiting jobs when fates returns 404', async () => {
  mock(true); render(<DropQueueCard visible />);
  expect(await screen.findByText(/Fake waiting job/)).toBeInTheDocument();
  expect(screen.queryByText('Recent fates')).not.toBeInTheDocument();
});
