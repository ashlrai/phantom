import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetNeedsTriage } from '../src/cli/fleet-needs-triage.js';
import { readNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

let dir: string, root: string, path: string, fixture: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'needs-triage-'));
  root = join(dir, 'bus'); path = join(dir, 'NEEDS-MASON.md');
  fixture = '# Needs Mason\n- Release v3.30.1 is waiting on Merge Gate\n- unpark RQ-FOO-1\n- unpark RQ-FOO-2\n- Approve the $40/mo plan\n- send the LinkedIn reply to Jane\n';
  writeFileSync(path, fixture);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const output = () => JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string);

it('dry runs without writing and applies only auto items once', async () => {
  const args = ['--runs-dir', dir, '--json'], deps = { bus: { root } };
  expect(await cmdFleetNeedsTriage(args, deps)).toBe(0);
  expect(output()).toMatchObject({ v: 1, applied: false });
  expect(output().auto).toHaveLength(3); expect(output().hardLimit).toHaveLength(2);
  expect(readFileSync(path, 'utf8')).toBe(fixture);
  expect(readdirSync(dir)).toEqual(['NEEDS-MASON.md']);
  expect(await cmdFleetNeedsTriage([...args, '--apply'], deps)).toBe(0);
  expect(output().counts).toEqual({ ok: 3, duplicate: 0, failed: 0 });
  const applied = readFileSync(path, 'utf8');
  expect(applied.match(/^- \[x\] resolved /gm)).toHaveLength(3);
  expect(await cmdFleetNeedsTriage([...args, '--apply'], deps)).toBe(0);
  expect(output().counts).toEqual({ ok: 0, duplicate: 0, failed: 0 });
  expect(readFileSync(path, 'utf8')).toBe(applied);
  expect(readNeedsMason({ runsDir: dir }).items.map(item => item.text)).toEqual(['Approve the $40/mo plan', 'send the LinkedIn reply to Jane']);
  const bus = listBusInboxAfter(0, 50, { root });
  expect(bus.status).toBe('ok');
  if (bus.status === 'ok') {
    expect(bus.messages).toHaveLength(3);
    for (const message of bus.messages) expect(message.envelope.body).toMatchObject({ source: 'leader', reply: 'auto-resolved: outside the four hard limits (t1637u)' });
  }
});
it('rejects invalid flags and reports unavailable files', async () => {
  for (const args of [['--bad'], ['--apply', '--apply'], ['--runs-dir'], ['--json', '--json']]) expect(await cmdFleetNeedsTriage(args)).toBe(2);
  expect(await cmdFleetNeedsTriage(['--help'])).toBe(0);
  expect(await cmdFleetNeedsTriage(['--json'], { read: () => ({ status: 'unavailable', items: [] }) })).toBe(1);
  expect(output()).toMatchObject({ applied: false, status: 'unavailable' });
});
it('counts failed and duplicate resolutions without touching hard limits', async () => {
  const resolve = vi.fn().mockReturnValueOnce({ ok: true, duplicate: true }).mockReturnValueOnce({ ok: false, code: 'unavailable' }).mockImplementationOnce(() => { throw new Error('fake'); });
  expect(await cmdFleetNeedsTriage(['--runs-dir', dir, '--apply', '--json'], { resolve })).toBe(1);
  expect(output().counts).toEqual({ ok: 0, duplicate: 1, failed: 2 });
  expect(resolve).toHaveBeenCalledTimes(3);
});
