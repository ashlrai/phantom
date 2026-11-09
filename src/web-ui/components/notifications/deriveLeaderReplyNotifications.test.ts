import { describe, expect, it } from 'vitest';
import type { LabeledLine } from '../../routes/verse/leader-thread/owner-thread-lines.js';
import { deriveLeaderReplyNotifications, newestLeaderLineAt, plainText } from './deriveLeaderReplyNotifications.js';

const T0 = Date.parse('2026-11-09T12:00:00Z');
const line = (id: string, minutes: number, over: Partial<LabeledLine> = {}): LabeledLine =>
  ({ id, at: T0 + minutes * 60_000, who: 'leader', source: 'desktop', text: `reply ${id}`, ack: null, ...over });
const derive = (lines: LabeledLine[], mark: number | null, viewing = false) =>
  deriveLeaderReplyNotifications({ lines, mark, viewing }, T0);

describe('deriveLeaderReplyNotifications', () => {
  it('returns nothing on the seed run (no mark yet)', () => {
    expect(derive([line('a', 1), line('b', 2)], null)).toEqual([]);
  });

  it('notifies each new Leader line, not Mason lines, with stable ids', () => {
    const lines = [line('old', -5), line('a', 1), line('m', 2, { who: 'mason' }), line('b', 3)];
    const first = derive(lines, T0);
    expect(first.map(n => n.id)).toEqual(['leader-reply:b', 'leader-reply:a']);
    expect(first[0]).toMatchObject({ title: 'Leader replied', severity: 'info', category: 'fleet', detail: 'reply b' });
    expect(derive(lines, T0).map(n => n.id)).toEqual(first.map(n => n.id));
  });

  it('collapses beyond three into one "N more" row', () => {
    const rows = derive([1, 2, 3, 4, 5].map(i => line(`l${i}`, i)), T0);
    expect(rows.map(n => n.id)).toEqual(['leader-reply:l5', 'leader-reply:l4', 'leader-reply:l3', 'leader-reply:more']);
    expect(rows[3]!.title).toBe('2 more Leader replies');
  });

  it('never notifies for a system line', () => {
    expect(derive([line('s', 1, { source: 'system' })], T0)).toEqual([]);
  });

  it('is silent while the Leader view is visible and focused', () => {
    expect(derive([line('a', 1)], T0, true)).toEqual([]);
  });

  it('uses time+text ids for positional outbox ids so a rotated outbox does not duplicate', () => {
    const a = derive([line('outbox-0', 1, { source: 'outbox', text: 'hi' })], T0);
    const b = derive([line('outbox-7', 1, { source: 'outbox', text: 'hi' })], T0);
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it('drops the same answer arriving over two channels', () => {
    expect(derive([line('a', 1, { text: 'same' }), line('owner-x', 1, { text: 'same ' })], T0)).toHaveLength(1);
  });

  it('strips markdown and truncates the body to 140 characters', () => {
    const [n] = derive([line('a', 1, { text: `## Done\n**bold** [link](http://x) \`code\` ${'x'.repeat(200)}` })], T0);
    expect(n!.detail.startsWith('Done bold link code xxx')).toBe(true);
    expect(n!.detail).toHaveLength(140);
    expect(plainText('- one\n- two')).toBe('one two');
  });

  it('opens the Leader home view from the action', () => {
    const [n] = derive([line('a', 1)], T0);
    expect(n!.actionRun).toBeTypeOf('function');
    localStorage.clear();
    n!.actionRun!();
    expect(localStorage.getItem('ashlr.verse.home.v1')).toBe('leader');
  });

  it('finds the newest dated Leader line', () => {
    expect(newestLeaderLineAt([line('a', 1), line('b', 4), line('n', 9, { who: 'mason' }), line('u', 0, { at: NaN })])).toBe(T0 + 4 * 60_000);
    expect(newestLeaderLineAt([])).toBeNull();
  });
});
