import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { main } from '../examples/bus-consumer-restart.js';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'bus-restart-recipe-'));
  roots.push(root);
  return root;
}
function post(root: string, id: string, to: string, ttl = 10_000): void {
  expect(appendBusInbox({ id, from: 'fake-sender', to, priority: 'P2', ttl, body: { id } },
    { root, now: () => 100 }).status).toBe('posted');
}
function cursor(root: string): number {
  return (JSON.parse(readFileSync(join(root, 'consumer-checkpoint.json'), 'utf8')) as { scanCursor: number }).scanCursor;
}

it('retries a failed handler after restart and reaches addressed and broadcast messages beyond irrelevant pages', async () => {
  const root = workspace();
  post(root, 'first', 'worker');
  post(root, 'irrelevant-1', 'other');
  post(root, 'irrelevant-2', 'other');
  post(root, 'expired', 'worker', 10);
  post(root, 'retry', 'worker');
  post(root, 'broadcast', '*');
  post(root, 'last', 'worker');
  const args = ['--workspace', root, '--to', 'worker', '--limit', '2'];
  const handled: string[] = [], lines: string[] = [], errors: string[] = [];
  const base = { now: () => 200, write: (line: string) => { lines.push(line); }, error: (line: string) => { errors.push(line); } };
  expect(await main(args, { ...base, handle: receipt => {
    handled.push(receipt.envelope.id);
    if (receipt.envelope.id === 'retry') throw new Error('private application detail');
  } })).toBe(1);
  expect(handled).toEqual(['first', 'retry']);
  expect(lines.map(line => (JSON.parse(line) as BusInboxReceipt).envelope.id)).toEqual(['first']);
  expect(errors).toEqual(['{"status":"handler-failed"}\n']);
  expect(cursor(root)).toBe(2);

  // A new invocation opens the real checkpoint and retries the failed receipt.
  const resumed: string[] = [];
  expect(await main(args, { ...base, handle: receipt => { resumed.push(receipt.envelope.id); } })).toBe(0);
  expect(resumed).toEqual(['retry', 'broadcast', 'last']);
  expect(lines.map(line => (JSON.parse(line) as BusInboxReceipt).envelope.id)).toEqual(['first', 'retry', 'broadcast', 'last']);
  expect(lines.every(line => line.endsWith('\n') && line.split('\n').length === 2)).toBe(true);
  expect(cursor(root)).toBe(7);
  expect(await main(args, { ...base, handle: receipt => { resumed.push(receipt.envelope.id); } })).toBe(0);
  expect(resumed).toEqual(['retry', 'broadcast', 'last']);
  post(root, 'later', 'worker');
  expect(await main(args, { ...base, handle: receipt => { resumed.push(receipt.envelope.id); } })).toBe(0);
  expect(resumed).toEqual(['retry', 'broadcast', 'last', 'later']);
}, 60_000);

it('respects the page bound and resumes beyond a page with no matches', async () => {
  const root = workspace();
  post(root, 'other-1', 'other');
  post(root, 'other-2', 'other');
  post(root, 'hit', '*');
  const args = ['--workspace', root, '--to', 'worker', '--limit', '2', '--max-pages', '1'];
  const ids: string[] = [];
  const deps = { now: () => 100, write: () => {}, handle: (row: BusInboxReceipt) => { ids.push(row.envelope.id); } };
  expect(await main(args, deps)).toBe(0);
  expect(ids).toEqual([]);
  expect(cursor(root)).toBe(2);
  expect(await main(args, deps)).toBe(0);
  expect(ids).toEqual(['hit']);
  expect(cursor(root)).toBe(3);
}, 60_000);

it('does not checkpoint failed output and rejects invalid, missing, unsafe, or mismatched inputs', async () => {
  const root = workspace();
  const errors: string[] = [];
  const error = (line: string) => { errors.push(line); };
  const args = ['--workspace', root, '--to', 'worker'];
  expect(await main([], { error })).toBe(2);
  expect(await main(['--workspace', 'relative', '--to', 'worker'], { error })).toBe(2);
  expect(await main(args, { error })).toBe(3);
  const unsafe = join(root, 'unsafe');
  mkdirSync(unsafe, { mode: 0o755 });
  if (process.platform !== 'win32') expect(await main(['--workspace', unsafe, '--to', 'worker'], { error })).toBe(3);
  post(root, 'first', 'worker');
  const handled: string[] = [];
  expect(await main(args, { error, now: () => 100, handle: row => { handled.push(row.envelope.id); }, write: () => { throw new Error('closed'); } })).toBe(1);
  expect(await main(args, { error, now: () => 100, handle: row => { handled.push(row.envelope.id); }, write: () => {} })).toBe(0);
  expect(handled).toEqual(['first', 'first']);
  expect(cursor(root)).toBe(1);
  expect(await main(['--workspace', root, '--to', 'different'], { error })).toBe(3);
  expect(cursor(root)).toBe(1);
}, 60_000);
