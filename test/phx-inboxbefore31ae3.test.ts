import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const heading = (at: string, source: string, priority: string, text: string) =>
  `## ${at} ET (Fake operator, ${source}) PRIORITY ${priority}\n${text}\n`;

async function setup(markdown = '', stdin = Readable.from(['fake posted message'])) {
  const root = await mkdtemp(join(tmpdir(), 'fake-inbox-before-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  if (markdown) {
    await mkdir(join(runsDir, 'leader'), { recursive: true });
    await writeFile(join(runsDir, 'leader', 'MASON-INBOX.md'), markdown);
  }
  const command = createCommsInboxCommand({ runsDir, stdin });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const run = async (...args: string[]) => ({ code: await command(args), body: JSON.parse(String(log.mock.calls.at(-1)?.[0])) });
  return { command, log, run };
}

it('filters the bounded tail by interval, source and priority before selecting the newest matches', async () => {
  const { run } = await setup([
    heading('2026-10-31 00:12', 'mobile', 'P0', 'too early'),
    heading('2026-10-31 00:13', 'Mobile', 'P0', 'shared context'),
    heading('2026-10-31 00:14', 'mobile', 'P0', 'second match'),
    heading('2026-10-31 00:15', 'desktop', 'P0', 'other channel'),
    heading('2026-10-31 00:16', 'mobile', 'P1', 'other priority'),
    ...Array.from({ length: 55 }, (_, i) => heading('2026-10-31 00:20', 'mobile', 'P0', `later fake ${i}`)),
  ].join(''));
  const result = await run('read', '--before', '2026-10-31T04:17:00Z', '--after', '2026-10-31T04:12:00Z',
    '--source', 'MOBILE', '--priority', 'P0', '--limit', '2', '--json');
  expect(result).toEqual({ code: 0, body: { sourceState: 'healthy', omittedUndated: 0, entries: [
    { at: '2026-10-31 00:13', source: 'Mobile', priority: 'P0', text: 'shared context' },
    { at: '2026-10-31 00:14', source: 'mobile', priority: 'P0', text: 'second match' },
  ] } });
});

it('uses exclusive exact fractional instants and accepts equivalent offsets', async () => {
  const { run } = await setup([
    heading('2026-10-31T04:13:00.00000000000001Z', 'fake', 'P1', 'earlier'),
    heading('2026-10-31T00:13:00.00000000000002-04:00', 'fake', 'P1', 'equal'),
    heading('2026-10-31T04:13:00.00000000000003Z', 'fake', 'P1', 'later'),
  ].join(''));
  for (const before of ['2026-10-31T04:13:00.00000000000002Z', '2026-10-31T09:43:00.000000000000020+05:30']) {
    const result = await run('read', '--before', before);
    expect(result.body.omittedUndated).toBe(0);
    expect(result.body.entries.map((entry: { text: string }) => entry.text)).toEqual(['earlier']);
  }
  expect((await run('read', '--after', '2026-10-31T04:13:00.00000000000001Z',
    '--before', '2026-10-31T04:13:00.00000000000003Z')).body.entries.map((entry: { text: string }) => entry.text)).toEqual(['equal']);
});

it('counts undated, ambiguous and nonexistent local times across sources once for either bound', async () => {
  const { run } = await setup([
    heading('2026-01-02 00:04', 'mobile', 'P0', 'winter'),
    heading('2026-11-01 01:30', 'desktop', 'P1', 'ambiguous'),
    heading('2026-03-08 02:30', 'desktop', 'P1', 'nonexistent'),
    '## Fake undated note\nundated\n',
  ].join(''));
  for (const args of [
    ['--before', '2027-01-01T00:00:00Z'],
    ['--after', '2026-01-01T00:00:00Z', '--before', '2027-01-01T00:00:00Z'],
  ]) {
    const result = await run('read', ...args, '--source', 'mobile', '--priority', 'P0');
    expect(result.body.omittedUndated).toBe(3);
    expect(result.body.entries.map((entry: { text: string }) => entry.text)).toEqual(['winter']);
  }
  expect((await run('read')).body).not.toHaveProperty('omittedUndated');
});

it('normalizes bare read and json to the newest 50 in oldest-first file order', async () => {
  const { run } = await setup(Array.from({ length: 65 }, (_, i) =>
    heading('2026-10-31 00:13', 'fake', 'P1', `fake message ${i}`)).join(''));
  const bare = await run('read');
  expect(bare).toEqual(await run('read', '--limit', '50', '--json'));
  expect(bare).toEqual(await run('read', '--json'));
  expect(bare.body.entries).toHaveLength(50);
  expect(bare.body.entries[0].text).toBe('fake message 15');
  expect(bare.body.entries[49].text).toBe('fake message 64');
});

it('rejects invalid bounds, duplicates, flag values and reversed or equal intervals', async () => {
  const { run } = await setup();
  for (const args of [
    ['read', '--before'], ['read', '--before', '--json'], ['read', '--before', '2026-01-01'],
    ['read', '--before', '2026-02-30T00:00:00Z'], ['read', '--before', '2026-01-01T00:00:00-00:00'],
    ['read', '--before', '2026-01-01T00:00:00Z', '--before', '2026-01-02T00:00:00Z'],
    ['read', '--source', '--before', '2026-01-01T00:00:00Z'],
    ['read', '--after', '2026-01-01T00:00:00Z', '--before', '2025-12-31T19:00:00-05:00'],
    ['read', '--after', '2026-01-01T00:00:00.2Z', '--before', '2026-01-01T00:00:00.1Z'],
    ['post', '--file', '-', '--before', '2026-01-01T00:00:00Z'],
  ]) expect(await run(...args)).toEqual({ code: 2, body: { status: 'invalid' } });
});

it('preserves source health and documents before', async () => {
  const { command, log, run } = await setup();
  expect(await run('read', '--before', '2026-01-01T00:00:00Z')).toEqual({
    code: 0, body: { sourceState: 'missing', entries: [], omittedUndated: 0 },
  });
  expect(await command(['read', '--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--before <RFC3339-with-zone>');
});

it('continues to post through the existing receiver and read the result', async () => {
  const { run } = await setup();
  expect(await run('post', '--file', '-', '--json')).toEqual({
    code: 0, body: { ok: true, ack: { channel: 'cli', status: 'accepted', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/) } },
  });
  expect((await run('read')).body.entries).toMatchObject([{ source: 'cli', text: 'fake posted message' }]);
});
