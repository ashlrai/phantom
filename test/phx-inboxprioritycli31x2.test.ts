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
  const root = await mkdtemp(join(tmpdir(), 'fake-inbox-priority-'));
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
  return { command, log, run };
}

const heading = (minute: string, source: string, priority: string, text: string) =>
  `## 2026-10-31 00:${minute} ET (Fake operator, ${source}) PRIORITY ${priority}\n${text}\n`;

it('intersects priority, source and after before selecting the newest matches in file order', async () => {
  const { run } = await setup([
    heading('12', 'Mobile', 'P0', 'too early'),
    heading('14', 'Mobile', 'P0', 'first match'),
    heading('15', 'desktop', 'P0', 'other source'),
    heading('16', 'MOBILE', 'P0', 'second match'),
    heading('17', 'mobile', 'P0', 'last match'),
    heading('18', 'mobile', 'P1', 'other priority'),
    heading('19', 'mobile', 'P2', 'another priority'),
    '## Undated note\nno priority\n',
  ].join(''));
  expect(await run('read', '--priority', 'P0', '--source', 'mObIlE', '--limit', '2', '--after', '2026-10-31T04:13:00Z', '--json')).toEqual({
    code: 0, body: { sourceState: 'healthy', omittedUndated: 1, entries: [
      { at: '2026-10-31 00:16', source: 'MOBILE', priority: 'P0', text: 'second match' },
      { at: '2026-10-31 00:17', source: 'mobile', priority: 'P0', text: 'last match' },
    ] },
  });
  expect((await run('read', '--priority', 'P0')).body.entries.map((entry: { text: string }) => entry.text))
    .toEqual(['too early', 'first match', 'other source', 'second match', 'last match']);
});

it('filters all supported priorities exactly, excludes null and handles empty selections', async () => {
  const { run } = await setup([
    ...['P0', 'P1', 'P2', 'P3'].map((priority, i) => heading(`0${i}`, 'mobile', priority, `message ${priority}`)),
    heading('04', 'mobile', 'p0', 'lowercase'),
    '## No priority\nunclassified\n',
  ].join(''));
  for (const priority of ['P0', 'P1', 'P2', 'P3']) {
    const result = await run('read', '--priority', priority);
    expect(result.code).toBe(0);
    expect(result.body.entries.map((entry: { text: string }) => entry.text)).toEqual([`message ${priority}`]);
  }
  expect(await run('read', '--priority', 'P3', '--source', 'desktop')).toEqual({
    code: 0, body: { sourceState: 'healthy', entries: [] },
  });
});

it('searches the bounded reader tail beyond the default reader limit', async () => {
  const { run } = await setup([
    heading('00', 'mobile', 'P0', 'older urgent message'),
    ...Array.from({ length: 55 }, (_, i) => heading('01', 'desktop', 'P1', `other message ${i}`)),
  ].join(''));
  expect(await run('read', '--priority', 'P0')).toEqual({
    code: 0, body: { sourceState: 'healthy', entries: [
      { at: '2026-10-31 00:00', source: 'mobile', priority: 'P0', text: 'older urgent message' },
    ] },
  });
});

it('rejects invalid, missing, repeated and post priority flags', async () => {
  const { run } = await setup();
  for (const args of [
    ['read', '--priority'], ['read', '--priority', '--json'], ['read', '--priority', ''],
    ['read', '--priority', 'p0'], ['read', '--priority', 'P4'], ['read', '--priority', 'P01'],
    ['read', '--priority', 'P0', '--priority', 'P1'], ['read', '--source', '--priority', 'P0'],
    ['post', '--file', '-', '--priority', 'P0'], ['post', '--priority', 'P0', '--file', '-'],
  ]) expect(await run(...args)).toEqual({ code: 2, body: { status: 'invalid' } });
  expect(await run('read', '--priority', 'P0')).toEqual({ code: 0, body: { sourceState: 'missing', entries: [] } });
});

it('documents priority and persistent default receipts in help', async () => {
  const { command, log } = await setup();
  expect(await command(['read', '--help'])).toBe(0);
  const help = String(log.mock.calls.at(-1)?.[0]);
  expect(help).toContain('--priority <P0|P1|P2|P3>');
  expect(help).toContain('Default duplicate receipts persist across receiver restarts');
  expect(help).not.toContain('process lifetime');
});
