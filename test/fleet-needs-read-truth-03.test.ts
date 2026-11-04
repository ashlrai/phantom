import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetNeeds } from '../src/cli/fleet-needs.js';
import { listNeedsMason, readNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';

let dir: string;
let path: string;
let output: string[];
let errors: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'needs-truth-'));
  path = join(dir, 'NEEDS-MASON.md');
  output = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => { output.push(message); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { errors.push(String(chunk)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

async function check(status: string, items: Array<{ id: string; text: string }>, exit: number) {
  expect(readNeedsMason({ runsDir: dir })).toEqual({ status, items });
  expect(await cmdFleetNeeds(['--runs-dir', dir, '--json'])).toBe(exit);
  expect(JSON.parse(output.pop()!)).toEqual({ v: 1, status, count: items.length, items });
  expect(await cmdFleetNeeds(['--runs-dir', dir])).toBe(exit);
  if (status === 'unavailable') {
    expect(errors.pop()).toBe('error: fleet needs unavailable\n');
    expect(output.join(' ')).not.toContain('Nothing needs Mason');
    expect(listNeedsMason({ runsDir: dir })).toEqual([]);
  } else if (!items.length) expect(output.pop()).toBe('Nothing needs Mason.');
  else expect(output.pop()).toContain(`${items[0]!.id}  ${items[0]!.text}`);
}

it('distinguishes a missing ledger and an empty ledger', async () => {
  await check('missing', [], 0);
  writeFileSync(path, '');
  await check('available', [], 0);
});

it('returns stable ids and hides resolved markers', async () => {
  const text = 'Review a fake plan';
  const id = `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  writeFileSync(path, `- [ ] ${text}\n`);
  await check('available', [{ id, text }], 0);
  writeFileSync(path, `- [ ] ${text}\n- [x] resolved ${id}\n`);
  await check('available', [], 0);
});

it.each(['oversized', 'directory', 'symlink'])('reports %s as unavailable', async kind => {
  if (kind === 'oversized') writeFileSync(path, 'x'.repeat(32 * 1024 + 1));
  else if (kind === 'directory') mkdirSync(path);
  else {
    const target = join(dir, 'target');
    writeFileSync(target, '- [ ] Fake item\n');
    symlinkSync(target, path);
  }
  await check('unavailable', [], 1);
});
