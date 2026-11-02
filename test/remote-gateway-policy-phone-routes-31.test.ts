import { expect, it } from 'vitest';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';

it.each([['GET', 'remote-phone'], ['GET', 'remote-pending'], ['POST', 'remote-pairing']])(
  'keeps %s %s Mac-only', (method, route) => {
    expect(classifyRemoteRoute(method, `/api/verse/fleet/control/${route}`)).toEqual({ kind: 'deny' });
  },
);
