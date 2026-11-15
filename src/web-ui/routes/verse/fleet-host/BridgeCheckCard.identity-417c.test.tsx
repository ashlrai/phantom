import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { BridgeCheckCard } from './BridgeCheckCard.js';

const sec = (extra: Record<string, unknown> = {}) => ({
  status: 'ok', source: 'fleet-runtime', asOf: '2026-11-15T12:00:00.000Z', ...extra,
});
const env = (check: unknown) => ({ v: 1, authority: 'none', check });
const ready = {
  verdict: 'READY', asOf: '2026-11-15T12:00:00.000Z', missing: [],
  runtime: sec({ host: 'mac-mini-test', stateRoot: '/Users/someone/.ashlr-runs', lastFleetStateRead: { ageSeconds: 120 } }),
  claims: sec({ source: 'coordination-ledger', live: 3, newestAgeSec: 240 }),
  peers: sec({ source: 'peer-ledger' }),
};
const stub = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('READY card shows the runtime and claims lines', async () => {
  stub(env(ready));
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText('host mac-mini-test · stateRoot ~/.ashlr-runs · fleet-state age 2m')).toBeTruthy();
  expect(screen.getByText('3 live, newest 4m')).toBeTruthy();
  expect(screen.getByText('Bridge: READY')).toBeTruthy();
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByText(/grants no dispatch authority/)).toBeTruthy();
});
it('BLOCKED runtime timeout shows host unknown and keeps the headline', async () => {
  stub(env({ ...ready, verdict: 'BLOCKED', missing: ['runtime'],
    runtime: sec({ status: 'unavailable', reason: 'runtime-reader-timeout' }) }));
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText(/^host unknown · /)).toBeTruthy();
  expect(screen.getByText('Bridge: BLOCKED (runtime: runtime-reader-timeout)')).toBeTruthy();
});
it('wrong-typed host and negative claims render unknown, not a shape error', async () => {
  stub(env({ ...ready, runtime: { ...ready.runtime, host: 42 }, claims: sec({ live: -1 }) }));
  render(<BridgeCheckCard visible />);
  expect(await screen.findByText(/^host unknown · stateRoot ~\/\.ashlr-runs/)).toBeTruthy();
  expect(screen.getByText('claims unknown')).toBeTruthy();
  expect(screen.queryByText(/unexpected report shape/)).toBeNull();
});
