import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { appendInboxEntry, readInboxEntries } from '../src/core/fleet/mason-inbox.js';
import { projectInboxRead } from '../src/core/verse/fleet-inbox-read.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fake-inbox-query-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const command = createCommsInboxCommand({ runsDir });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const run = async (...args: string[]) => {
    const code = await command(args);
    return { code, body: JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
  };
  return { root, runsDir, run };
}

it('selects exact case-insensitive sources before limiting, in projection order', async () => {
  const { runsDir, run } = await setup();
  const now = () => new Date('2026-10-31T04:13:00Z');
  for (const [source, text] of [
    ['Mobile', 'old mobile'], ['mobile-extra', 'other channel'], ['MOBILE', 'middle mobile'],
    ['desktop', 'desktop message'], ['mobile', 'new mobile'], ['--mobile', 'dash label'],
  ]) expect((await appendInboxEntry(text!, { runsDir, source, now })).ok).toBe(true);
  // More than the reader's default 20 rows must not hide matching older entries.
  for (let i = 0; i < 25; i++) expect((await appendInboxEntry(`desktop ${i}`, { runsDir, source: 'desktop', now })).ok).toBe(true);
  const raw = await readInboxEntries({ runsDir, limit: Number.MAX_SAFE_INTEGER });
  const expected = projectInboxRead(raw, { source: 'MoBiLe', limit: 2 })!;
  const result = await run('read', '--source', 'MoBiLe', '--limit', '2', '--json');
  expect(result).toEqual({ code: 0, body: { sourceState: 'healthy', entries: expected.entries } });
  expect(result.body.entries.map((entry: { text: string }) => entry.text)).toEqual(['middle mobile', 'new mobile']);
  expect((await run('read', '--source', 'mobile-extra')).body.entries.map((entry: { text: string }) => entry.text)).toEqual(['other channel']);
  expect((await run('read', '--source', '--mobile')).body.entries.map((entry: { text: string }) => entry.text)).toEqual(['dash label']);
  expect((await run('read', '--source', 'mobil')).body.entries).toEqual([]);
  const all = await run('read', '--limit', '3');
  expect(all.body.entries).toEqual(projectInboxRead(raw, { source: null, limit: 3 })!.entries);
});

it('honors the query default and both limit boundaries', async () => {
  const { runsDir, run } = await setup();
  const now = () => new Date('2026-10-31T04:13:00Z');
  for (let i = 0; i < 205; i++) expect((await appendInboxEntry(`message ${i}`, { runsDir, source: 'mobile', now })).ok).toBe(true);
  expect((await run('read', '--source', 'mobile')).body.entries).toHaveLength(50);
  expect((await run('read', '--source', 'mobile', '--limit', '1')).body.entries.map((entry: { text: string }) => entry.text)).toEqual(['message 204']);
  const max = (await run('read', '--source', 'mobile', '--limit', '200')).body.entries;
  expect(max).toHaveLength(200);
  expect(max[0].text).toBe('message 5');
  expect(max[199].text).toBe('message 204');
});

it('preserves default output and health for missing and degraded readers', async () => {
  const { runsDir, run } = await setup();
  expect(await run('read')).toEqual({ code: 0, body: await readInboxEntries({ runsDir }) });
  expect(await run('read', '--source', 'mobile')).toEqual({ code: 0, body: { sourceState: 'missing', entries: [] } });
  await mkdir(runsDir);
  await writeFile(join(runsDir, 'leader'), 'fake non-directory');
  expect(await run('read', '--limit', '1')).toEqual({ code: 1, body: { sourceState: 'degraded', entries: [] } });
  expect(await run('read', '--json')).toEqual({ code: 1, body: await readInboxEntries({ runsDir }) });
});

it('keeps the original unfiltered default and rejects malformed or post-only combinations without mutation', async () => {
  const { root, runsDir, run } = await setup();
  for (let i = 0; i < 25; i++) expect((await appendInboxEntry(`message ${i}`, { runsDir, source: 'mobile' })).ok).toBe(true);
  const inboxPath = join(runsDir, 'leader', 'MASON-INBOX.md');
  const eventPath = join(runsDir, 'dispatch-events.log');
  const beforeInbox = await readFile(inboxPath, 'utf8');
  const beforeEvents = await readFile(eventPath, 'utf8');
  const file = join(root, 'fake-message.txt');
  await writeFile(file, 'fake message');
  const original = await readInboxEntries({ runsDir });
  expect(original.entries).toHaveLength(20);
  expect(await run('read')).toEqual({ code: 0, body: original });
  expect(await run('read', '--json')).toEqual({ code: 0, body: original });
  for (const args of [
    ['read', '--source'], ['read', '--source', '--json'], ['read', '--source', ''],
    ['read', '--source', 'mobile', '--source', 'desktop'], ['read', '--source', 'bad/source'],
    ['read', '--source', 'x'.repeat(41)], ['read', '--limit'], ['read', '--limit', '--json'],
    ['read', '--limit', '1', '--limit', '2'], ['read', '--limit', '0'], ['read', '--limit', '201'],
    ['read', '--limit', '-1'], ['read', '--limit', '1.0'], ['read', '--limit', '1e2'],
    ['read', '--limit', '999999999999999999999'], ['read', '--json', '--json'],
    ['post', '--file', file, '--source', 'mobile'], ['post', '--file', file, '--limit', '1'],
  ]) expect(await run(...args)).toEqual({ code: 2, body: { status: 'invalid' } });
  expect(await readFile(inboxPath, 'utf8')).toBe(beforeInbox);
  expect(await readFile(eventPath, 'utf8')).toBe(beforeEvents);
});
