import { expect, it } from 'vitest';
import { postAckLine } from './inbox-post-ack-model.js';

const now = Date.parse('2026-11-01T01:44:00Z'); // 21:44 ET
const post = { at: '2026-11-01T01:42:00Z' };
const snapshot = { generatedAt: '2026-11-01T01:44:00Z', leaders: [{ ageSeconds: 540 }] };

it('reports a landed post and the next pass estimate, when available', () => {
  expect(postAckLine(post, snapshot, now)).toEqual({ text: 'Landed 21:42 · waiting for the next leader pass (about 6 min)', tone: 'neutral' });
  expect(postAckLine(post, {}, now)).toEqual({ text: 'Landed 21:42 · waiting for the next leader pass', tone: 'neutral' });
  expect(postAckLine({ at: '2026-10-31 21:42' }, {}, now)).toEqual(postAckLine(post, {}, now));
});

it('marks only a later pass as seen', () => {
  const atPass = { generatedAt: '2026-11-01T01:42:00Z', leaders: [{ ageSeconds: 0 }] };
  expect(postAckLine(post, atPass, now)?.tone).toBe('neutral');
  expect(postAckLine(post, { generatedAt: '2026-11-01T01:46:00Z', leaders: [{ ageSeconds: 60 }] }, Date.parse('2026-11-01T01:46:00Z')))
    .toEqual({ text: 'Seen by the 21:45 pass', tone: 'ok' });
});

it('handles duplicates, missing results, and invalid times without inventing a pass', () => {
  expect(postAckLine({ ...post, duplicate: true }, snapshot, now))
    .toEqual({ text: 'Already in the inbox (same text within the dedupe window)', tone: 'warning' });
  expect(postAckLine(null, snapshot, now)).toBeNull();
  expect(postAckLine({ at: 'invalid' }, snapshot, now)).toEqual({ text: 'Landed · Leader status unknown', tone: 'neutral' });
});
