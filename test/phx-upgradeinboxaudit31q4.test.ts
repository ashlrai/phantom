import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../examples/upgrade/inbox-upgrade-audit.js';
import { readInboxEntries, type InboxEntry } from '../src/core/fleet/mason-inbox.js';
import { projectInboxRead } from '../src/core/verse/fleet-inbox-read.js';

const args = ['--limit', '10', '--all-sources'];
const body = 'FAKE PRIVATE instruction 雪';
const markdown = [
  '## 2026-10-31 00:12 ET (Fake, terminal) PRIORITY P1', 'legacy text',
  '## 2026-10-31 00:13 ET (Fake, Telegram) PRIORITY P0', body, 'second line 🐈',
  '## 2026-10-31 00:13 ET (Fake, Phantom desktop) PRIORITY P0', 'desktop instruction',
  '## 2026-10-31 00:13 ET (Fake, Telegram) PRIORITY P0', 'another instruction',
].join('\n');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function tempDir() { const dir = await mkdtemp(join(tmpdir(), 'fake-upgrade-inbox-')); dirs.push(dir); return dir; }
async function audit(argv: string[], deps: Parameters<typeof run>[1] = {}) {
  let output = '';
  const code = await run(argv, { ...deps, write: text => { output += text; } });
  return { code, output, json: JSON.parse(output) };
}

describe('inbox upgrade audit', () => {
  it('uses the actual reader and projection for bounded, filtered history with tied timestamps', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'leader'));
    await writeFile(join(dir, 'leader', 'MASON-INBOX.md'), markdown);
    const read = (limit: number) => readInboxEntries({ runsDir: dir, limit });
    const all = await audit(args, { read });
    expect(all.code).toBe(0);
    expect(all.json).toMatchObject({ v: 1, result: 'verified', health: { canonical: 'healthy', projection: 'healthy' },
      counts: { canonicalWindow: 4, canonicalSelected: 4, projected: 4, dropped: 0 },
      sources: { canonical: { telegram: 2, desktop: 1, terminal: 1 } },
      compatibility: { selection: true, health: true, orderAttributionAndContent: true } });
    const filtered = await audit(['--limit', '3', '--source', 'telegram'], { read });
    expect(filtered.code).toBe(0);
    expect(filtered.json).toMatchObject({ counts: { canonicalWindow: 3, canonicalSelected: 2, projected: 2 },
      sources: { projection: { telegram: 2, desktop: 0 } } });
    for (const output of [all.output, filtered.output]) {
      expect(output).not.toContain(body);
      expect(output).not.toContain('second line');
      expect(output).not.toContain('desktop instruction');
      expect(output).not.toContain('2026-10-31');
    }
  });

  it('reports missing and degraded actual reader paths as insufficient evidence', async () => {
    const dir = await tempDir();
    const read = (limit: number) => readInboxEntries({ runsDir: dir, limit });
    expect(await audit(args, { read })).toMatchObject({ code: 3, json: { health: { canonical: 'missing' } } });
    await writeFile(join(dir, 'leader'), 'fake non-directory');
    expect(await audit(args, { read })).toMatchObject({ code: 3, json: { health: { canonical: 'degraded' } } });
  });

  it('detects tied-entry reordering, changes in attribution and altered content without printing them', async () => {
    const entries: InboxEntry[] = [
      { at: 'same', source: 'Telegram', priority: 'P0', text: body },
      { at: 'same', source: 'Telegram', priority: 'P0', text: 'other fake instruction' },
    ];
    const read = async () => ({ sourceState: 'healthy' as const, entries });
    const reordered = await audit(args, { read, project: (raw, query) => {
      const wire = projectInboxRead(raw, query)!;
      wire.entries.reverse();
      return wire;
    } });
    expect(reordered).toMatchObject({ code: 1, json: { compatibility: { orderAttributionAndContent: false } } });
    expect(reordered.output).not.toContain(body);
    const attributed = await audit(args, { read, project: (raw, query) => {
      const wire = projectInboxRead(raw, query)!;
      wire.entries[0]!.source = 'Phantom desktop';
      return wire;
    } });
    expect(attributed.code).toBe(1);
    const changed = await audit(args, { read, project: (raw, query) => {
      const wire = projectInboxRead(raw, query)!;
      wire.entries[0]!.text = 'different';
      return wire;
    } });
    expect(changed.code).toBe(1);
  });

  it('detects rejected and scrubbed entries, including drops outside the selected source', async () => {
    const entries: InboxEntry[] = [
      { at: 'one', source: 'Telegram', priority: 'P0', text: 'safe fake text' },
      { at: 'two', source: 'Phantom desktop', priority: 'P0', text: '/fake/private/path' },
    ];
    const read = async () => ({ sourceState: 'healthy' as const, entries });
    const rejected = await audit(['--limit', '2', '--source', 'Telegram'], { read });
    expect(rejected).toMatchObject({ code: 1, json: { counts: { dropped: 1 } } });
    expect(rejected.output).not.toContain('/fake/private/path');
    entries[1]!.text = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    const scrubbed = await audit(args, { read });
    expect(scrubbed).toMatchObject({ code: 1, json: { compatibility: { orderAttributionAndContent: false } } });
    expect(scrubbed.output).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('detects altered projection health and selection without emitting arbitrary labels', async () => {
    const entries: InboxEntry[] = [{ at: 'same', source: 'fake private heading', priority: null, text: body }];
    const read = async () => ({ sourceState: 'healthy' as const, entries });
    const result = await audit(args, { read, project: (raw, query) => {
      const wire = projectInboxRead(raw, query)!;
      wire.sourceState = 'missing';
      wire.limit = 1;
      return wire;
    } });
    expect(result).toMatchObject({ code: 1, json: { sources: { canonical: { other: 1 } },
      compatibility: { health: false, selection: false } } });
    expect(result.output).not.toContain('fake private heading');
    expect(result.output).not.toContain(body);
  });

  it('handles empty selections, projection failures and thrown errors with static output', async () => {
    const empty = async () => ({ sourceState: 'healthy' as const, entries: [] });
    expect(await audit(args, { read: empty })).toMatchObject({ code: 3, json: { result: 'insufficient-evidence' } });
    expect(await audit(args, { read: empty, project: () => null })).toMatchObject({ code: 1, json: { error: 'Unable to audit inbox.' } });
    const failed = await audit(args, { read: async () => { throw new Error(body); } });
    expect(failed.code).toBe(1);
    expect(failed.output).not.toContain(body);
  });

  it('rejects invalid queries before reading and keeps help side-effect free', async () => {
    const read = vi.fn(async () => { throw new Error(body); });
    for (const argv of [[], ['--limit', '0', '--all-sources'], ['--limit', '201', '--all-sources'],
      ['--limit', '1', '--source', 'a/b'], ['--limit', '1', '--limit', '2', '--all-sources'],
      ['--limit', '1', '--source', 'Telegram', '--all-sources'], ['--limit', '1']]) {
      expect((await audit(argv, { read })).code).toBe(2);
    }
    let help = '';
    expect(await run(['--help'], { read, write: text => { help += text; } })).toBe(0);
    expect(help).toContain('Usage:');
    expect(read).not.toHaveBeenCalled();
  });
});
