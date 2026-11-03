import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetNeeds } from '../src/cli/fleet-needs.js';

const items = [{ id: 'nm-123456789abc', text: 'Review fake plan' }, { id: 'nm-abcdef123456', text: 'Choose fake color' }];
let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => { out.push(message); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); });

it('prints each item and the count', async () => {
  expect(await cmdFleetNeeds([], { list: () => items })).toBe(0);
  expect(out).toEqual(['nm-123456789abc  Review fake plan\nnm-abcdef123456  Choose fake color\n2 item(s) need Mason.']);
});

it('reports an empty list', async () => {
  expect(await cmdFleetNeeds([], { list: () => [] })).toBe(0);
  expect(out).toEqual(['Nothing needs Mason.']);
});

it('outputs the versioned JSON shape', async () => {
  expect(await cmdFleetNeeds(['--json'], { list: () => items })).toBe(0);
  expect(JSON.parse(out[0]!)).toEqual({ v: 1, count: 2, items });
});

it('rejects bad and duplicate arguments and shows help', async () => {
  const list = vi.fn(() => items);
  for (const args of [['--bad'], ['--json', '--json'], ['--runs-dir'], ['--runs-dir', '--json'], ['--runs-dir', 'a', '--runs-dir', 'b'], ['--help', '--json']]) {
    expect(await cmdFleetNeeds(args, { list })).toBe(2);
  }
  expect(await cmdFleetNeeds(['-h'], { list })).toBe(0);
  expect(list).not.toHaveBeenCalled();
});

it('reports read errors without exposing their details', async () => {
  expect(await cmdFleetNeeds([], { list: () => { throw new Error('fake detail'); } })).toBe(1);
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
    expect(JSON.parse(out[0]!)).toEqual({ v: 1, count: 1, items: [{ id: openId, text: 'Review fake new plan' }] });
    expect(await readFile(path, 'utf8')).toBe(fixture);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
