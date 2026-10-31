import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { fleetSendLanding, postFleetInterjection } from './fleet-interject.js';

beforeEach(() => setMutationToken('fake-fleet-test-token'));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it.each([
  [false, { text: "Sent to the leaders' inbox · 00:13 · open Inbox to confirm", openInbox: true }],
  [true, { text: 'Already in the inbox (same text, sent 00:13)', openInbox: false }],
] as const)('describes the landing for duplicate=%s', async (duplicate, landing) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ at: '2026-10-31 00:13', duplicate })));
  expect(fleetSendLanding(await postFleetInterjection('Please prioritize tests'))).toEqual(landing);
});

it('does not produce a landing when the server cannot confirm delivery', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  await expect(postFleetInterjection('Please prioritize tests')).rejects.toThrow('The message could not be confirmed. Refresh and check the inbox.');
});
