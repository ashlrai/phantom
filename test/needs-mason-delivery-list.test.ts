import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listNeedsMasonDeliveries, writeDelivery } from '../src/core/fleet/needs-mason-reply-delivery.js';
import { readNeedsMasonReplyDeliveries, resolveNeedsMasonWithInbox } from '../src/core/fleet/needs-mason-relay.js';
import { listNeedsMason, type NeedsMasonOptions } from '../src/core/fleet/needs-mason-resolve.js';

let root: string;
let options: NeedsMasonOptions;
let itemId: string;
const now = () => 1_800_000_000_000;
const stateDir = () => join(root, 'needs-mason-delivery');
const pending = (id: string, source = 'CLI') =>
  writeDelivery(root, id, { status: 'pending', message: `Re needs-you ${id}: hi`, source, cursor: 0, duplicate: false });
const delivered = (id: string) =>
  writeDelivery(root, id, { status: 'delivered', message: '', source: 'CLI', cursor: 0, duplicate: false });
const failing = () => async () => ({ ok: false as const, reason: 'write-failed' as const });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-delivery-list-'));
  writeFileSync(join(root, 'NEEDS-MASON.md'), '# Needs Mason\n- [ ] Pick a fake color\n');
  options = { runsDir: root, bus: { root: join(root, 'fake-bus'), now }, now };
  itemId = listNeedsMason(options)[0]!.id;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('reports a missing delivery directory as a verified-empty ok list', () => {
  expect(listNeedsMasonDeliveries(root)).toEqual({ status: 'ok', pending: [], unsafe: [], delivered: 0 });
  expect(readNeedsMasonReplyDeliveries(options)).toEqual({ status: 'ok', pending: [], unsafe: [], delivered: 0 });
});

it('lists a pending receipt with its source and resolved ledger text', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox: failing() });
  expect(listNeedsMasonDeliveries(root)).toEqual({
    status: 'ok', pending: [{ itemId, source: 'Phantom desktop' }], unsafe: [], delivered: 0,
  });
  expect(readNeedsMasonReplyDeliveries(options)).toEqual({
    status: 'ok',
    pending: [{ itemId, source: 'Phantom desktop', text: 'Pick a fake color' }],
    unsafe: [], delivered: 0,
  });
});

it('keeps delivered receipts out of pending and counts them', () => {
  pending('nm-aaaaaaaaaaaa');
  delivered('nm-bbbbbbbbbbbb');
  delivered('nm-cccccccccccc');
  expect(listNeedsMasonDeliveries(root)).toEqual({
    status: 'ok', pending: [{ itemId: 'nm-aaaaaaaaaaaa', source: 'CLI' }], unsafe: [], delivered: 2,
  });
});

it('names unsafe receipts by item id without reading their contents', () => {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), 'nm-dddddddddddd.json'), '{not json');
  writeFileSync(join(stateDir(), 'nm-eeeeeeeeeeee.json'), JSON.stringify({ status: 'pending' }));
  writeFileSync(join(stateDir(), 'unrelated.txt'), 'ignored');
  expect(listNeedsMasonDeliveries(root)).toEqual({
    status: 'ok', pending: [], unsafe: ['nm-dddddddddddd', 'nm-eeeeeeeeeeee'], delivered: 0,
  });
});

it('reports an unreadable or non-directory state dir as unavailable', () => {
  writeFileSync(join(root, 'needs-mason-delivery'), 'not a dir');
  expect(listNeedsMasonDeliveries(root)).toEqual({ status: 'unavailable' });
  expect(readNeedsMasonReplyDeliveries(options)).toEqual({ status: 'unavailable' });
});

it('reports a symlinked state dir as unavailable', () => {
  const target = mkdtempSync(join(tmpdir(), 'fake-delivery-target-'));
  try {
    symlinkSync(target, stateDir(), 'dir');
    expect(listNeedsMasonDeliveries(root)).toEqual({ status: 'unavailable' });
  } finally { rmSync(target, { recursive: true, force: true }); }
});

it('leaves pending text null when the ledger or the item is unknown', async () => {
  await resolveNeedsMasonWithInbox({ itemId, reply: 'Use fake blue' }, { ...options, appendInbox: failing() });
  rmSync(join(root, 'NEEDS-MASON.md'));
  expect(readNeedsMasonReplyDeliveries(options)).toEqual({
    status: 'ok', pending: [{ itemId, source: 'Phantom desktop', text: null }], unsafe: [], delivered: 0,
  });
});
