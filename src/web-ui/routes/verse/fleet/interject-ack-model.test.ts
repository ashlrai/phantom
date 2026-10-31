import { expect, it, vi } from 'vitest';
import { ackState, ackText, DRAFT_KEY, loadDraft, newestLeaderPassMs, parseInboxAt, saveDraft, sourceChip } from './interject-ack-model.js';

it('parses Eastern wall times across daylight and standard time', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  expect(parseInboxAt('2026-07-10 12:30', now)).toBe(Date.parse('2026-07-10T16:30:00Z'));
  expect(parseInboxAt('2026-01-10 12:30', now)).toBe(Date.parse('2026-01-10T17:30:00Z'));
  expect(parseInboxAt('2026-03-08 02:30', now)).toBeNull();
  expect(parseInboxAt('2026-02-30 12:30', now)).toBeNull();
  expect(parseInboxAt('bad', now)).toBeNull();
  expect(parseInboxAt('2026-11-01 01:30', Date.parse('2026-11-01T05:45:00Z'))).toBe(Date.parse('2026-11-01T05:30:00Z'));
  expect(parseInboxAt('2026-11-01 01:30', now)).toBe(Date.parse('2026-11-01T06:30:00Z'));
});

it('finds the newest leader pass from the snapshot time', () => {
  expect(newestLeaderPassMs([{ ageSeconds: null }, { ageSeconds: 90 }, { ageSeconds: 15 }], 100_000)).toBe(85_000);
  expect(newestLeaderPassMs([{ ageSeconds: null }], 100_000)).toBeNull();
  expect(newestLeaderPassMs(undefined, 100_000)).toBeNull();
  expect(newestLeaderPassMs([{ ageSeconds: 0 }], NaN)).toBeNull();
});

it('reports acknowledgement states and text', () => {
  expect(ackState(null, 10)).toBe('unknown');
  expect(ackState(10, null)).toBe('unknown');
  expect(ackState(10, 11)).toBe('seen');
  expect(ackState(10, 10)).toBe('waiting');
  expect(ackState(10, 9)).toBe('waiting');
  expect(ackText('seen')).toBe('Seen by a leader pass');
  expect(ackText('waiting')).toBe('Waiting for the next leader pass (every 15 min)');
  expect(ackText('unknown')).toBe('Leader status unknown');
});

it('normalises known channels and bounds unknown labels', () => {
  expect([' telegram ', 'PHANTOM DESKTOP', 'phone', 'cli', 'terminal', 'email', 'page'].map(sourceChip))
    .toEqual(['Telegram', 'Phantom desktop', 'Phone', 'Terminal', 'Terminal', 'Email', 'Page']);
  expect(sourceChip('  a very long unknown channel name  ')).toBe('a very long unknown chan');
});

it('saves, loads and removes drafts, tolerating storage failures', () => {
  const storage = { getItem: vi.fn(() => 'draft'), setItem: vi.fn(), removeItem: vi.fn() };
  expect(loadDraft(storage)).toBe('draft');
  saveDraft(storage, 'new');
  expect(storage.setItem).toHaveBeenCalledWith(DRAFT_KEY, 'new');
  saveDraft(storage, '');
  expect(storage.removeItem).toHaveBeenCalledWith(DRAFT_KEY);
  const fail = () => { throw new Error('blocked'); };
  expect(loadDraft({ getItem: fail })).toBe('');
  expect(() => saveDraft({ setItem: fail, removeItem: fail }, 'draft')).not.toThrow();
  expect(() => saveDraft({ setItem: fail, removeItem: fail }, '')).not.toThrow();
});
