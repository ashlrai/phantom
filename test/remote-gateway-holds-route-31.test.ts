import { describe, expect, it } from 'vitest';
import { classifyRemoteRoute, validateRemoteMutation } from '../src/core/web/remote-gateway-policy.js';

describe('remote gateway holds route for the paired phone', () => {
  it('reads lane holds as a fleet read and rejects queries on it', () => {
    expect(classifyRemoteRoute('GET', '/api/verse/fleet/control/holds'))
      .toEqual({ kind: 'read', path: '/api/verse/fleet/control/holds' });
    for (const target of [
      '/api/verse/fleet/control/holds?limit=1',
      '/api/verse/fleet/control/holds?lane=codex-personal',
    ]) expect(classifyRemoteRoute('GET', target)).toEqual({ kind: 'deny' });
  });

  it('keeps a hold release behind step-up and validates the exact body', () => {
    const holds = classifyRemoteRoute('POST', '/api/verse/fleet/control/holds');
    expect(holds).toEqual({ kind: 'write', path: '/api/verse/fleet/control/holds', stepUp: true });
    expect(validateRemoteMutation(holds, { lane: 'codex-personal', action: 'release' })).toBe(true);
    expect(validateRemoteMutation(holds, { lane: 'codex-personal', action: 'release', reason: 'released from phone' })).toBe(true);
    expect(validateRemoteMutation(holds, { lane: 'claude', action: 'release', reason: '' })).toBe(true);
  });

  it('rejects wrong actions, extra keys, malformed lanes and oversized reasons', () => {
    const holds = classifyRemoteRoute('POST', '/api/verse/fleet/control/holds');
    for (const body of [
      { lane: 'codex-personal', action: 'release', extra: 1 },
      { lane: 'codex-personal', action: 'hold' },
      { lane: 'codex-personal', action: 'release', action2: 'release' },
      { lane: 'codex-personal' },
      { action: 'release' },
      { lane: 'Codex_Personal', action: 'release' },
      { lane: 'c', action: 'release' },
      { lane: 'codex-personal', action: 'release', reason: 5 },
      { lane: 'codex-personal', action: 'release', reason: 'x'.repeat(121) },
      'release codex-personal',
      null,
    ]) expect(validateRemoteMutation(holds, body)).toBe(false);
  });

  it('denies every other method on the holds route', () => {
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      expect(classifyRemoteRoute(method, '/api/verse/fleet/control/holds')).toEqual({ kind: 'deny' });
    }
    expect(classifyRemoteRoute('POST', '/api/verse/fleet/control/holds?x=1')).toEqual({ kind: 'deny' });
  });
});
