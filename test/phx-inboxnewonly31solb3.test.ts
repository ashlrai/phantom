import { EventEmitter } from 'node:events';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { formatInboxEntry } from '../src/core/fleet/mason-inbox.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const when = new Date('2026-10-31T04:14:00Z');
const entry = (text: string, source = 'Mobile') => formatInboxEntry(text, source, when);

async function setup(initial: string, steps: Array<(path: string, leader: string) => Promise<void>>) {
  const root = await mkdtemp(join(tmpdir(), 'inbox-new-only-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const leader = join(runsDir, 'leader');
  const path = join(leader, 'MASON-INBOX.md');
  await mkdir(leader, { recursive: true });
  await writeFile(path, initial);
  let step = 0;
  const wait = vi.fn(async () => { await steps[step++]!(path, leader); });
  const signals = new EventEmitter();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const command = createCommsInboxCommand({ runsDir, signals, wait });
  const samples = () => log.mock.calls.map(call => JSON.parse(String(call[0])));
  return { command, samples, signals, wait };
}

it('emits the initial filtered selection and only new occurrences, including identical records', async () => {
  const same = entry('match instruction');
  const ctx = await setup(same + entry('match other source', 'Desktop') + entry('different text'), [
    async () => {},
    async path => { await appendFile(path, same + entry('match next') + entry('match desktop', 'Desktop')); },
    async () => {},
  ]);
  expect(await ctx.command(['read', '--new-only', '--watch', '--max-samples', '4', '--source', 'mobile', '--contains', 'MATCH', '--priority', 'P0', '--after', '2026-10-31T04:13:00Z', '--before', '2026-10-31T04:15:00Z', '--limit', '10'])).toBe(0);
  const samples = ctx.samples();
  expect(samples.map(sample => sample.entries.map((item: { text: string }) => item.text))).toEqual([
    ['match instruction'], [], ['match instruction', 'match next'], [],
  ]);
  expect(samples.every(sample => sample.sourceState === 'healthy' && sample.omittedUndated === 0 &&
    sample.observation.bounded && !sample.observation.selectionReduced && !sample.observation.recovered)).toBe(true);
  expect(ctx.wait).toHaveBeenCalledTimes(3);
  expect(ctx.signals.listenerCount('SIGINT')).toBe(0);
});

it('retains seen records through missing and degraded reads and signals each recovery', async () => {
  const ctx = await setup(entry('first'), [
    async path => { await rename(path, `${path}.saved`); },
    async path => { await rename(`${path}.saved`, path); await appendFile(path, entry('second')); },
    async (_path, leader) => { await rename(leader, `${leader}.saved`); await writeFile(leader, 'not a directory'); },
    async (_path, leader) => { await rm(leader); await rename(`${leader}.saved`, leader); },
  ]);
  expect(await ctx.command(['read', '--watch', '--new-only', '--max-samples', '5'])).toBe(0);
  const samples = ctx.samples();
  expect(samples.map(sample => sample.sourceState)).toEqual(['healthy', 'missing', 'healthy', 'degraded', 'healthy']);
  expect(samples.map(sample => sample.entries.map((item: { text: string }) => item.text))).toEqual([
    ['first'], [], ['second'], [], [],
  ]);
  expect(samples.map(sample => sample.observation.recovered)).toEqual([false, false, true, false, true]);
  expect(samples.every(sample => !sample.observation.selectionReduced)).toBe(true);
});

it('signals selection loss on bounded-tail rotation while emitting visible additions', async () => {
  const old = entry('old selected');
  const padding = Array.from({ length: 70 }, (_, i) => entry(`filler ${i} ${'x'.repeat(4000)}`, 'Desktop')).join('');
  const ctx = await setup(old, [async path => { await appendFile(path, padding + entry('new selected')); }]);
  expect(await ctx.command(['read', '--watch', '--new-only', '--source', 'mobile', '--max-samples', '2'])).toBe(0);
  const samples = ctx.samples();
  expect(samples.map(sample => sample.entries.map((item: { text: string }) => item.text))).toEqual([['old selected'], ['new selected']]);
  expect(samples[1].observation).toEqual({ bounded: true, selectionReduced: true, recovered: false });
});

it('signals limit rotation and keeps bounded uncertainty when identical records replace each other', async () => {
  const same = entry('same');
  const ctx = await setup(same, [
    async path => { await appendFile(path, entry('other')); },
    async path => { await appendFile(path, same); },
    async path => { await appendFile(path, same); },
  ]);
  expect(await ctx.command(['read', '--watch', '--new-only', '--limit', '1', '--max-samples', '4'])).toBe(0);
  const samples = ctx.samples();
  expect(samples.map(sample => sample.entries.map((item: { text: string }) => item.text))).toEqual([['same'], ['other'], ['same'], []]);
  expect(samples.map(sample => sample.observation.selectionReduced)).toEqual([false, true, true, false]);
  expect(samples.every(sample => sample.observation.bounded)).toBe(true);
});

it('rejects invalid combinations and returns failure if the last sample is degraded', async () => {
  const ctx = await setup('', [async (_path, leader) => {
    await rm(leader, { recursive: true }); await writeFile(leader, 'not a directory');
  }]);
  for (const args of [
    ['read', '--new-only'], ['read', '--watch', '--new-only', '--new-only'],
    ['read', '--watch', '--source', '--new-only'], ['read', '--watch', '--contains', '--new-only'],
    ['post', '--file', '-', '--new-only'],
  ]) {
    expect(await ctx.command(args)).toBe(2);
    expect(ctx.samples().at(-1)).toEqual({ status: 'invalid' });
  }
  expect(await ctx.command(['read', '--watch', '--new-only', '--max-samples', '2'])).toBe(1);
  expect(ctx.samples().at(-1)).toMatchObject({ sourceState: 'degraded', entries: [], observation: { bounded: true } });
});
