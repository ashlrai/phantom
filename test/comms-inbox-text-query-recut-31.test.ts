import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommsInboxCommand } from '../src/cli/comms-inbox.js';
import { appendInboxEntry, formatInboxEntry, readInboxEntries } from '../src/core/fleet/mason-inbox.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fake-inbox-text-query-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const command = createCommsInboxCommand({ runsDir });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const run = async (...args: string[]) => {
    const code = await command(args);
    return { code, body: JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
  };
  const texts = (body: { entries: Array<{ text: string }> }) => body.entries.map(entry => entry.text);
  return { root, runsDir, run, texts };
}

it('finds a prior order across desktop, mobile and cli sources in one command, case-insensitively', async () => {
  const { runsDir, run, texts } = await setup();
  const now = () => new Date('2026-10-31T04:13:00Z');
  for (const [source, text] of [
    ['desktop', 'Mason Oct 31 order: one shared channel-agnostic context'],
    ['mobile', 'Follow-up on the shared channel-agnostic context order'],
    ['cli', 'Re: shared channel-agnostic context order - proceed'],
    ['email', 'unrelated newsletter'],
  ]) expect((await appendInboxEntry(text!, { runsDir, source, now })).ok).toBe(true);
  const result = await run('read', '--contains', 'SHARED CHANNEL-AGNOSTIC', '--json');
  expect(result.code).toBe(0);
  expect(result.body.sourceState).toBe('healthy');
  expect(result.body.entries.map((entry: { source: string }) => entry.source)).toEqual(['desktop', 'mobile', 'cli']);
  expect(texts(result.body)).toEqual([
    'Mason Oct 31 order: one shared channel-agnostic context',
    'Follow-up on the shared channel-agnostic context order',
    'Re: shared channel-agnostic context order - proceed',
  ]);
});

it('matches unicode and treats regex metacharacters literally', async () => {
  const { runsDir, run, texts } = await setup();
  const now = () => new Date('2026-10-31T04:13:00Z');
  for (const text of [
    'fake note (P0).* pinned',
    'fake note (p0)zzz pinned',
    'Mason: resume ÜBERPRÜFUNG 界文字 done',
  ]) expect((await appendInboxEntry(text, { runsDir, source: 'cli', now })).ok).toBe(true);
  // A regex `(p0).*` would also match "(p0)zzz"; the literal needle must not.
  expect(texts((await run('read', '--contains', '(p0).*')).body))
    .toEqual(['fake note (P0).* pinned']);
  expect(texts((await run('read', '--contains', 'überprüfung 界文字')).body))
    .toEqual(['Mason: resume ÜBERPRÜFUNG 界文字 done']);
});

it('combines with the source filter and applies the limit to the newest matches, oldest first', async () => {
  const { runsDir, run, texts } = await setup();
  const now = () => new Date('2026-10-31T04:13:00Z');
  for (const [source, text] of [
    ['mobile', 'fake order 1'], ['desktop', 'fake order 2'], ['mobile', 'fake order 3'],
    ['mobile', 'other note'], ['desktop', 'fake order 4'], ['mobile', 'fake order 5'],
  ]) expect((await appendInboxEntry(text!, { runsDir, source, now })).ok).toBe(true);
  expect(texts((await run('read', '--contains', 'fake order', '--source', 'mobile')).body))
    .toEqual(['fake order 1', 'fake order 3', 'fake order 5']);
  expect(texts((await run('read', '--contains', 'fake order', '--source', 'mobile', '--limit', '1')).body))
    .toEqual(['fake order 5']);
  expect(texts((await run('read', '--contains', 'fake order', '--limit', '2')).body))
    .toEqual(['fake order 4', 'fake order 5']);
});

it('returns an empty healthy result for no match and preserves missing and degraded health', async () => {
  const { runsDir, run } = await setup();
  expect(await run('read', '--contains', 'absent needle')).toEqual({ code: 0, body: { sourceState: 'missing', entries: [] } });
  const now = () => new Date('2026-10-31T04:13:00Z');
  expect((await appendInboxEntry('fake entry', { runsDir, source: 'cli', now })).ok).toBe(true);
  expect(await run('read', '--contains', 'absent needle')).toEqual({ code: 0, body: { sourceState: 'healthy', entries: [] } });
  await rm(join(runsDir, 'leader'), { recursive: true, force: true });
  await writeFile(join(runsDir, 'leader'), 'fake non-directory');
  expect(await run('read', '--contains', 'absent needle')).toEqual({ code: 1, body: { sourceState: 'degraded', entries: [] } });
});

it('searches only the bounded read tail, like source queries', async () => {
  const { runsDir, run } = await setup();
  const inboxPath = join(runsDir, 'leader', 'MASON-INBOX.md');
  const when = new Date('2026-10-31T04:13:00Z');
  const needle = formatInboxEntry('fake ancient order', 'cli', when);
  // Enough newer non-matching entries to push the needle beyond the 256 KiB read window.
  const pad = 'x'.repeat(4000);
  const filler = Array.from({ length: 70 }, (_, i) => formatInboxEntry(`fake filler ${i} ${pad}`, 'mobile', when)).join('');
  await mkdir(join(runsDir, 'leader'), { recursive: true });
  await writeFile(inboxPath, needle + filler);
  expect((await readInboxEntries({ runsDir, limit: Number.MAX_SAFE_INTEGER })).entries.length).toBeGreaterThan(0);
  expect(await run('read', '--contains', 'fake ancient order')).toEqual({ code: 0, body: { sourceState: 'healthy', entries: [] } });
  const newest = (await run('read', '--limit', '1')).body.entries;
  expect(newest).toHaveLength(1);
  expect(newest[0].text).toContain('fake filler 69');
});

it('rejects empty, whitespace, duplicate, missing and post-only contains values without mutation', async () => {
  const { root, runsDir, run } = await setup();
  const file = join(root, 'fake-message.txt');
  await writeFile(file, 'fake message');
  for (const args of [
    ['read', '--contains'], ['read', '--contains', '--json'], ['read', '--contains', '--source'],
    ['read', '--contains', ''], ['read', '--contains', '   '], ['read', '--contains', '\t\n'],
    ['read', '--contains', 'a', '--contains', 'b'], ['read', '--contains', 'a', '--contains', 'a'],
    ['post', '--file', file, '--contains', 'x'], ['post', '--contains', 'x', '--file', file],
  ]) expect(await run(...args)).toEqual({ code: 2, body: { status: 'invalid' } });
  expect((await readInboxEntries({ runsDir })).sourceState).toBe('missing');
});
