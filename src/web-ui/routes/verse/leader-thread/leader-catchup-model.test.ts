import { describe, expect, it } from 'vitest';
import type { Merged } from '../fleet-merges/fleet-merges-model.js';
import { AWAY_MIN_MS, LEADER_LAST_LOOKED_KEY, awayWindow, catchUp, catchUpParts, loadLastLooked, saveLastLooked } from './leader-catchup-model.js';
import type { BusReply } from './thread-bus-replies.js';
import type { MergedLine } from './thread-merge-model.js';

const MIN = 60_000, HOUR = 60 * MIN;
// A whole minute, so the window's minute floor does not move the edges under test.
const NOW = Date.parse('2026-11-18T18:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const line = (over: Partial<MergedLine> & Pick<MergedLine, 'id' | 'at'>): MergedLine => ({ who: 'leader', source: 'verse', text: 'Hello.', ack: null, ...over });
const bus = (key: string, at: number): BusReply => ({ key, at: iso(at), from: 'worker', kind: 'message', excerpt: 'done', expired: false });
const pr = (number: number, mergedAt: number | null, at: number | null = null): Merged => ({
  repo: 'ashlrai/phantom', number, title: `PR ${number}`, href: null, job: null, lane: null,
  at: at === null ? null : iso(at), openedAt: null, mergedAt: mergedAt === null ? null : iso(mergedAt), openToMergeMs: null,
});
const memory = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, data };
};

describe('the last-looked moment', () => {
  it('round-trips through storage and reads anything else as no mark', () => {
    const store = memory();
    expect(loadLastLooked(store)).toBeNull();
    saveLastLooked(store, NOW);
    expect(store.data.get(LEADER_LAST_LOOKED_KEY)).toBe(String(NOW));
    expect(loadLastLooked(store)).toBe(NOW);
    expect(loadLastLooked(memory({ [LEADER_LAST_LOOKED_KEY]: 'not json' }))).toBeNull();
    expect(loadLastLooked(memory({ [LEADER_LAST_LOOKED_KEY]: '"yesterday"' }))).toBeNull();
    expect(loadLastLooked(memory({ [LEADER_LAST_LOOKED_KEY]: '-5' }))).toBeNull();
    expect(loadLastLooked(null)).toBeNull();
  });

  it('never throws when storage refuses', () => {
    const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadLastLooked(denied)).toBeNull();
    expect(() => saveLastLooked(denied, NOW)).not.toThrow();
    expect(() => saveLastLooked(null, NOW)).not.toThrow();
  });

  it('opens a window only after a real absence', () => {
    expect(awayWindow(null, NOW)).toBeNull();
    expect(awayWindow(NOW - AWAY_MIN_MS + 1, NOW)).toBeNull();
    expect(awayWindow(NOW - AWAY_MIN_MS, NOW)).toEqual({ since: NOW - AWAY_MIN_MS, until: NOW });
  });
});

