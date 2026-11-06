import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../examples/upgrade/channel-receipt-upgrade-audit.js';
import { createChannelReceiver } from '../src/core/fleet/channel-envelope.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';

let root: string;
let scratch: string;
const output: string[] = [];
const actual = { createReceiver: createChannelReceiver, readInbox: readInboxEntries };
const write = (text: string): void => { output.push(text); };
const args = (): string[] => ['--phantom-dir', join(root, 'installed'), '--scratch-dir', scratch];
const result = (): Record<string, unknown> => JSON.parse(output.join('')) as Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fake-upgrade-audit-'));
  scratch = join(root, 'scratch');
  await mkdir(scratch);
  output.length = 0;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('installed channel receipt upgrade audit', () => {
  it('uses the real receiver and inbox reader across reconstruction', async () => {
    expect(await run(args(), { load: async () => actual, write })).toBe(0);
    expect(result()).toEqual({ schema: 'phantom.channel-receipt-upgrade-audit.v1', verified: true,
      accepted: 1, duplicate: 1, sameReceipt: true, inboxEntries: 1, firstSourceRetained: true });
    const inbox = await readInboxEntries({ runsDir: scratch });
    expect(inbox.sourceState).toBe('healthy');
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.entries[0]).toMatchObject({ source: 'desktop', text: 'Fake upgrade audit message; no real transport is involved.' });
  });

  it('keeps different senders separate in the same persistent store', async () => {
    const options = { runsDir: scratch, allowedSenderIds: new Set(['fake-alice', 'fake-bob']), now: () => new Date('2026-10-31T04:13:00Z') };
    const first = await createChannelReceiver(options)({ channel: 'desktop', verifiedSenderId: 'fake-alice', body: 'Fake same body.' });
    const retry = await createChannelReceiver(options)({ channel: 'mobile', verifiedSenderId: 'fake-alice', body: 'Fake same body.' });
    const other = await createChannelReceiver(options)({ channel: 'mobile', verifiedSenderId: 'fake-bob', body: 'Fake same body.' });
    expect(first.ok && first.ack.status).toBe('accepted');
    expect(retry.ok && retry.ack.status).toBe('duplicate');
    expect(first.ok && retry.ok && first.ack.dedupeKey === retry.ack.dedupeKey).toBe(true);
    expect(other.ok && other.ack.status).toBe('accepted');
    expect(first.ok && other.ok && first.ack.dedupeKey !== other.ack.dedupeKey).toBe(true);
    expect((await readInboxEntries({ runsDir: scratch })).entries.map(entry => entry.source)).toEqual(['mobile', 'desktop']);
  });

  it('refuses relative, missing, nonempty, and symlink scratch directories without touching them', async () => {
    const load = vi.fn(async () => actual);
    await writeFile(join(scratch, 'keep.txt'), 'fake user data');
    for (const path of ['relative', scratch, join(root, 'missing')]) {
      output.length = 0;
      expect(await run(['--phantom-dir', root, '--scratch-dir', path], { load, write })).toBe(2);
    }
    const empty = join(root, 'empty');
    await mkdir(empty);
    const link = join(root, 'link');
    await symlink(empty, link);
    expect(await run(['--phantom-dir', root, '--scratch-dir', link], { load, write })).toBe(2);
    expect(await readFile(join(scratch, 'keep.txt'), 'utf8')).toBe('fake user data');
    expect(load).not.toHaveBeenCalled();
  });

  it('reports mismatch, unavailable evidence, receiver failure and unexpected errors without leaking details', async () => {
    const missing = { ...actual, readInbox: async () => ({ sourceState: 'missing' as const, entries: [] }) };
    expect(await run(args(), { load: async () => missing, write })).toBe(3);
    output.length = 0;
    const next = join(root, 'next');
    await mkdir(next);
    scratch = next;
    const wrong = { ...actual, readInbox: async () => ({ sourceState: 'healthy' as const, entries: [] }) };
    expect(await run(args(), { load: async () => wrong, write })).toBe(1);
    expect(result()).toMatchObject({ verified: false, inboxEntries: 0 });
    output.length = 0;
    scratch = join(root, 'third');
    await mkdir(scratch);
    expect(await run(args(), { load: async () => { throw new Error('fake private path'); }, write })).toBe(3);
    expect(output.join('')).not.toContain('fake private path');
    output.length = 0;
    const broken = { ...actual, createReceiver: () => async () => ({ ok: false as const, reason: 'write-failed' as const }) };
    expect(await run(args(), { load: async () => broken, write })).toBe(1);
    output.length = 0;
    const throwing = { ...actual, createReceiver: () => { throw new Error('fake private path'); } };
    expect(await run(args(), { load: async () => throwing, write })).toBe(1);
    expect(output.join('')).not.toContain('fake private path');
  });

  it('loads actual reader modules through an installed-layout fixture and runs the guarded entrypoint', async () => {
    const modules = join(root, 'installed', 'dist', 'core', 'fleet');
    await mkdir(modules, { recursive: true });
    for (const file of ['channel-envelope', 'mason-inbox']) {
      const target = pathToFileURL(resolve(`src/core/fleet/${file}.ts`)).href;
      await writeFile(join(modules, `${file}.js`), `export * from ${JSON.stringify(target)};\n`);
    }
    await writeFile(join(root, 'installed', 'package.json'), '{"type":"module"}');
    const child = spawnSync(process.execPath, ['--import', 'tsx', resolve('examples/upgrade/channel-receipt-upgrade-audit.ts'), ...args()],
      { encoding: 'utf8', env: { HOME: root, PATH: process.env.PATH } });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ verified: true, accepted: 1, duplicate: 1 });
    expect((await readInboxEntries({ runsDir: scratch })).entries[0]?.source).toBe('desktop');
  });

  it('handles help and usage without loading adapters or writing scratch artifacts', async () => {
    const load = vi.fn(async () => actual);
    expect(await run(['--help'], { load, write })).toBe(0);
    expect(output.join('')).toContain('npx tsx examples/upgrade/channel-receipt-upgrade-audit.ts');
    output.length = 0;
    expect(await run(['--scratch-dir', scratch], { load, write })).toBe(2);
    expect(await run(['--phantom-dir', 'relative', '--scratch-dir', scratch], { load, write })).toBe(2);
    expect(load).not.toHaveBeenCalled();
    expect(await readInboxEntries({ runsDir: scratch })).toEqual({ sourceState: 'missing', entries: [] });
  });
});
