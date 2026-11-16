import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextPack } from '../src/cli/fleet-context-pack.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

let root: string;
const now = Date.UTC(2026, 10, 1);
const options = () => ({ root: join(root, 'bus'), runsDir: root, now: () => now });
const args = ['build', '--job', 'JOB-1', '--lane', 'claude', '--json'];
const logPath = () => join(root, 'queue', 'dispatch-events.log');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctx-preservation-'));
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({
    last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50,
    lanes: { claude: { running: 1, target: 2, queued: 0, held: true, held_reason: 'synthetic hold' } },
  }));
  await writeFile(logPath(), '2026-11-01 00:00:00 MERGED job=old\n');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function post(id: string, body: object): void {
  expect(appendBusInbox({ id, from: 'core', to: 'claude', priority: 'P0', ttl: 60000, body }, options()).status).toBe('posted');
}

it('selects the linked job thread, retains sources and logs only metadata', async () => {
  post('ancestor', { text: 'synthetic ancestor' });
  post('match', { inReplyTo: 'ancestor', job: 'JOB-1', password: 'violet umbrella', text: 'synthetic match' });
  post('descendant', { inReplyTo: 'match', text: 'synthetic descendant' });
  post('other', { job: 'JOB-10', text: 'synthetic unrelated' });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetContextPack(args, options())).toBe(0);
  const json = output.mock.calls[0]![0] as string;
  const pack = JSON.parse(json) as { schema: string; sections: { name: string; rows: Record<string, unknown>[] }[] };
  expect(pack.schema).toBe('fleet.ctxpack.v1');
  const threads = pack.sections.find(section => section.name === 'threads')!.rows;
  expect(threads.map(row => row.id)).toEqual(expect.arrayContaining(['ancestor', 'match', 'descendant']));
  expect(threads.map(row => row.id)).not.toContain('other');
  expect(threads.every(row => row.source === 'bus-inbox' && typeof row.cursor === 'number')).toBe(true);
  expect(json).toContain('synthetic hold');
  expect(pack.sections.find(section => section.name === 'merges')!.rows).toEqual([
    { source: logPath(), text: '2026-11-01 00:00:00 MERGED job=old' },
  ]);
  expect(json).toContain('[REDACTED]');
  expect(json).not.toContain('violet umbrella');
  const log = await readFile(logPath(), 'utf8');
  expect(log).toContain(`CTXPACK job=JOB-1 lane=claude pack_tokens=${Buffer.byteLength(json + '\n', 'utf8')}`);
  for (const text of ['synthetic ancestor', 'synthetic match', 'synthetic descendant', 'violet umbrella']) expect(log).not.toContain(text);
});

it('enforces a UTF-8 byte budget and rejects malformed arguments without logging', async () => {
  post('large', { job: 'JOB-1', text: '世界'.repeat(1000) });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetContextPack([...args, '--max-tokens', '256'], options())).toBe(0);
  const json = output.mock.calls[0]![0] as string;
  expect(Buffer.byteLength(json + '\n', 'utf8')).toBeLessThanOrEqual(256);
  const before = await readFile(logPath(), 'utf8');
  for (const invalid of [
    [...args, '--max-tokens', '9999'], [...args, '--merges', '-1'],
    ['build', '--job', '../bad', '--lane', 'claude'], [...args, '--unknown'],
    [...args, '--job', 'JOB-2'],
  ]) expect(await cmdFleetContextPack(invalid, options())).not.toBe(0);
  expect(await readFile(logPath(), 'utf8')).toBe(before);
});

it('fails actionably without bus storage and leaves dispatch history unchanged', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const before = await readFile(logPath(), 'utf8');
  expect(await cmdFleetContextPack(args, options())).toBe(1);
  expect(error.mock.calls[0]![0]).toMatch(/Bus missing or unreadable.*restore private bus storage/i);
  expect(await readFile(logPath(), 'utf8')).toBe(before);
});
