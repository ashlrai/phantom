import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, lstatSync, writeFileSync, symlinkSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, listBusInboxAfter, BUS_INBOX_MAX_BYTES } from '../src/core/fleet/bus-inbox.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
const roots: string[] = [];
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'bus-test-')); roots.push(root); return { root, now: () => 100 }; };
const message = (id = 'fake-1') => ({ id, from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 100, body: { fake: 'hello' } });
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it('exchanges across independent instances and restart pagination without gaps', () => {
  const a = setup(), b = { ...a };
  for (let i = 0; i < 4; i++) expect(appendBusInbox(message(`fake-${i}`), a).status).toBe('posted');
  const first = listBusInboxAfter(0, 2, b);
  expect(first.status).toBe('ok');
  if (first.status !== 'ok') throw Error('page');
  expect(first.messages.map(row => row.cursor)).toEqual([1, 2]);
  const second = listBusInboxAfter(first.nextCursor, 2, { ...a });
  expect(second).toMatchObject({ nextCursor: 4, messages: [{ cursor: 3 }, { cursor: 4 }] });
  expect(appendBusInbox(message('fake-0'), b)).toMatchObject({ status: 'duplicate', cursor: 1 });
  expect(appendBusInbox({ ...message('fake-0'), body: 'fake conflict' }, a).status).toBe('conflict');
  expect(listBusInboxAfter(0, 100, { ...a, now: () => 200 })).toMatchObject({ messages: [], nextCursor: 4 });
  expect(listBusInboxAfter(0, 100, { ...a, now: () => 300 })).toMatchObject({ messages: [], nextCursor: 4 });
}, 60_000);
it('bounds storage and refuses corrupt, oversized, unsafe files and invalid input', () => {
  const a = setup();
  expect(listBusInboxAfter(0, 50, a)).toMatchObject({ messages: [] });
  expect(existsSync(join(a.root, 'bus-inbox'))).toBe(false);
  expect(appendBusInbox({}, a).status).toBe('invalid');
  expect(appendBusInbox({ ...message(), body: 'x'.repeat(65536) }, a).status).toBe('invalid');
  expect(appendBusInbox(message(), a).status).toBe('posted');
  const file = join(a.root, 'bus-inbox', 'messages.json');
  if (process.platform !== 'win32') {
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(a.root, 'bus-inbox')).mode & 0o777).toBe(0o700);
  }
  writeFileSync(file, '[{"fake":"secret body"');
  expect(listBusInboxAfter(0, 50, a)).toEqual({ status: 'unavailable' });
  expect(appendBusInbox(message('other'), a).status).toBe('unavailable');
  writeFileSync(file, 'x'.repeat(BUS_INBOX_MAX_BYTES + 1));
  expect(listBusInboxAfter(0, 50, a).status).toBe('unavailable');
  rmSync(file); symlinkSync(join(a.root, 'fake-target'), file);
  expect(appendBusInbox(message(), a).status).toBe('unavailable');
}, 60_000);
it('reports lock contention and full store without losing accepted messages', () => {
  const a = setup(); appendBusInbox(message(), a);
  const lock = acquireLocalStoreLock(join(a.root, 'bus-inbox', 'writer.lock'), 0, { anchorPath: a.root, exactPrivateStorage: true });
  expect(lock).not.toBeNull();
  try { expect(appendBusInbox(message('blocked'), a).status).toBe('retryable'); }
  finally { releaseLocalStoreLock(lock); }
  let accepted = 1;
  for (let i = 0; i < 30; i++) {
    const result = appendBusInbox({ ...message(`large-${i}`), body: 'f'.repeat(60000) }, a);
    if (result.status === 'full') break;
    expect(result.status).toBe('posted'); accepted++;
  }
  expect(accepted).toBeLessThan(30);
  expect(listBusInboxAfter(0, 100, a)).toMatchObject({ nextCursor: accepted });
}, 60_000);

it('refuses permissive storage and nonregular store paths', () => {
  const a = setup(); appendBusInbox(message(), a);
  const file = join(a.root, 'bus-inbox', 'messages.json');
  if (process.platform !== 'win32') {
    chmodSync(file, 0o644);
    expect(listBusInboxAfter(0, 50, a).status).toBe('unavailable');
    expect(appendBusInbox(message('other'), a).status).toBe('unavailable');
  }
  rmSync(file); mkdirSync(file);
  expect(listBusInboxAfter(0, 50, a).status).toBe('unavailable');
}, 60_000);
it('fails closed on a leftover exclusive temporary without changing history', () => {
  const a = setup(); expect(appendBusInbox(message(), a).status).toBe('posted');
  writeFileSync(join(a.root, 'bus-inbox', '.pending'), 'fake interrupted write', { mode: 0o600 });
  expect(appendBusInbox(message('next'), a).status).toBe('unavailable');
  expect(listBusInboxAfter(0, 50, a)).toMatchObject({ nextCursor: 1 });
}, 60_000);
