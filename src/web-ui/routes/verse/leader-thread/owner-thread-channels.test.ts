import { expect, it } from 'vitest';
import { parseOwnerThreadRead } from './owner-thread-queries.js';

const good = { id: 'owner-test-1', enabled: false, reason: 'Off', nextStep: 'Enable it' };
it('reads valid adapters and drops malformed rows individually', () => {
  expect(parseOwnerThreadRead({ status: { adapters: [good, null, {}, { ...good, enabled: 'yes' }, { ...good, nextStep: null }] } }).channels)
    .toEqual([good, { ...good, nextStep: null }]);
});
it('returns no channels for missing or malformed status adapters', () => {
  expect(parseOwnerThreadRead({}).channels).toEqual([]);
  expect(parseOwnerThreadRead({ status: { adapters: {} } }).channels).toEqual([]);
});
