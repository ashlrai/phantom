import { describe, expect, it } from 'vitest';
import { classifyRemoteRoute, validateRemoteMutation } from '../src/core/web/remote-gateway-policy.js';
import { remoteChannelHeaders } from '../src/core/web/remote-gateway.js';

// Regression coverage for the recovered RQ-PHX-PHONECOSASK17 work: a paired
// phone may ask the chief of staff and read the answer, while approval stays
// desktop-only.
describe('recut-n4r3300s79 phone cos ask policy', () => {
  it('classifies the ask write without step-up and the reads as reads', () => {
    expect(classifyRemoteRoute('POST', '/api/verse/fleet/cos/ask'))
      .toEqual({ kind: 'write', path: '/api/verse/fleet/cos/ask', stepUp: false });
    expect(classifyRemoteRoute('GET', '/api/verse/fleet/cos/list'))
      .toEqual({ kind: 'read', path: '/api/verse/fleet/cos/list' });
    expect(classifyRemoteRoute('GET', `/api/verse/fleet/cos/status?id=cos-${'b'.repeat(32)}`))
      .toEqual({ kind: 'read', path: '/api/verse/fleet/cos/status' });
  });

  it('refuses a client-asserted channel in the ask body', () => {
    const route = classifyRemoteRoute('POST', '/api/verse/fleet/cos/ask');
    expect(validateRemoteMutation(route, { text: 'fleet state?' })).toBe(true);
    expect(validateRemoteMutation(route, { text: 'fleet state?', channel: 'mobile' })).toBe(false);
  });

  it('stamps the mobile channel header on forwarded ask posts only', () => {
    expect(remoteChannelHeaders('/api/verse/fleet/cos/ask')).toEqual({ 'x-ashlr-channel': 'mobile' });
    expect(remoteChannelHeaders('/api/verse/fleet/cos/status')).toEqual({});
  });
});
