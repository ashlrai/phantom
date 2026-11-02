import { expect, it } from 'vitest';
import { lastUsedText, revokeCommand, sortDevices, type PairedDevice } from './paired-devices-model.js';
const base: PairedDevice = { id: '11111111-1111-1111-1111-111111111111', label: 'Fake phone', email: 'fake@example.invalid', subject: 'fake', act: false, createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null };
it('sorts active devices first, newest use first, without mutating input', () => {
  const devices = [{ ...base, id: 'revoked', revokedAt: base.createdAt, lastUsedAt: '2026-01-03' },
    { ...base, id: 'never' }, { ...base, id: 'older', lastUsedAt: '2026-01-01' }, { ...base, id: 'recent', lastUsedAt: '2026-01-02' }];
  expect(sortDevices(devices).map(d => d.id)).toEqual(['recent', 'older', 'never', 'revoked']);
  expect(devices[0].id).toBe('revoked');
});
it('formats relative use and never', () => {
  const now = Date.parse(base.createdAt);
  expect(lastUsedText(null, now)).toBe('never');
  expect(lastUsedText(new Date(now - 180000).toISOString(), now)).toBe('last used 3 m ago');
  expect(lastUsedText(new Date(now - 7200000).toISOString(), now)).toBe('last used 2 h ago');
  expect(lastUsedText(new Date(now - 172800000).toISOString(), now)).toBe('last used 2 d ago');
  expect(lastUsedText(new Date(now + 60000).toISOString(), now)).toBe('last used 0 m ago');
});
it('only produces commands for CLI-valid UUIDs', () => {
  expect(revokeCommand(base.id)).toBe(`phm verse remote revoke ${base.id}`);
  for (const id of ['', '../phone', `${base.id}; echo fake`, base.id.toUpperCase().replace('1', 'A')]) expect(revokeCommand(id)).toBeNull();
});
