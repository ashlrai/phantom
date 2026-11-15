import { beforeEach, expect, it } from 'vitest';
import { NOTE_MAX_CHARS } from './steer-action.js';
import { clearSteerNote, loadSteerNote, saveSteerNote } from './steer-note-keep.js';

beforeEach(() => localStorage.clear());

it('round trips and clears a note', () => {
  saveSteerNote(localStorage, '  keep this  ');
  expect(loadSteerNote(localStorage)).toBe('  keep this  ');
  clearSteerNote(localStorage);
  expect(loadSteerNote(localStorage)).toBe('');
});

it('removes whitespace and caps stored text', () => {
  saveSteerNote(localStorage, 'x'.repeat(NOTE_MAX_CHARS + 1));
  expect(loadSteerNote(localStorage)).toHaveLength(NOTE_MAX_CHARS);
  saveSteerNote(localStorage, ' \n ');
  expect(localStorage.length).toBe(0);
});

it('tolerates missing and throwing storage', () => {
  const broken = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } } as unknown as Storage;
  for (const storage of [null, broken]) {
    expect(loadSteerNote(storage)).toBe('');
    expect(() => { saveSteerNote(storage, 'note'); clearSteerNote(storage); }).not.toThrow();
  }
});
