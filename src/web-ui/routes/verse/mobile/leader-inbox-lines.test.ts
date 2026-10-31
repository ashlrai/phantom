import { describe, expect, it } from 'vitest';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { inboxLinesFor } from './leader-inbox-lines.js';

const at = '2026-10-31T12:00:00Z';
const entry = { at, source: 'desktop', text: 'Fake order' };
const snapshot = (inbox = [entry]) => ({ sources: { inbox: 'healthy' }, inbox });
const now = Date.parse(at);

describe('inboxLinesFor', () => {
  it('attributes desktop input and keeps its key stable when other entries arrive', () => {
    const [line] = inboxLinesFor(snapshot(), [], now);
    expect(line).toMatchObject({ text: entry.text, label: 'Phantom desktop', who: 'mason' });
    expect(inboxLinesFor(snapshot([{ ...entry, text: 'Other' }, entry]), [], now)[1]?.key).toBe(line?.key);
  });

  it('dedupes trimmed Mason text in the same minute, preserving repeated orders later', () => {
    const thread = [msg({ from: 'mason', text: ' Fake order ', at: '2026-10-31T12:00:59Z' })];
    expect(inboxLinesFor(snapshot(), thread, now)).toEqual([]);
    expect(inboxLinesFor(snapshot([{ ...entry, at: '2026-10-31T12:01:00Z' }]), thread, now)).toHaveLength(1);
    expect(inboxLinesFor(snapshot(), [msg({ from: 'leader', text: entry.text, at })], now)).toHaveLength(1);
  });

  it('ignores malformed, missing, unhealthy and undated input', () => {
    for (const runs of [null, {}, [], { inbox: [entry] }, { sources: { inbox: 'degraded' }, inbox: [entry] },
      snapshot([ { ...entry, at: 'invalid' } ]), { sources: { inbox: 'healthy' }, inbox: [null] }]) {
      expect(inboxLinesFor(runs, [], now)).toEqual([]);
    }
  });

  it('orders by time', () => {
    const lines = inboxLinesFor(snapshot([{ ...entry, at: '2026-10-31T12:01:00Z' }, entry]), [], now);
    expect(lines.map(line => line.at)).toEqual([now, now + 60_000]);
  });
});
