import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetNeeds } from '../src/cli/fleet-needs.js';
import type { NeedsMasonReplyDeliveryReport } from '../src/core/fleet/needs-mason-relay.js';

const items = [{ id: 'nm-123456789abc', text: 'Review fake plan' }, { id: 'nm-abcdef123456', text: 'Choose fake color' }];
const emptyDeliveries: NeedsMasonReplyDeliveryReport = { status: 'ok', pending: [], unsafe: [], delivered: 0 };
let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => { out.push(message); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); });

it('prints each item and the count', async () => {
  expect(await cmdFleetNeeds([], { list: () => items, deliveries: () => emptyDeliveries })).toBe(0);
  expect(out).toEqual(['nm-123456789abc  Review fake plan\nnm-abcdef123456  Choose fake color\n2 item(s) need Mason.\nResolve: ashlr fleet needs-resolve <id> --reply "..."']);
});

it('reports an empty list', async () => {
  expect(await cmdFleetNeeds([], { list: () => [], deliveries: () => emptyDeliveries })).toBe(0);
  expect(out).toEqual(['Nothing needs Mason.']);
});

it('outputs the versioned JSON shape', async () => {
  expect(await cmdFleetNeeds(['--json'], { list: () => items, deliveries: () => emptyDeliveries })).toBe(0);
  expect(JSON.parse(out[0]!)).toEqual({ v: 1, status: 'available', count: 2, items, replyDeliveries: emptyDeliveries });
});

it('lists pending reply deliveries in JSON and text with the retry hint', async () => {
  const deliveries: NeedsMasonReplyDeliveryReport = {
    status: 'ok',
    pending: [{ itemId: 'nm-123456789abc', source: 'CLI', text: 'Review fake plan' }],
    unsafe: ['nm-ffffffffffff'],
    delivered: 2,
  };
  expect(await cmdFleetNeeds(['--json'], { list: () => [], deliveries: () => deliveries })).toBe(0);
  expect(JSON.parse(out[0]!).replyDeliveries).toEqual(deliveries);
  out = [];
  expect(await cmdFleetNeeds([], { list: () => [], deliveries: () => deliveries })).toBe(0);
  expect(out[0]).toContain('Nothing needs Mason.');
  expect(out[0]).toContain('1 needs-you answer(s) are not confirmed in the planner inbox:');
  expect(out[0]).toContain('nm-123456789abc  Review fake plan');
  expect(out[0]).toContain('Retry delivery: ashlr fleet needs-resolve <id>');
  expect(out[0]).toContain('1 delivery receipt(s) are unreadable');
});

it('reports unavailable reply deliveries without failing the list', async () => {
  const deliveries: NeedsMasonReplyDeliveryReport = { status: 'unavailable' };
  expect(await cmdFleetNeeds(['--json'], { list: () => items, deliveries: () => deliveries })).toBe(0);
  expect(JSON.parse(out[0]!).replyDeliveries).toEqual({ status: 'unavailable' });
  out = [];
  expect(await cmdFleetNeeds([], { list: () => items, deliveries: () => deliveries })).toBe(0);
  expect(out[0]).toContain('Reply delivery status unavailable.');
});

it('shows null ledger text honestly for a pending delivery', async () => {
  const deliveries: NeedsMasonReplyDeliveryReport = {
    status: 'ok', pending: [{ itemId: 'nm-123456789abc', source: 'Telegram', text: null }], unsafe: [], delivered: 0,
  };
  expect(await cmdFleetNeeds([], { list: () => [], deliveries: () => deliveries })).toBe(0);
  expect(out[0]).toContain('nm-123456789abc  (ledger text unknown)');
});

it('rejects bad and duplicate arguments and shows help', async () => {
  const list = vi.fn(() => items);
  const deliveries = vi.fn(() => emptyDeliveries);
  for (const args of [['--bad'], ['--json', '--json'], ['--runs-dir'], ['--runs-dir', '--json'], ['--runs-dir', 'a', '--runs-dir', 'b'], ['--help', '--json']]) {
    expect(await cmdFleetNeeds(args, { list, deliveries })).toBe(2);
  }
  expect(await cmdFleetNeeds(['-h'], { list, deliveries })).toBe(0);
  expect(list).not.toHaveBeenCalled();
  expect(deliveries).not.toHaveBeenCalled();
});

it('reports read errors without exposing their details', async () => {
  expect(await cmdFleetNeeds([], { list: () => { throw new Error('fake detail'); }, deliveries: () => emptyDeliveries })).toBe(1);
  expect(process.stderr.write).toHaveBeenCalledWith('error: fleet needs unavailable\n');
});

it('reads open items from the specified runs directory without modifying the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-needs-'));
  try {
    const resolved = 'Review fake old plan';
    const id = `nm-${createHash('sha256').update(resolved).digest('hex').slice(0, 12)}`;
    const fixture = `# Needs Mason\n- [ ] Review fake new plan\n- [ ] ${resolved}\n- [x] resolved ${id}\n`;
    const path = join(dir, 'NEEDS-MASON.md');
    await writeFile(path, fixture);
    expect(await cmdFleetNeeds(['--json', '--runs-dir', dir])).toBe(0);
    const openId = `nm-${createHash('sha256').update('Review fake new plan').digest('hex').slice(0, 12)}`;
    expect(JSON.parse(out[0]!)).toEqual({
      v: 1, status: 'available', count: 1, items: [{ id: openId, text: 'Review fake new plan' }],
      replyDeliveries: { status: 'ok', pending: [], unsafe: [], delivered: 0 },
    });
    expect(await readFile(path, 'utf8')).toBe(fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
