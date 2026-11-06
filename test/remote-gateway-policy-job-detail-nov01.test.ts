import { describe, expect, it } from 'vitest';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';

describe('phone job detail read boundary', () => {
  it.each(['RQ-PHX-EXAMPLE01', 'abc', 'a.b_c-d'])('admits exactly one valid id: %s', (id) => {
    expect(classifyRemoteRoute('GET', `/api/fleet/job?id=${id}`))
      .toEqual({ kind: 'read', path: '/api/fleet/job' });
  });

  it.each([
    '/api/fleet/job', '/api/fleet/job?', '/api/fleet/job?id=',
    '/api/fleet/job?id=ab', '/api/fleet/job?id=../abc', '/api/fleet/job?id=%2e%2e%2fabc',
    '/api/fleet/job?id=RQ-EXAMPLE&extra=1', '/api/fleet/job?id=RQ-EXAMPLE&id=RQ-OTHER',
    '/api/fleet/job?job=RQ-EXAMPLE', '/api/fleet/job?id=RQ-EXAMPLE%0a',
    '/api/fleet/job/text?id=RQ-EXAMPLE', '/api/fleet/job/changes?id=RQ-EXAMPLE',
  ])('denies an unreviewed target %s', (target) => {
    expect(classifyRemoteRoute('GET', target)).toEqual({ kind: 'deny' });
  });

  it.each(['POST', 'DELETE', 'PUT', 'HEAD'])('denies %s', (method) => {
    expect(classifyRemoteRoute(method, '/api/fleet/job?id=RQ-EXAMPLE')).toEqual({ kind: 'deny' });
  });
});
