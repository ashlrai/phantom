import { expect, it } from 'vitest';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';

const path = '/api/verse/fleet/ci-runs';

it.each(['', '?hours=24', '?hours=1', '?hours=168'])('allows CI facts GET %s', (query) => {
  expect(classifyRemoteRoute('GET', `${path}${query}`)).toEqual({ kind: 'read', path });
});

it.each(['?hours=0', '?hours=999', '?hours=abc', '?unknown=1', '?hours=24&other=1', '?hours=1&hours=24']) (
  'refuses CI facts GET %s', (query) => {
    expect(classifyRemoteRoute('GET', `${path}${query}`)).toEqual({ kind: 'deny' });
  },
);

it('refuses CI facts writes and keeps phone control routes Mac-only', () => {
  expect(classifyRemoteRoute('POST', path)).toEqual({ kind: 'deny' });
  expect(classifyRemoteRoute('GET', '/api/verse/fleet/control/remote-phone')).toEqual({ kind: 'deny' });
  expect(classifyRemoteRoute('POST', '/api/verse/fleet/control/remote-pairing')).toEqual({ kind: 'deny' });
});
