import { describe, expect, it } from 'vitest';
import type { AppActionEntry, AppActionsReport } from '../../../../core/apps-actions.js';
import type { ConversationItem } from './thread-bus-replies.js';
import { threadMatches } from './thread-find-model.js';
import {
  APP_ACTIONS_SHOWN_KEY, conversationActions, foldedEntries, loadAppActionsShown, runCountWords, runFindFields, runLookCount,
  saveAppActionsShown, weaveAppActions, type AppRun,
} from './thread-app-actions.js';

// Local noon, so a few minutes either side never crosses midnight in any zone.
const noon = new Date(2026, 10, 18, 12, 0, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const entry = (key: string, atMs: number, over: Partial<AppActionEntry> = {}): AppActionEntry =>
  ({ key, at: iso(atMs), action: 'open', app: 'Xcode', outcome: 'done', detail: null, ...over });
const line = (id: string, at: number): ConversationItem => ({ type: 'line', line: { id, at, who: 'leader', source: 'thread', text: id, ack: null } });
const bus = (key: string, atMs: number): ConversationItem => ({ type: 'bus', row: { key, at: iso(atMs), from: 'worker', kind: 'reply', excerpt: key, expired: false } });
const report = (actions: AppActionEntry[]): AppActionsReport => ({
  schema: 'phm.apps.actions/1', version: 1, generatedAt: iso(noon), source: 'available', actions, total: actions.length, counts: {}, lookups: 0, skipped: 0, truncated: false,
});
const shape = (items: ReturnType<typeof weaveAppActions>) =>
  items.map(item => (item.type === 'app' ? item.run.entries.map(e => e.key) : item.type === 'line' ? item.line.id : item.row.key));

describe('conversationActions', () => {
  const items = [line('first', noon), line('second', noon + 60_000)];

  it('keeps the actions logged since the oldest dated item, oldest first', () => {
    // The report is newest first, as the route sends it.
    const kept = conversationActions(report([entry('c', noon + 90_000), entry('b', noon + 30_000), entry('a', noon - 1)]), items);
    expect(kept.map(e => e.key)).toEqual(['b', 'c']);
  });

  it('keeps the feed order for actions logged in the same millisecond', () => {
    const kept = conversationActions(report([entry('later', noon + 5), entry('sooner', noon + 5)]), items);
    expect(kept.map(e => e.key)).toEqual(['sooner', 'later']);
  });

  it('leaves out an action whose time cannot be read', () => {
    expect(conversationActions(report([{ ...entry('bad', noon + 1), at: 'yesterday-ish' }]), items)).toEqual([]);
  });

  it('takes none when the log is not read or nothing in the conversation is dated', () => {
    expect(conversationActions(null, items)).toEqual([]);
    expect(conversationActions(report([entry('a', noon)]), [line('undated', Number.NaN)])).toEqual([]);
    expect(conversationActions(report([entry('a', noon)]), [])).toEqual([]);
  });

  it('counts a bus reply as part of the conversation span', () => {
    const kept = conversationActions(report([entry('a', noon - 5_000)]), [bus('early', noon - 10_000), line('first', noon)]);
    expect(kept.map(e => e.key)).toEqual(['a']);
  });
});

describe('weaveAppActions', () => {
  it('places each action before the first item that is later, and groups neighbours into one run', () => {
    const woven = weaveAppActions(
      [line('first', noon), bus('reply', noon + 60_000), line('last', noon + 120_000)],
      [entry('a', noon + 10_000), entry('b', noon + 20_000), entry('c', noon + 90_000), entry('d', noon + 200_000)],
    );
    expect(shape(woven)).toEqual(['first', ['a', 'b'], 'reply', ['c'], 'last', ['d']]);
  });

  it('dates a run by its first action and its newest', () => {
    const [, item] = weaveAppActions([line('first', noon)], [entry('a', noon + 1_000), entry('b', noon + 9_000)]);
    expect(item).toMatchObject({ type: 'app', run: { key: 'app-a', atMs: noon + 1_000, lastAt: iso(noon + 9_000) } });
  });

  it('keeps undated lines last, after every action', () => {
    const woven = weaveAppActions([line('first', noon), line('undated', Number.NaN)], [entry('a', noon + 1_000)]);
    expect(shape(woven)).toEqual(['first', ['a'], 'undated']);
  });

  it('ends a run at midnight so each part sits under its own day', () => {
    const lateEvening = new Date(2026, 10, 18, 23, 59, 0).getTime();
    const woven = weaveAppActions([line('first', noon)], [entry('a', lateEvening), entry('b', lateEvening + 120_000)]);
    expect(shape(woven)).toEqual(['first', ['a'], ['b']]);
  });

  it('returns the conversation untouched when there is no action', () => {
    const items = [line('first', noon)];
    expect(weaveAppActions(items, [])).toEqual(items);
  });
});

describe('a run', () => {
  const run = (count: number, over: (i: number) => Partial<AppActionEntry> = () => ({})): AppRun => {
    const entries = Array.from({ length: count }, (_, i) => entry(`e${i}`, noon + i * 1_000, over(i)));
    return { key: 'app-e0', atMs: noon, lastAt: entries[count - 1]!.at, entries };
  };

  it('lists four actions in full and folds a longer run to its newest three', () => {
    expect(foldedEntries(run(4), false)).toHaveLength(4);
    expect(foldedEntries(run(6), false).map(e => e.key)).toEqual(['e3', 'e4', 'e5']);
    expect(foldedEntries(run(6), true)).toHaveLength(6);
  });

  it('counts the actions that did not simply finish', () => {
    const outcomes: AppActionEntry['outcome'][] = ['done', 'refused', 'dry-run', 'needs-you', 'no-result'];
    expect(runLookCount(run(5, i => ({ outcome: outcomes[i]! })))).toBe(3);
    expect(runLookCount(run(2))).toBe(0);
  });

  it('words the count', () => {
    expect(runCountWords(1)).toBe('1 app action');
    expect(runCountWords(6)).toBe('6 app actions');
  });

  it('is found by the sentence, the app and the logged detail', () => {
    const one = run(1, () => ({ action: 'quit', app: 'Slack', outcome: 'refused', detail: 'not on the allowlist' }));
    expect(runFindFields(one)).toEqual(['Refused to quit Slack', 'Slack', 'not on the allowlist']);
    const items = [{ type: 'app' as const, key: one.key, run: one }];
    expect(threadMatches(items, 'allowlist')).toEqual(['app-e0']);
    expect(threadMatches(items, 'refused to quit')).toEqual(['app-e0']);
    expect(threadMatches(items, 'xcode')).toEqual([]);
  });
});

describe('the shown choice', () => {
  const store = () => {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
  };

  it('is shown until turned off, and remembers either choice', () => {
    const storage = store();
    expect(loadAppActionsShown(storage)).toBe(true);
    saveAppActionsShown(storage, false);
    expect(storage.getItem(APP_ACTIONS_SHOWN_KEY)).toBe('hidden');
    expect(loadAppActionsShown(storage)).toBe(false);
    saveAppActionsShown(storage, true);
    expect(loadAppActionsShown(storage)).toBe(true);
  });

  it('is shown when storage is missing or throws', () => {
    expect(loadAppActionsShown(null)).toBe(true);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadAppActionsShown(broken)).toBe(true);
    expect(() => saveAppActionsShown(broken, false)).not.toThrow();
  });
});
