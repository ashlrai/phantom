import { describe, expect, it } from 'vitest';
import { releasePrMergeable } from './fleet-releases-model.js';
import type { ReleasePr } from '../fleet/release-pr-query.js';

const base: ReleasePr = {
  number: 1479, title: 'chore(master): release 3.30.0', url: 'https://github.com/ashlrai/phantom/pull/1479',
  version: '3.30.0', openedAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z',
  mergeable: 'MERGEABLE', checks: [{ name: 'Merge Gate', state: 'pass', url: null }],
  failing: [], pending: 0, blocked: false, summary: '3.30.0 green, waiting for merge',
};

describe('releasePrMergeable', () => {
  it('is true only when the row is green — not blocked, pending 0, no failing checks', () => {
    expect(releasePrMergeable(base)).toBe(true);
    expect(releasePrMergeable({ ...base, blocked: true, failing: ['audit'] })).toBe(false);
    expect(releasePrMergeable({ ...base, pending: 2 })).toBe(false);
    expect(releasePrMergeable({ ...base, failing: ['audit'] })).toBe(false);
  });
});
