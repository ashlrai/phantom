/**
 * The Leader thread carries iMessage, email and mobile messages beside the
 * original four channels. Hermetic: tmp HOME, recordOnly (no model, no seat).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeaderThreadError, appendMasonMessage, listThread } from '../src/core/vision/leader-thread.js';
import { LEADER_THREAD_CHANNELS } from '../src/core/vision/leader-thread-types.js';
import { narrowThreadPage } from '../src/web-ui/routes/verse/leader/thread-model.js';
import { useTmpHome } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
beforeEach(() => home.setup());
afterEach(() => home.teardown());

describe('leader thread channels', () => {
  it('appends the original four channels first, then the new ones', () => {
    expect(LEADER_THREAD_CHANNELS).toEqual(['verse', 'telegram', 'cli', 'system', 'imessage', 'email', 'mobile']);
  });

  it.each(['imessage', 'email', 'mobile'] as const)('records a %s message with no telegram delivery', async (channel) => {
    const res = await appendMasonMessage('hello from phone', { channel, recordOnly: true });
    expect(res.message.channel).toBe(channel);
    expect(res.message.delivery?.telegram).toBeUndefined();
    expect(listThread().map((m) => m.channel)).toContain(channel);
  });

  it('rejects an unknown channel with a 400', async () => {
    const err = await appendMasonMessage('hi', { channel: 'fax' as never, recordOnly: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaderThreadError);
    expect((err as LeaderThreadError).code).toBe(400);
  });

  it('narrowThreadPage keeps new channels and degrades an unknown one to verse', () => {
    const base = { at: '2026-11-04T10:00:00.000Z', from: 'mason', kind: 'message', text: 'x' };
    const page = narrowThreadPage({ messages: [{ ...base, id: 'a', channel: 'imessage' }, { ...base, id: 'b', channel: 'fax' }] });
    expect(page?.messages.map((m) => m.channel)).toEqual(['imessage', 'verse']);
  });
});
