import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RuntimeIdentityCard } from './RuntimeIdentityCard.js';
import { runtimeIdentityQuery } from './runtime-identity-query.js';

const state = vi.hoisted(() => ({ failed: false }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: (query: { key: string }) => query.key === 'verse-fleet-runtime-identity'
    ? { status: state.failed ? 'error' : 'success', data: {
      generatedAt: '2026-11-14T19:32:00Z', host: 'cached-host', platform: 'darwin', asOf: 'unknown',
      installedVersion: '1', sourceVersion: '1', versionDrift: false, tailnetName: 'fake',
      fleetState: { ageSeconds: 60, stale: false }, reasons: [],
    } }
    : { status: 'success', data: { snapshot: {
      tailnetName: 'fake', asOf: '2026-11-14T19:32:00Z', reasons: [],
      coordination: { state: 'known', activeClaims: 2, newestReturnAgeSeconds: 10 },
      execution: { state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 },
    } } },
  useRefetch: () => () => {},
}));
vi.mock('../shell/section-visibility.js', () => ({
  useDocumentVisible: () => true, useSectionVisible: () => true, usePollWhileVisible: () => {},
}));
vi.mock('../runtime/NodeReachList.js', () => ({ NodeReachList: () => <div>Node reach</div> }));

it('retains cached identity and other runtime evidence after refresh failure', () => {
  expect(runtimeIdentityQuery.key).toBe('verse-fleet-runtime-identity');
  state.failed = false;
  const { rerender } = render(<RuntimeIdentityCard visible />);
  expect(screen.getByText('cached-host (darwin)')).toBeTruthy();
  expect(screen.queryByText('Last refresh failed')).toBeNull();
  state.failed = true;
  rerender(<RuntimeIdentityCard visible />);
  expect(screen.getByText('Last refresh failed')).toBeTruthy();
  expect(screen.getByText('cached-host (darwin)')).toBeTruthy();
  expect(screen.getByText(/2 live claims/)).toBeTruthy();
  expect(screen.getByText('1 running')).toBeTruthy();
  expect(screen.getByText('Node reach')).toBeTruthy();
  expect(screen.queryByText('Runtime identity not available on this build')).toBeNull();
});
