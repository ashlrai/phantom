import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { fleetSendLanding, postFleetInterjection } from './fleet-interject.js';

beforeEach(() => setMutationToken('fake-fleet-test-token'));
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it('shows the one-line job command reply where the ack text shows', async () => {
  const command = { status: 'stopped', reply: 'Stopped RQ-PHX-FAKEJOB01 (2 processes).' };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ at: '2026-11-02 12:00', command })));
  const ack = await postFleetInterjection('/stop RQ-PHX-FAKEJOB01');
  expect(ack.reply).toBe(command.reply);
  expect(fleetSendLanding(ack)).toEqual({ text: command.reply, openInbox: false });
});

it('keeps the ordinary landing when the response has no command', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ at: '2026-11-02 12:00' })));
  const ack = await postFleetInterjection('please look at the queue');
  expect(ack.reply).toBeUndefined();
  expect(fleetSendLanding(ack).openInbox).toBe(true);
});
