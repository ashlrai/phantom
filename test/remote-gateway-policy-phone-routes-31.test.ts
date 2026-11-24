import { expect, it } from 'vitest';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';

it.each(['/api/fleet/releases', '/api/verse/fleet/yield', '/api/verse/fleet/admission', '/api/verse/fleet/memory/host-load'])('allows only the exact phone GET for %s', path => {
  expect(classifyRemoteRoute('GET', path)).toEqual({ kind: 'read', path });
  for (const method of ['POST', 'DELETE', 'PUT', 'HEAD']) expect(classifyRemoteRoute(method, path)).toEqual({ kind: 'deny' });
  for (const suffix of ['?by=tree', '?path=private', '/', '/private']) expect(classifyRemoteRoute('GET', path + suffix)).toEqual({ kind: 'deny' });
});

it.each([['GET', 'remote-phone'], ['GET', 'remote-pending'], ['POST', 'remote-pairing']])(
  'keeps %s %s Mac-only', (method, route) => {
    expect(classifyRemoteRoute(method, `/api/verse/fleet/control/${route}`)).toEqual({ kind: 'deny' });
  },
);

it('requires step-up and an exact bounded body to place an owner hold', async () => {
  const { validateRemoteMutation } = await import('../src/core/web/remote-gateway-policy.js');
  const route = classifyRemoteRoute('POST', '/api/verse/fleet/live');
  expect(route).toEqual({ kind: 'write', path: '/api/verse/fleet/live', stepUp: true });
  const hold = { action: 'pause-repo', repo: 'ashlrai/phantom', reason: 'Review this change first.' };
  expect(validateRemoteMutation(route, hold)).toBe(true);
  for (const body of [{ ...hold, reason: '' }, { ...hold, reason: 'x'.repeat(401) },
    { ...hold, repo: '../private' }, { ...hold, kind: 'quarantine' }, { ...hold, bypass: true }]) {
    expect(validateRemoteMutation(route, body)).toBe(false);
  }
});
