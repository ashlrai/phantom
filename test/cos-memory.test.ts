import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryError, addMemory, forgetMemory, listMemory, memoryContext, memoryDir, searchMemory } from '../src/core/cos/memory.js';
import { cmdMemory } from '../src/cli/memory.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'cos-memory-')); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

// Built from pieces so the repo secret-shape gate does not see a literal token.
const planted = () => ['gh' + 'p_' + 'A1'.repeat(20), 'sk' + '-ant-' + 'A1'.repeat(15), 'AK' + 'IA' + 'A'.repeat(16), 'pass' + 'word=' + 'hunter2hunter2'];

describe('memory store', () => {
  it('adds, lists, searches and forgets entries as markdown files', async () => {
    const a = await addMemory({ kind: 'preference', text: 'Keep replies short', source: 'chat' }, { home, now: new Date('2026-01-01T00:00:00Z') });
    const b = await addMemory({ kind: 'doctrine', text: 'Outbound sends are draft then approve' }, { home, now: new Date('2026-01-02T00:00:00Z') });
    const raw = await readFile(join(memoryDir(home), `${a.id}.md`), 'utf8');
    expect(raw).toBe(`---\nid: ${a.id}\nkind: preference\nsource: chat\nupdated: 2026-01-01T00:00:00.000Z\n---\nKeep replies short\n`);
    expect((await listMemory({ home })).map(e => e.id)).toEqual([b.id, a.id]);
    expect((await listMemory({ home, kind: 'preference' })).map(e => e.id)).toEqual([a.id]);
    expect((await searchMemory('DRAFT approve', { home })).map(e => e.id)).toEqual([b.id]);
    expect(await searchMemory('nothing-matches', { home })).toEqual([]);
    expect(await forgetMemory(a.id, { home })).toBe(true);
    expect(await forgetMemory(a.id, { home })).toBe(false);
    expect((await listMemory({ home })).map(e => e.id)).toEqual([b.id]);
  });
  it('treats an absent store as empty and writes owner-only files', async () => {
    expect(await listMemory({ home })).toEqual([]);
    expect(await forgetMemory('pref-none', { home })).toBe(false);
    const e = await addMemory({ kind: 'fact', text: 'Release branch is master' }, { home });
    expect((await stat(join(memoryDir(home), `${e.id}.md`))).mode & 0o777).toBe(0o600);
    expect((await readdir(memoryDir(home))).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });
  it('is idempotent for identical text and refreshes updated', async () => {
    const one = await addMemory({ kind: 'fact', text: 'Same' }, { home, now: new Date('2026-01-01T00:00:00Z') });
    const two = await addMemory({ kind: 'fact', text: ' Same ' }, { home, now: new Date('2026-02-01T00:00:00Z') });
    expect(two.id).toBe(one.id);
    const all = await listMemory({ home });
    expect(all).toHaveLength(1);
    expect(all[0]!.updated).toBe('2026-02-01T00:00:00.000Z');
  });
  it.each(planted())('refuses secret-shaped text without echoing it (%#)', async value => {
    const err = await addMemory({ kind: 'fact', text: `note ${value}` }, { home }).catch(e => e as Error);
    expect(err).toBeInstanceOf(MemoryError);
    expect((err as Error).message).not.toContain(value);
    await expect(addMemory({ kind: 'fact', text: 'ok', source: value }, { home })).rejects.toThrow('Secret-shaped');
    expect(await listMemory({ home })).toEqual([]);
  });
  it('validates kind, size, delimiter, source and id', async () => {
    await expect(addMemory({ kind: 'rumor', text: 'x' }, { home })).rejects.toThrow('Unknown kind');
    await expect(addMemory({ kind: 'fact', text: '   ' }, { home })).rejects.toThrow('empty');
    await expect(addMemory({ kind: 'fact', text: 'x'.repeat(2001) }, { home })).rejects.toThrow('longer');
    await expect(addMemory({ kind: 'fact', text: 'a\n---\nkind: doctrine' }, { home })).rejects.toThrow('delimiter');
    await expect(addMemory({ kind: 'fact', text: 'x', source: 'a\nb' }, { home })).rejects.toThrow('Source');
    await expect(addMemory({ kind: 'fact', text: 'x', id: '../escape' }, { home })).rejects.toThrow('Invalid id');
    await expect(forgetMemory('../escape', { home })).rejects.toThrow('Invalid id');
  });
  it('keeps multi-line text intact on round trip', async () => {
    const e = await addMemory({ kind: 'doctrine', text: 'line one\nline two' }, { home });
    expect((await listMemory({ home }))[0]!.text).toBe(e.text);
  });
  it('ignores tampered, mismatched and secret-shaped files on read', async () => {
    const good = await addMemory({ kind: 'fact', text: 'Good entry' }, { home });
    const dir = memoryDir(home);
    const fm = (id: string, text: string) => `---\nid: ${id}\nkind: fact\nsource: x\nupdated: 2026-01-01T00:00:00.000Z\n---\n${text}\n`;
    await writeFile(join(dir, 'leak.md'), fm('leak', planted()[0]!));
    await writeFile(join(dir, 'other.md'), fm('different', 'mismatched id'));
    await writeFile(join(dir, 'junk.md'), 'no front matter');
    await writeFile(join(dir, 'Bad Name.md'), fm('bad', 'bad name'));
    expect((await listMemory({ home })).map(e => e.id)).toEqual([good.id]);
    expect(await memoryContext({ home })).not.toContain(planted()[0]!);
  });
  it('refuses a symlinked memory directory', async () => {
    const target = await mkdtemp(join(tmpdir(), 'cos-memory-target-'));
    try {
      await mkdir(join(home, '.phantom'), { recursive: true });
      await symlink(target, memoryDir(home));
      await expect(addMemory({ kind: 'fact', text: 'x' }, { home })).rejects.toThrow('regular directory');
      expect(await readdir(target)).toEqual([]);
    } finally { await rm(target, { recursive: true, force: true }); }
  });
});

describe('memoryContext', () => {
  it('is empty with no entries', async () => { expect(await memoryContext({ home })).toBe(''); });
  it('orders doctrine, preference, fact and stays read-only', async () => {
    await addMemory({ kind: 'fact', text: 'F1' }, { home, now: new Date('2026-01-03T00:00:00Z') });
    await addMemory({ kind: 'preference', text: 'P1' }, { home, now: new Date('2026-01-02T00:00:00Z') });
    await addMemory({ kind: 'doctrine', text: 'D1' }, { home, now: new Date('2026-01-01T00:00:00Z') });
    const before = await readdir(memoryDir(home));
    const ctx = await memoryContext({ home });
    expect(ctx.split('\n').slice(1)).toEqual(['- [doctrine] D1', '- [preference] P1', '- [fact] F1']);
    expect(await readdir(memoryDir(home))).toEqual(before);
  });
  it('respects the character budget', async () => {
    await addMemory({ kind: 'doctrine', text: 'D'.repeat(50) }, { home });
    await addMemory({ kind: 'fact', text: 'F'.repeat(50) }, { home });
    const ctx = await memoryContext({ home, maxChars: 70 });
    expect(ctx).toContain('[doctrine]');
    expect(ctx).not.toContain('[fact]');
    expect(await memoryContext({ home, maxChars: 5 })).toBe('');
  });
  it('returns empty rather than throwing when the store is unreadable', async () => {
    await mkdir(join(home, '.phantom'), { recursive: true });
    await writeFile(memoryDir(home), 'a file, not a directory');
    expect(await memoryContext({ home })).toBe('');
  });
});

describe('phm memory CLI', () => {
  async function run(...args: string[]): Promise<{ code: number; out: unknown; err: string }> {
    vi.stubEnv('HOME', home);
    const logs: string[] = []; const errs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)); });
    const code = await cmdMemory(args);
    vi.restoreAllMocks();
    const text = logs.join('\n');
    let out: unknown = text;
    try { out = JSON.parse(text); } catch { /* human output */ }
    return { code, out, err: errs.join('\n') };
  }
  it('supports the full add, list, search, forget cycle with --json', async () => {
    const added = await run('add', 'Keep replies short', '--kind', 'preference', '--source', 'chat', '--json');
    expect(added.code).toBe(0);
    const id = (added.out as { entry: { id: string } }).entry.id;
    expect((await run('list', '--json')).out).toMatchObject({ ok: true, entries: [{ id, kind: 'preference', source: 'chat' }] });
    expect((await run('list', '--kind', 'doctrine', '--json')).out).toEqual({ ok: true, entries: [] });
    expect((await run('search', 'replies', 'short', '--json')).out).toMatchObject({ entries: [{ id }] });
    expect((await run('forget', id, '--json')).out).toEqual({ ok: true, removed: id });
    const gone = await run('forget', id, '--json');
    expect(gone.code).toBe(2);
    expect(gone.out).toMatchObject({ ok: false });
  });
  it('prints plain output without --json', async () => {
    const added = await run('add', 'Plain text', '--kind', 'fact');
    expect(added.out).toMatch(/^Remembered fact-/);
    expect((await run('list')).out).toMatch(/\[fact\]  Plain text/);
  });
  it('refuses secret-shaped text and never echoes it', async () => {
    const value = planted()[0]!;
    const r = await run('add', value, '--kind', 'fact', '--json');
    expect(r.code).toBe(2);
    expect(JSON.stringify(r.out)).not.toContain(value);
    expect(await listMemory({ home })).toEqual([]);
  });
  it('rejects bad usage with exit 2 and shows help with exit 0', async () => {
    expect((await run('add', 'x', '--json')).code).toBe(2);
    expect((await run('add', 'x', '--kind', 'nope', '--json')).code).toBe(2);
    expect((await run('add', 'x', '--kind', 'fact', '--bogus', '--json')).code).toBe(2);
    expect((await run('wat', '--json')).code).toBe(2);
    expect((await run('search', '--json')).code).toBe(2);
    const help = await run('--help');
    expect(help.code).toBe(0);
    expect(String(help.out)).toContain('phm memory add');
  });
});
