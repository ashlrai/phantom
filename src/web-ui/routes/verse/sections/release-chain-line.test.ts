import { describe, expect, it } from 'vitest';
import type { ReleaseChainStatus } from '../../../../core/fleet/release-chain-status.js';
import { releaseChainLine } from './release-chain-line.js';

const stopped: ReleaseChainStatus = { verdict: 'held', reason: 'Reason: attest failed', latestAutorun: { sha: 'abcd', rc: 12, mtime: '2026-01-01T00:00:00Z' }, version: null, installedVersion: null, sources: [] };
const now = Date.parse('2026-01-01T01:00:00Z');
describe('release chain line', () => {
  it('hides published and unknown results', () => {
    expect(releaseChainLine({ ...stopped, verdict: 'published' }, now)).toBeNull();
    expect(releaseChainLine({ ...stopped, verdict: 'unknown' }, now)).toBeNull();
  });
  it('shows the observed signing stop and reason', () => {
    expect(releaseChainLine(stopped, now)).toEqual({ step: 'desktop signing', reason: 'Reason: attest failed', ageText: '1h ago' });
  });
  it('caps long reasons', () => {
    expect(releaseChainLine({ ...stopped, reason: 'a'.repeat(200) }, now)?.reason).toHaveLength(160);
  });
  it('hides missing evidence', () => {
    expect(releaseChainLine({ ...stopped, latestAutorun: null }, now)).toBeNull();
    expect(releaseChainLine({ ...stopped, reason: null }, now)).toBeNull();
  });
});
