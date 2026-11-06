import { expect, it } from 'vitest';
import { PENDING_ACK_KEY, loadPendingAck, savePendingAck } from '../src/web-ui/routes/verse/fleet/interject-ack-model.js';

const GIVE_UP = 20 * 60_000;
const NOW = 1_800_000_000_000;

function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(PENDING_ACK_KEY, initial);
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

it('round-trips with the right remainingMs', () => {
  const s = fakeStorage();
  savePendingAck(s, { id: 'ack-fake-1', sentAtMs: NOW - 5 * 60_000 });
  expect(loadPendingAck(s, NOW, GIVE_UP)).toEqual({ id: 'ack-fake-1', sentAtMs: NOW - 5 * 60_000, remainingMs: 15 * 60_000 });
  expect(s.map.has(PENDING_ACK_KEY)).toBe(true);
});

it('returns null for a missing record', () => {
  expect(loadPendingAck(fakeStorage(), NOW, GIVE_UP)).toBeNull();
});

it('drops an expired record and removes the key', () => {
  const s = fakeStorage();
  savePendingAck(s, { id: 'ack-fake-1', sentAtMs: NOW - GIVE_UP });
  expect(loadPendingAck(s, NOW, GIVE_UP)).toBeNull();
  expect(s.map.has(PENDING_ACK_KEY)).toBe(false);
});

it.each([
  ['malformed JSON', '{nope'],
  ['non-object JSON', 'null'],
  ['wrong version', JSON.stringify({ v: 2, id: 'ack-fake-1', sentAtMs: NOW })],
  ['empty id', JSON.stringify({ v: 1, id: '', sentAtMs: NOW })],
  ['overlong id', JSON.stringify({ v: 1, id: 'x'.repeat(201), sentAtMs: NOW })],
  ['non-numeric sentAtMs', JSON.stringify({ v: 1, id: 'ack-fake-1', sentAtMs: 'now' })],
  ['far-future sentAtMs', JSON.stringify({ v: 1, id: 'ack-fake-1', sentAtMs: NOW + 61_000 })],
])('rejects %s and removes the key', (_name, raw) => {
  const s = fakeStorage(raw);
  expect(loadPendingAck(s, NOW, GIVE_UP)).toBeNull();
  expect(s.map.has(PENDING_ACK_KEY)).toBe(false);
});

it('tolerates small clock skew into the future', () => {
  const s = fakeStorage(JSON.stringify({ v: 1, id: 'ack-fake-1', sentAtMs: NOW + 30_000 }));
  expect(loadPendingAck(s, NOW, GIVE_UP)?.remainingMs).toBe(GIVE_UP + 30_000);
});

it('never throws when storage throws', () => {
  const boom = () => { throw new Error('denied'); };
  const s = { getItem: boom, setItem: boom, removeItem: boom };
  expect(() => savePendingAck(s, { id: 'ack-fake-1', sentAtMs: NOW })).not.toThrow();
  expect(() => savePendingAck(s, null)).not.toThrow();
  expect(loadPendingAck(s, NOW, GIVE_UP)).toBeNull();
});

it('save(null) removes the key', () => {
  const s = fakeStorage('x');
  savePendingAck(s, null);
  expect(s.map.has(PENDING_ACK_KEY)).toBe(false);
});
