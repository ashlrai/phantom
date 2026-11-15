import { expect, it } from 'vitest';
import { ApiError } from '../../../data/client.js';
import { coordinationLine, type RuntimeSnapshotResponse } from './runtime-snapshot-query.js';

const resp = (coordination: Record<string, unknown>, snap: Record<string, unknown> = {}): RuntimeSnapshotResponse => ({
  v: 1, authority: 'none', generatedAt: '2026-11-14T19:32:00Z',
  snapshot: {
    host: 'fake-host', tailnetName: 'fake-tailnet', installedVersion: '3.30.34',
    lastFleetStateRead: { mtime: '2026-11-14T19:30:00Z', ageSeconds: 120 },
    coordination: { state: 'known', activeClaims: 3, newestReturnAgeSeconds: 300, ...coordination },
    asOf: '2026-11-14T19:32:00Z', reasons: [], ...snap,
  } as RuntimeSnapshotResponse['snapshot'],
});

it('known state prints claims, return age, tailnet and as-of', () => {
  const line = coordinationLine(resp({}));
  expect(line.tone).toBe('ok');
  expect(line.text).toMatch(/^3 live claims · newest return 5m ago · tailnet fake-tailnet · as of \d{2}:\d{2}$/);
});

it('singular claim reads claim, sub-minute ages read seconds', () => {
  expect(coordinationLine(resp({ activeClaims: 1, newestReturnAgeSeconds: 45 })).text)
    .toMatch(/^1 live claim · newest return 45s ago/);
});

it('UNKNOWN claim count prints unknown plus the reason, never zero', () => {
  const line = coordinationLine(resp({ activeClaims: 'UNKNOWN', reason: 'claims ledger: unavailable' }));
  expect(line.tone).toBe('unknown');
  expect(line.text).toMatch(/^unknown live claims · newest return 5m ago .*\(claims ledger: unavailable\)$/);
  expect(line.text).not.toContain('0 live claims');
});

it('coordination state unknown prints unknowns plus the reason', () => {
  const line = coordinationLine(resp(
    { state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN', reason: 'coordination ledger: missing or unreadable' }));
  expect(line.tone).toBe('unknown');
  expect(line.text).toMatch(
    /^unknown live claims · newest return unknown · tailnet fake-tailnet · as of \d{2}:\d{2} \(coordination ledger: missing or unreadable\)$/);
});

it('404 reports the route is not served by this build', () => {
  const err = new ApiError('GET /api/verse/fleet/runtime-identity/snapshot failed (HTTP 404).', 404, '/api/verse/fleet/runtime-identity/snapshot');
  expect(coordinationLine(undefined, err)).toEqual({ text: 'Coordination: not served by this build', tone: 'unknown' });
});

it('network error reports a failed read', () => {
  const line = coordinationLine(undefined, new TypeError('Failed to fetch'));
  expect(line.tone).toBe('unknown');
  expect(line.text).toMatch(/^Coordination: read failed \(.+\)$/);
});

it('no data and no error is a reading, not a zero', () => {
  const line = coordinationLine(undefined);
  expect(line.tone).toBe('unknown');
  expect(line.text).toContain('Coordination:');
  expect(line.text).not.toContain('0 live claims');
});

it('malformed snapshot prints unknowns instead of throwing', () => {
  const line = coordinationLine({ v: 1, authority: 'none', generatedAt: 'g', snapshot: undefined } as unknown as RuntimeSnapshotResponse);
  expect(line.tone).toBe('unknown');
  expect(line.text).toContain('unknown live claims');
});
