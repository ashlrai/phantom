import { describe, expect, it } from 'vitest';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';

describe('remote gateway release-pr read for the paired phone', () => {
  it('reads the release-pr route bare', () => {
    expect(classifyRemoteRoute('GET', '/api/verse/release-pr')).toEqual({ kind: 'read', path: '/api/verse/release-pr' });
  });

  it('denies a query variant on the release-pr path', () => {
    expect(classifyRemoteRoute('GET', '/api/verse/release-pr?x=1')).toEqual({ kind: 'deny' });
  });

  it('denies writes and deletes on the release-pr path', () => {
    expect(classifyRemoteRoute('POST', '/api/verse/release-pr')).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('DELETE', '/api/verse/release-pr')).toEqual({ kind: 'deny' });
  });
});
