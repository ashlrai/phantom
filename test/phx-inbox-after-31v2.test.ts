import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup(markdown?: string) {
  const root = await mkdtemp(join(tmpdir(), 'fake-inbox-after-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  if (markdown !== undefined) {
    await mkdir(join(runsDir, 'leader'), { recursive: true });
    await writeFile(join(runsDir, 'leader', 'MASON-INBOX.md'), markdown);
  }
  const command = createCommsInboxCommand({ runsDir });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const run = async (...args: string[]) => ({
    code: await command(args), body: JSON.parse(String(log.mock.calls.at(-1)?.[0])),
  });
  return { runsDir, run };
}

const heading = (at: string, source: string, text: string) =>
  `## ${at} ET (Fake operator, ${source}) PRIORITY P1\n${text}\n`;

it('compares equivalent zoned instants strictly before intersecting source and limit', async () => {
  const { run } = await setup([
    heading('2026-10-31 00:12', 'Mobile', 'older'),
    heading('2026-10-31 00:13', 'Mobile', 'equal'),
    heading('2026-10-31 00:14', 'Mobile', 'first matching'),
    heading('2026-10-31 00:15', 'desktop', 'other source'),
    heading('2026-10-31 00:16', 'MOBILE', 'second matching'),
    heading('2026-10-31 00:16', 'mobile', 'last matching'),
  ].join(''));
  const expected = { code: 0, body: { sourceState: 'healthy', omittedUndated: 0, entries: [
    { at: '2026-10-31 00:16', source: 'MOBILE', priority: 'P1', text: 'second matching' },
    { at: '2026-10-31 00:16', source: 'mobile', priority: 'P1', text: 'last matching' },
  ] } };
  for (const after of ['2026-10-31T04:13:00Z', '2026-10-31T00:13:00-04:00', '2026-10-31T09:43:00+05:30']) {
    expect(await run('read', '--after', after, '--source', 'mObIlE', '--limit', '2')).toEqual(expected);
  }
  expect((await run('read', '--after', '2026-10-31T04:13:00Z')).body.entries.map((e: { text: string }) => e.text))
    .toEqual(['first matching', 'other source', 'second matching', 'last matching']);
});

it('counts undated entries across sources only with a filter and keeps default behavior', async () => {
  const { run } = await setup([
    heading('2026-01-02 00:04', 'mobile', 'winter'),
    heading('2026-03-08 02:30', 'desktop', 'nonexistent'),
    heading('2026-11-01 01:30', 'mobile', 'ambiguous'),
    heading('2026-02-30 12:00', 'desktop', 'invalid calendar'),
    '## Undated note\nno date\n',
  ].join(''));
  const plain = await run('read');
  expect(plain.code).toBe(0);
  expect(plain.body.entries).toHaveLength(5);
  expect(plain.body).not.toHaveProperty('omittedUndated');
  expect(await run('read', '--after', '2026-01-02T05:03:59Z', '--source', 'mobile')).toEqual({
    code: 0, body: { sourceState: 'healthy', omittedUndated: 4, entries: [
      { at: '2026-01-02 00:04', source: 'mobile', priority: 'P1', text: 'winter' },
    ] },
  });
});

it('compares zoned entry timestamps and fractional seconds without losing precision', async () => {
  const { run } = await setup([
    heading('2026-10-31T04:13:00.00000000000001Z', 'mobile', 'same instant'),
    heading('2026-10-31T00:13:00.00000000000002-04:00', 'mobile', 'later instant'),
  ].join(''));
  const result = await run('read', '--after', '2026-10-31T04:13:00.00000000000001Z');
  expect(result.body.omittedUndated).toBe(0);
  expect(result.body.entries.map((e: { text: string }) => e.text)).toEqual(['later instant']);
});

it('rejects malformed, duplicated, missing and post-only timestamps', async () => {
  const { run } = await setup();
  for (const args of [
    ['read', '--after'], ['read', '--after', '--json'], ['read', '--after', '2026-10-31'],
    ['read', '--after', '2026-10-31T04:13:00'], ['read', '--after', '2026-02-30T04:13:00Z'],
    ['read', '--after', '2026-13-01T04:13:00Z'], ['read', '--after', '2026-01-01T24:00:00Z'],
    ['read', '--after', '2026-01-01T00:00:00+24:00'], ['read', '--after', '2026-01-01T00:00:00-00:00'],
    ['read', '--after', '2026-01-01T00:00:00Z', '--after', '2026-01-02T00:00:00Z'],
    ['post', '--file', 'fake', '--after', '2026-01-01T00:00:00Z'],
  ]) expect(await run(...args)).toEqual({ code: 2, body: { status: 'invalid' } });
});

it('preserves missing and degraded source states and exit codes with the filter', async () => {
  const { runsDir, run } = await setup();
  const args = ['read', '--after', '2026-10-31T04:13:00Z'];
  expect(await run(...args)).toEqual({ code: 0, body: { sourceState: 'missing', entries: [], omittedUndated: 0 } });
  await mkdir(runsDir);
  await writeFile(join(runsDir, 'leader'), 'fake non-directory');
  expect(await run(...args)).toEqual({ code: 1, body: { sourceState: 'degraded', entries: [], omittedUndated: 0 } });
});
