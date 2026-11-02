import { expect, it } from 'vitest';
import { buildMasonEnvelope, canPost, postOutcomeText, recentSenders, trimPost } from './bus-post-model.js';

it('builds channel-compatible, stable desktop interjections and optional replies', () => {
  const input = { to: 'graph-coordinator', text: '  hello  ', now: 1_700_000_000_000 };
  const envelope = buildMasonEnvelope(input);
  expect(envelope).toEqual({ id: `mason-desktop-${envelope.body.dedupeKey}`, from: 'mason', to: input.to,
    priority: 'P0', ttl: 604_800_000, body: { kind: 'interjection', channel: 'desktop', text: 'hello',
      receivedAt: '2023-11-14T22:13:20.000Z', dedupeKey: expect.stringMatching(/^[0-9a-f]{16}$/) } });
  expect(buildMasonEnvelope({ ...input, now: input.now + 1000 }).id).toBe(envelope.id);
  expect(buildMasonEnvelope({ ...input, to: 'leaders' }).id).not.toBe(envelope.id);
  expect(buildMasonEnvelope({ ...input, replyTo: 'fake-1' }).body.replyTo).toBe('fake-1');
  expect(envelope.body).not.toHaveProperty('replyTo');
});

it('limits input and refuses blank messages or sends in progress', () => {
  expect(trimPost(` ${'a'.repeat(6001)} `)).toHaveLength(6000);
  expect(canPost('  ', 'leaders', false)).toBe(false);
  expect(canPost('yes', 'leaders', true)).toBe(false);
  expect(canPost('yes', 'leaders', false)).toBe(true);
});

it('lists distinct recent senders in order and caps them at eight', () => {
  const rows = ['mason', 'agent-9', 'agent-9', 'leaders', ...Array.from({ length: 10 }, (_, i) => `agent-${i}`)].map(from => ({ from }));
  expect(recentSenders(rows)).toEqual(['agent-9', 'leaders', 'agent-0', 'agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5']);
});

it('explains each outcome', () => {
  expect(postOutcomeText('posted', 3)).toContain('Posted');
  expect(postOutcomeText('duplicate')).toMatch(/already on the bus/i);
  expect(postOutcomeText('invalid')).toMatch(/invalid/i);
  expect(postOutcomeText('conflict')).toMatch(/different message/i);
  expect(postOutcomeText('full')).toMatch(/bus is full/i);
  expect(postOutcomeText('unavailable')).toMatch(/unavailable/i);
  expect(postOutcomeText('locked')).toMatch(/unlock/i);
  expect(postOutcomeText('dispatch-disabled')).toBe('This hub was started without --allow-dispatch, so nothing can post.');
});
