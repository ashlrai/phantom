import { expect, it } from 'vitest';
import type { OwnerThreadLine } from '../../leader-thread/owner-thread-queries.js';
import type { ThreadEntry } from '../../leader/thread-model.js';
import { mergeOwnerThread } from './leader-owner-model.js';

const entry = (key: string, at: string, from: 'mason' | 'leader', text: string): ThreadEntry =>
  ({ type: 'message', key, at, message: { id: key, at, from, channel: 'verse', kind: 'message', text } });
const line = (over: Partial<OwnerThreadLine>): OwnerThreadLine =>
  ({ seq: 1, id: 'o1', channel: 'imessage', senderId: 'mason-test', direction: 'inbound', at: '2026-11-09T12:01:00.000Z', text: 'Synthetic hello', ...over });
const thread = [entry('a', '2026-11-09T12:00:00.000Z', 'leader', 'Earlier'), entry('b', '2026-11-09T12:05:00.000Z', 'leader', 'Later')];

it('folds owner lines in by time with their labels', () => {
  const out = mergeOwnerThread(thread, { paused: false, channels: [], lines: [
    line({}),
    line({ seq: 2, id: 'o2', direction: 'outbound', channel: 'desktop', fanout: ['slack', 'desktop'], at: '2026-11-09T12:02:00.000Z', text: 'Synthetic reply' }),
  ] });
  expect(out.entries.map((e) => e.key)).toEqual(['a', 'owner-o1', 'owner-o2', 'b']);
  expect(out.labels.get('owner-o1')).toBe('Mason via iMessage');
  expect(out.labels.get('owner-o2')).toBe('Leader → Slack, Desktop');
  const reply = out.entries[2]!;
  expect(reply.type === 'message' && reply.message.from).toBe('leader');
});

it('drops a desktop line already mirrored in the thread', () => {
  const mirrored = [entry('m', '2026-11-09T12:01:20.000Z', 'mason', 'Synthetic hello')];
  const out = mergeOwnerThread(mirrored, { paused: false, channels: [], lines: [line({ channel: 'desktop' })] });
  expect(out.entries).toBe(mirrored);
});

it('drops rows with an unreadable time', () => {
  const out = mergeOwnerThread(thread, { paused: false, channels: [], lines: [line({ at: 'not a time' })] });
  expect(out.entries).toBe(thread);
});

it('returns the input unchanged for an empty or paused read', () => {
  expect(mergeOwnerThread(thread, { paused: false, channels: [], lines: [] }).entries).toBe(thread);
  const paused = mergeOwnerThread(thread, { paused: true, channels: [], lines: [line({})] });
  expect(paused.entries).toBe(thread);
  expect(paused.labels.size).toBe(0);
});
