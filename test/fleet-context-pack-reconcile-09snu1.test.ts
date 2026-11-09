import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { cmdFleetContextPack } from '../src/cli/fleet-context-pack.js';
import { packTokens } from '../src/core/fleet/context-pack.js';

let root: string;
const now = 1793577600000;
const opts = () => ({ root: join(root, 'bus'), runsDir: root, now: () => now });
const args = ['build', '--job', 'JOB-1', '--lane', 'claude', '--json'];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctxpack-'));
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50, lanes: { claude: { running: 1, target: 2, queued: 0, held: true, held_reason: 'fixture hold' } } }));
  await writeFile(join(root, 'queue/dispatch-events.log'), '2026-11-01 00:00:00 MERGED job=old\n');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function post(id: string, body: object) {
  expect(appendBusInbox({ id, from: 'core', to: 'claude', priority: 'P0', ttl: 60000, body }, opts()).status).toBe('posted');
}
it('builds a source-linked local pack, scrubs it and records metadata only', async () => {
  post('parent', { text: 'ancestor' });
  post('reply', { inReplyTo: 'parent', job: 'JOB-1', password: 'fixture-password', text: 'reply' });
  post('child', { inReplyTo: 'reply', text: 'child' });
  post('other', { job: 'JOB-10', text: 'unrelated' });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetContextPack(args, opts())).toBe(0);
  const json = output.mock.calls[0]![0] as string;
  const pack = JSON.parse(json);
  expect(pack.schema).toBe('fleet.ctxpack.v1');
  expect(json).toContain('ancestor'); expect(json).toContain('child');
  expect(json).toContain('fixture hold'); expect(json).toContain('job=old');
  expect(json).not.toContain('unrelated'); expect(json).not.toContain('fixture-password');
  const log = await readFile(join(root, 'queue/dispatch-events.log'), 'utf8');
  expect(log).toContain(`CTXPACK job=JOB-1 lane=claude pack_tokens=${packTokens(json)}`);
  expect(log).not.toContain('ancestor'); expect(log).not.toContain('fixture-password');
});
it('honors UTF-8 byte budgets and rejects invalid arguments before access', async () => {
  post('large', { job: 'JOB-1', text: '世界'.repeat(2000) });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetContextPack([...args, '--max-tokens', '256'], opts())).toBe(0);
  expect(packTokens(output.mock.calls[0]![0])).toBeLessThanOrEqual(256);
  const before = await readFile(join(root, 'queue/dispatch-events.log'), 'utf8');
  expect(await cmdFleetContextPack([...args, '--max-tokens', '9999'], opts())).not.toBe(0);
  expect(await cmdFleetContextPack(['build', '--job', '../bad', '--lane', 'claude'], opts())).not.toBe(0);
  expect(await readFile(join(root, 'queue/dispatch-events.log'), 'utf8')).toBe(before);
});
it('fails actionably when a required source is missing', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetContextPack(args, opts())).toBe(1);
  expect(error.mock.calls[0]![0]).toMatch(/Bus missing or unreadable/);
});
