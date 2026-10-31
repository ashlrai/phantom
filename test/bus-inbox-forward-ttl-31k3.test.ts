import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-forward-ttl-'));
  roots.push(root);
  return root;
};
const message = (id = 'fake-1', ttl = 100) => ({
  id, from: 'fake-a', to: 'fake-b', priority: 'P2', ttl, body: { nested: ['original'] },
});
const post = (root: string, at: number, envelope = message()) =>
  appendBusInbox(envelope, { root, now: () => at });
const list = (root: string, at: number, after = 0, limit = 50) =>
  listBusInboxAfter(after, limit, { root, now: () => at });

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it('replays a detached envelope with decreasing remaining lifetime without changing the source or duplicate identity', () => {
  const root = setup(), original = message();
  expect(post(root, 100, original)).toEqual({ status: 'posted', id: original.id, cursor: 1 });
  const file = join(root, 'bus-inbox', 'messages.json');
  const stored = readFileSync(file, 'utf8');
  const halfway = list(root, 150);
  expect(halfway).toEqual({ status: 'ok', nextCursor: 1, messages: [
    { cursor: 1, receivedAt: 100, envelope: { ...original, ttl: 50 } },
  ] });
  if (halfway.status !== 'ok') throw new Error('Expected replay');
  const replayed = halfway.messages[0].envelope;
  (replayed.body as { nested: string[] }).nested[0] = 'changed';
  replayed.ttl = 1;
  expect(list(root, 175)).toEqual({ status: 'ok', nextCursor: 1, messages: [
    { cursor: 1, receivedAt: 100, envelope: { ...original, ttl: 25 } },
  ] });
  expect(list(root, 199)).toMatchObject({ messages: [{ envelope: { ttl: 1 } }] });
  expect(readFileSync(file, 'utf8')).toBe(stored);
  expect(post(root, 175, original)).toEqual({ status: 'duplicate', id: original.id, cursor: 1 });
  expect(post(root, 175, { ...original, ttl: 25 })).toEqual({ status: 'conflict' });
  expect(readFileSync(file, 'utf8')).toBe(stored);
});

it('excludes exact expiry and advances the cursor across expired records and pages', () => {
  const root = setup();
  expect(post(root, 100, message('first', 10)).status).toBe('posted');
  expect(post(root, 100, message('second', 10)).status).toBe('posted');
  expect(post(root, 100, message('live', 20)).status).toBe('posted');
  expect(post(root, 100, message('last', 10)).status).toBe('posted');
  const page = list(root, 110, 0, 1);
  expect(page).toMatchObject({ status: 'ok', nextCursor: 3, messages: [{ cursor: 3, envelope: { ttl: 10 } }] });
  expect(list(root, 110, 3, 1)).toEqual({ status: 'ok', messages: [], nextCursor: 4 });
  expect(list(root, 120)).toEqual({ status: 'ok', messages: [], nextCursor: 4 });
});

it('clamps a clock before receipt to the original TTL', () => {
  const root = setup();
  expect(post(root, 100)).toMatchObject({ status: 'posted' });
  expect(list(root, 0)).toMatchObject({ messages: [{ envelope: { ttl: 100 } }] });
  expect(list(root, 99)).toMatchObject({ messages: [{ envelope: { ttl: 100 } }] });
  expect(list(root, 100)).toMatchObject({ messages: [{ envelope: { ttl: 100 } }] });
  expect(list(root, 101)).toMatchObject({ messages: [{ envelope: { ttl: 99 } }] });
});

it('uses exact safe-integer subtraction at clock and TTL boundaries', () => {
  const root = setup(), max = Number.MAX_SAFE_INTEGER;
  expect(post(root, 0, message('zero', max)).status).toBe('posted');
  expect(post(root, max - 1, message('near-max', max)).status).toBe('posted');
  expect(post(root, max, message('max', 1)).status).toBe('posted');
  expect(list(root, max - 1)).toMatchObject({ messages: [
    { envelope: { id: 'zero', ttl: 1 } },
    { envelope: { id: 'near-max', ttl: max } },
    { envelope: { id: 'max', ttl: 1 } },
  ] });
  expect(list(root, max)).toMatchObject({ nextCursor: 3, messages: [
    { envelope: { id: 'near-max', ttl: max - 1 } },
    { envelope: { id: 'max', ttl: 1 } },
  ] });
  expect(list(root, max + 1)).toEqual({ status: 'invalid' });
});
