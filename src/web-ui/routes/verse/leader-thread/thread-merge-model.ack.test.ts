import { describe, expect, it } from 'vitest';
import { annotateAck } from '../fleet-inbox/inbox-ack-model.js';
import { mergeThread, type ThreadPostShape } from './thread-merge-model.js';

const now = Date.parse('2026-10-31T14:00:00Z');
const inbox = [
  { at: '2026-10-31 09:50', source: 'Telegram', text: 'Earlier' },
  { at: '2026-10-31 09:58', source: 'Chat', text: 'Later' },
];
const runs = { generatedAt: new Date(now).toISOString(), leaders: [{ ageSeconds: 300 }] };
const post = (overrides: Partial<ThreadPostShape> = {}): ThreadPostShape => ({
  id: 'leader', at: new Date(now).toISOString(), from: 'leader', channel: 'verse', kind: 'message', text: 'Reply', ...overrides,
});

describe('mergeThread acknowledgments', () => {
  it('matches the Inbox annotations for each entry and leaves leader and system lines unannotated', () => {
    const { lines } = mergeThread([post(), post({ id: 'system', channel: 'system' })], inbox, now, runs);
    const expected = annotateAck(inbox.map(entry => ({ ...entry, priority: '—' })), runs, now);
    expect(lines.filter(line => line.who === 'mason').map(line => line.ack)).toEqual(
      expected.map(entry => ({ state: entry.ack, text: entry.ackLabel })),
    );
    expect(lines.find(line => line.id === 'inbox-0')?.ack?.state).toBe('seen');
    expect(lines.find(line => line.id === 'inbox-1')?.ack?.state).toBe('waiting');
    expect(lines.filter(line => line.who === 'leader').every(line => line.ack === null)).toBe(true);
  });

  it('keeps the Inbox overdue label and omits unknown acknowledgments', () => {
    const overdueNow = now + 30 * 60_000;
    const line = mergeThread([], inbox, overdueNow, runs).lines.find(row => row.id === 'inbox-1');
    expect(line?.ack).toEqual({ state: 'waiting', text: 'Waiting · pass overdue by 20 min' });
    expect(mergeThread([], inbox, now).lines.every(row => row.ack === null)).toBe(true);
    expect(mergeThread([], inbox, now, { leaders: [] }).lines.every(row => row.ack === null)).toBe(true);
    expect(mergeThread([], [{ ...inbox[0]!, at: 'bad timestamp' }], now, runs).undated[0]?.ack).toBeNull();
  });

  it('preserves the acknowledgment when an inbox entry is relayed into the thread', () => {
    const result = mergeThread([post({ id: 'relay', from: 'mason', channel: 'telegram', text: 'Earlier' })], inbox, now, runs);
    expect(result.lines.find(line => line.id === 'relay')?.ack?.state).toBe('seen');
    expect(result.lines.filter(line => line.text === 'Earlier')).toHaveLength(1);
  });

  it('does not attribute ambiguous relayed entries or system lines', () => {
    const duplicated = [inbox[0]!, { ...inbox[1]!, text: inbox[0]!.text }];
    const result = mergeThread([post({ id: 'relay', from: 'mason', text: 'Earlier' })], duplicated, now, runs);
    expect(result.lines.find(line => line.id === 'relay')?.ack).toBeNull();
    expect(mergeThread([], [{ ...inbox[0]!, source: 'system' }], now, runs).lines[0]?.ack).toBeNull();
  });
});
