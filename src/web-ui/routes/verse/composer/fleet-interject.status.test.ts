import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { draftAfterSend, fleetSendStatus, postFleetInterjection } from './fleet-interject.js';

beforeEach(() => setMutationToken('a'.repeat(64)));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it.each([
  [{ duplicate: true, accepted: false }, 'duplicate', 'Already in the inbox (same text, sent 00:13)'],
  [{ duplicate: false, accepted: true }, 'accepted', 'Sent to the leaders · 00:13'],
  [{}, 'accepted', 'Sent to the leaders · 00:13'],
] as const)('reports the inbox response %j', async (response, outcome, status) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ at: '2026-10-31 00:13', ...response })));
  const result = await postFleetInterjection('Please prioritize tests');
  expect(result.outcome).toBe(outcome);
  expect(fleetSendStatus(result)).toBe(status);
});

it('keeps duplicate and concurrently edited drafts, but clears an accepted unchanged draft', () => {
  expect(draftAfterSend('duplicate', '/fleet Hello', '/fleet Hello')).toBe('/fleet Hello');
  expect(draftAfterSend('accepted', '/fleet Edited', '/fleet Hello')).toBe('/fleet Edited');
  expect(draftAfterSend('accepted', '/fleet Hello', '/fleet Hello')).toBe('');
});
