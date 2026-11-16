import { describe, expect, it } from 'vitest';
import {
  buildCorrectionText, correctionBodyLimit, correctionClock, CORRECTION_WINDOW_MS, INTERJECT_MAX_CHARS,
  lastCorrectable, LAST_SENT_KEY, saveLastSent,
} from './interject-correction.js';

const ID = 'desk-0123456789abcdef';
function memory(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[LAST_SENT_KEY, initial]]);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('lastCorrectable', () => {
  it('round-trips a send inside the 30 minute window and expires at its edge', () => {
    const storage = memory();
    saveLastSent(storage, { id: ID, text: 'Ping dad', sentAtMs: 1_000 });
    expect(lastCorrectable(storage, 1_000)).toEqual({ id: ID, text: 'Ping dad', sentAtMs: 1_000 });
    expect(lastCorrectable(storage, 1_000 + CORRECTION_WINDOW_MS - 1)).not.toBeNull();
    expect(lastCorrectable(storage, 1_000 + CORRECTION_WINDOW_MS)).toBeNull();
    expect(lastCorrectable(storage, 999)).toBeNull();
  });

  it('reads corrupt or malformed storage as null', () => {
    for (const raw of ['{', '42', '"text"', '[]', JSON.stringify({ id: ID, text: 'x' }),
      JSON.stringify({ id: ID, text: '', sentAtMs: 1 }), JSON.stringify({ id: 'nope', text: 'x', sentAtMs: 1 }),
      JSON.stringify({ id: ID, text: 'x', sentAtMs: '1' })]) {
      expect(lastCorrectable(memory(raw), 1)).toBeNull();
    }
    expect(lastCorrectable({ getItem: () => { throw new Error('denied'); } }, 1)).toBeNull();
  });

  it('forgets the record on null or an invalid id', () => {
    const storage = memory();
    saveLastSent(storage, { id: ID, text: 'x', sentAtMs: 1 });
    saveLastSent(storage, null);
    expect(storage.values.has(LAST_SENT_KEY)).toBe(false);
    saveLastSent(storage, { id: 'DESK-0123456789ABCDEF', text: 'x', sentAtMs: 1 });
    expect(storage.values.has(LAST_SENT_KEY)).toBe(false);
  });
});

describe('buildCorrectionText', () => {
  it('prefixes the trimmed text with the original entry id', () => {
    expect(buildCorrectionText(ID, '  Ping Dot \n')).toBe(`CORRECTION to ${ID}: Ping Dot`);
    expect(buildCorrectionText('cli-ffffffffffffffff', 'x')).toBe('CORRECTION to cli-ffffffffffffffff: x');
  });

  it('rejects ids that are not inbox entry ids', () => {
    for (const id of ['', 'desk', 'desk-0123', 'desk-0123456789ABCDEF', 'Desk-0123456789abcdef',
      'abcdefghijklmnopq-0123456789abcdef', 'desk-0123456789abcdef0', 'de sk-0123456789abcdef', 'desk-0123456789abcdef\n']) {
      expect(buildCorrectionText(id, 'x')).toBeNull();
    }
  });

  it('counts the prefix against the 6,000 character limit', () => {
    const limit = correctionBodyLimit(ID);
    expect(limit).toBe(INTERJECT_MAX_CHARS - `CORRECTION to ${ID}: `.length);
    expect(buildCorrectionText(ID, 'a'.repeat(limit))).toHaveLength(INTERJECT_MAX_CHARS);
  });
});

it('formats the original send time as a 24-hour local clock', () => {
  expect(correctionClock(new Date(2026, 10, 4, 23, 7).getTime())).toBe('23:07');
  expect(correctionClock(new Date(2026, 10, 4, 9, 5).getTime())).toBe('09:05');
});