describe('what arrived while Mason was away', () => {
  const window = { since: NOW - 30 * MIN, until: NOW };

  it('counts only what falls inside the window and leaves out Mason and plain system lines', () => {
    const view = catchUp({
      lines: [
        line({ id: 'old', at: NOW - 45 * MIN, text: 'Before he left.' }),
        line({ id: 'mine', at: NOW - 20 * MIN, who: 'mason', source: 'imessage', text: 'From my phone.' }),
        line({ id: 'sys', at: NOW - 19 * MIN, source: 'system', text: 'Telegram connected.' }),
        line({ id: 'said', at: NOW - 15 * MIN, text: 'The **judge queue** is clear.\n\nNext: `merge` lane.' }),
        line({ id: 'ask', at: NOW - 10 * MIN, source: 'outbox', kind: 'decision', text: 'Needs you: approve the spend raise.' }),
        line({ id: 'later', at: NOW + 5 * MIN, text: 'Arrived after he was back.' }),
      ],
      busRows: [bus('b-old', NOW - 40 * MIN), bus('b-new', NOW - 5 * MIN)],
      merged: [pr(1, NOW - 50 * MIN), pr(2, NOW - 12 * MIN), pr(3, null, NOW - 8 * MIN), pr(4, null)],
    }, window);
    expect(view).toMatchObject({ leaderMessages: 2, needsYou: 1, busReplies: 1, merged: 2, mergedPartial: false, laneChanges: [], total: 5 });
    expect(view.latest).toEqual({ at: NOW - 10 * MIN, text: 'Needs you: approve the spend raise.' });
    expect(view.firstNewAt).toBe(NOW - 15 * MIN);
    expect(catchUpParts(view).map(part => part.text)).toEqual(['2 Leader messages', '1 needs you', '1 bus reply', '2 PRs merged']);
    expect(catchUpParts(view).find(part => part.key === 'needs-you')?.tone).toBe('attention');
  });

  it('reads the newest message as one plain line', () => {
    const view = catchUp({ lines: [line({ id: 'said', at: NOW - MIN, text: 'The **judge queue** is clear.\n\nNext: `merge` lane.' })], busRows: [], merged: [] }, window);
    expect(view.latest?.text).toBe('The judge queue is clear. Next: merge lane.');
    const long = catchUp({ lines: [line({ id: 'long', at: NOW - MIN, text: 'word '.repeat(80) })], busRows: [], merged: [] }, window);
    expect(long.latest!.text.length).toBeLessThanOrEqual(200);
    expect(long.latest!.text.endsWith('…')).toBe(true);
  });

  it('keeps a line written later in the minute he left', () => {
    // He left at :30:40; the outbox stamps whole minutes, so a line written at :30:55 reads as :30:00.
    const left = NOW - 30 * MIN + 40_000;
    const view = catchUp({ lines: [line({ id: 'edge', at: NOW - 30 * MIN, source: 'outbox', kind: 'fyi' }), line({ id: 'before', at: NOW - 31 * MIN })], busRows: [], merged: [] }, { since: left, until: NOW });
    expect(view.leaderMessages).toBe(1);
  });

  it('says merged PRs are unknown when the fleet read has not answered, and never counts them', () => {
    const view = catchUp({ lines: [line({ id: 'said', at: NOW - MIN })], busRows: [], merged: null }, window);
    expect(view.merged).toBeNull();
    expect(view.total).toBe(1);
    expect(catchUpParts(view)).toEqual([{ key: 'leader', text: '1 Leader message' }, { key: 'merged', text: 'merged PRs unknown', tone: 'unknown' }]);
  });

  it('marks the merge count as the last hour only after a longer absence', () => {
    const view = catchUp({ lines: [], busRows: [], merged: [pr(7, NOW - 20 * MIN)] }, { since: NOW - 5 * HOUR, until: NOW });
    expect(view).toMatchObject({ merged: 1, mergedPartial: true, firstNewAt: null, latest: null, total: 1 });
    expect(catchUpParts(view).map(part => part.text)).toEqual(['1 PR merged in the last hour']);
  });

  it('lists the newest lane changes in order and counts the earlier ones', () => {
    const lane = (name: string, ago: number) => line({ id: `lane-${name}-held-${NOW - ago}`, at: NOW - ago, source: 'system', text: `${name} held: usage_limit` });
    // Handed over out of order, as two joined lists would be.
    const view = catchUp({ lines: [lane('grok-a', 5 * MIN), lane('codex-personal', 25 * MIN), lane('claude-max', 10 * MIN)], busRows: [], merged: [] }, window);
    expect(view.laneChanges).toEqual(['codex-personal held: usage_limit', 'claude-max held: usage_limit', 'grok-a held: usage_limit']);
    expect(view).toMatchObject({ leaderMessages: 0, total: 3, firstNewAt: NOW - 25 * MIN });
    expect(catchUpParts(view).map(part => part.text)).toEqual(['claude-max held: usage_limit', 'grok-a held: usage_limit', '1 earlier lane change']);
  });

  it('holds nothing when nothing arrived', () => {
    const view = catchUp({ lines: [line({ id: 'old', at: NOW - 2 * HOUR })], busRows: [], merged: [] }, window);
    expect(view).toMatchObject({ total: 0, latest: null, firstNewAt: null });
    expect(catchUpParts(view)).toEqual([]);
  });
});
