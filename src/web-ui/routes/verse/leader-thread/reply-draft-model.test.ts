import { beforeEach, describe, expect, it } from 'vitest';
import { limitNote, loadDraft, NEAR_LIMIT, parseDraft, REPLY_DRAFT_KEY, REPLY_LIMIT, restoredLabel, saveDraft } from './reply-draft-model.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');

beforeEach(() => { window.localStorage.clear(); });

describe('reply draft model', () => {
  it('keeps a draft with the time it was edited and reads it back', () => {
    expect(saveDraft(window.localStorage, 'ship the board fix', NOW)).toBe('saved');
    expect(loadDraft(window.localStorage)).toEqual({ text: 'ship the board fix', at: NOW });
  });

  it('forgets a blank draft instead of keeping whitespace', () => {
    saveDraft(window.localStorage, 'something', NOW);
    expect(saveDraft(window.localStorage, '  \n', NOW)).toBe('cleared');
    expect(window.localStorage.getItem(REPLY_DRAFT_KEY)).toBeNull();
    expect(loadDraft(window.localStorage)).toBeNull();
  });

  it('reports a draft it could not keep', () => {
    const full = { setItem() { throw new Error('quota'); }, removeItem() {}, getItem: () => null } as unknown as Storage;
    expect(saveDraft(full, 'words', NOW)).toBe('failed');
    expect(saveDraft(null, 'words', NOW)).toBe('failed');
    expect(loadDraft(null)).toBeNull();
  });

  it('reads nothing from a record that is not a draft', () => {
    for (const raw of [null, '', 'not json', '42', 'null', '{"text":7}', '{"text":"   "}']) expect(parseDraft(raw)).toBeNull();
  });

  it('keeps the text when the edit time is missing or wrong, and says the time is unknown', () => {
    const saved = parseDraft('{"text":"hello","at":"yesterday"}');
    expect(saved).toEqual({ text: 'hello', at: null });
    expect(restoredLabel(saved!, NOW)).toBe('Draft restored. When it was last edited is unknown.');
  });

  it('bounds a stored draft to the box limit', () => {
    expect(parseDraft(JSON.stringify({ text: 'x'.repeat(REPLY_LIMIT + 50), at: NOW }))!.text).toHaveLength(REPLY_LIMIT);
  });

  it('says how long ago a restored draft was edited', () => {
    expect(restoredLabel({ text: 'hi', at: NOW - 3 * 3_600_000 }, NOW)).toBe('Draft restored, last edited 3h ago.');
  });

  it('says nothing about the limit until the draft nears it', () => {
    expect(limitNote(0)).toBeNull();
    expect(limitNote(NEAR_LIMIT - 1)).toBeNull();
  });

  it('counts down the room left near the limit', () => {
    expect(limitNote(5700)).toEqual({ tone: 'near', text: '5,700 of 6,000 characters, 300 left.', fill: 0.5 });
  });

  it('says the box is full at the limit', () => {
    const note = limitNote(REPLY_LIMIT)!;
    expect(note.tone).toBe('full');
    expect(note.fill).toBe(1);
    expect(note.text).toContain('6,000 of 6,000 characters');
  });
});
