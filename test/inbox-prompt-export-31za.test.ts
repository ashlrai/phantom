import { describe, expect, it, vi } from 'vitest';
import { runInboxPromptExport } from '../examples/agents/inbox-prompt-export.js';
import { readInboxEntries, type InboxEntry } from '../src/core/fleet/mason-inbox.js';

type InboxRead = Awaited<ReturnType<typeof readInboxEntries>>;
const entry = (text: string, source: string, at = '2026-10-31 00:13', priority: string | null = 'P0'): InboxEntry =>
  ({ at, source, priority, text });

function setup(read: (limit: number) => Promise<InboxRead>) {
  const lines: string[] = [];
  const deps = { read: vi.fn(read), write: (text: string) => { lines.push(text); } };
  return { deps, lines, result: () => JSON.parse(lines[0]!) as Record<string, unknown> };
}

describe('inbox prompt export', () => {
  it('emits instructions from mixed channels oldest-first with health and dropped count', async () => {
    // The reader reports newest-first file order; the payload flips to oldest-first.
    const f = setup(async () => ({
      sourceState: 'healthy',
      entries: [
        entry('newest instruction', 'Telegram', '2026-10-31 00:15', 'P0'),
        entry('middle instruction', 'Phantom desktop', '2026-10-31 00:14', 'P1'),
        entry('oldest instruction', 'relayed by masbot', '2026-10-31 00:12', null),
      ],
    }));
    expect(await runInboxPromptExport([], f.deps)).toBe(0);
    expect(f.lines).toHaveLength(1);
    expect(f.result()).toEqual({
      v: 1,
      generatedAt: expect.any(String),
      sourceHealth: 'healthy',
      source: null,
      limit: 20,
      dropped: 0,
      instructions: [
        { source: 'relayed by masbot', at: '2026-10-31 00:12', priority: null, text: 'oldest instruction' },
        { source: 'Phantom desktop', at: '2026-10-31 00:14', priority: 'P1', text: 'middle instruction' },
        { source: 'Telegram', at: '2026-10-31 00:15', priority: 'P0', text: 'newest instruction' },
      ],
    });
    expect(f.deps.read).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);
  });

  it('keeps append order for timestamp ties instead of re-sorting local times', async () => {
    const f = setup(async () => ({
      sourceState: 'healthy',
      entries: [
        entry('appended fourth', 'Telegram'),
        entry('appended third', 'Phantom desktop'),
        entry('appended second', 'Telegram'),
        entry('appended first', 'Phantom desktop'),
      ],
    }));
    expect(await runInboxPromptExport([], f.deps)).toBe(0);
    expect((f.result().instructions as Array<{ text: string }>).map(item => item.text)).toEqual([
      'appended first', 'appended second', 'appended third', 'appended fourth',
    ]);
    expect((f.result().instructions as Array<{ at: string }>).every(item => item.at === '2026-10-31 00:13')).toBe(true);
  });

  it('applies the source filter before the limit on the full bounded tail', async () => {
    const read = vi.fn<(limit: number) => Promise<InboxRead>>().mockResolvedValue({
      sourceState: 'healthy',
      entries: [
        entry('newest matching', 'Telegram', '2026-10-31 00:15'),
        entry('newer other channel', 'Phantom desktop', '2026-10-31 00:14'),
        entry('middle matching', 'telegram', '2026-10-31 00:13'),
        entry('older matching', 'Telegram', '2026-10-31 00:12'),
      ],
    });
    const f = setup(read);
    expect(await runInboxPromptExport(['--source', 'Telegram', '--limit', '2'], f.deps)).toBe(0);
    expect(read).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);
    expect(f.result()).toMatchObject({ source: 'Telegram', limit: 2, dropped: 0 });
    // Limit selects the newest matching pair; interleaved other-channel rows are not counted.
    expect(f.result().instructions).toEqual([
      { source: 'telegram', at: '2026-10-31 00:13', priority: 'P0', text: 'middle matching' },
      { source: 'Telegram', at: '2026-10-31 00:15', priority: 'P0', text: 'newest matching' },
    ]);
  });

  it('reports degraded input through health and dropped counts without hiding rows', async () => {
    const f = setup(async () => ({ sourceState: 'degraded', entries: [] }));
    expect(await runInboxPromptExport([], f.deps)).toBe(1);
    expect(f.result()).toMatchObject({ v: 1, sourceHealth: 'degraded', dropped: 0, instructions: [] });
    f.lines.length = 0;
    const missing = setup(async () => ({ sourceState: 'missing', entries: [] }));
    expect(await runInboxPromptExport([], missing.deps)).toBe(0);
    expect(missing.result()).toMatchObject({ sourceHealth: 'missing', instructions: [] });
  });

  it('drops malformed or unsafe tail rows into the count, including non-matching sources', async () => {
    const f = setup(async () => ({
      sourceState: 'healthy',
      entries: [
        entry('safe matching', 'Telegram', '2026-10-31 00:15'),
        { at: '2026-10-31 00:14', source: 'Telegram', priority: 'P0', text: '/fake/private/path' },
        { at: '2026-10-31 00:13', source: 'Phantom desktop', priority: 3, text: 'bad priority' },
        'not an object',
      ] as unknown as InboxEntry[],
    }));
    expect(await runInboxPromptExport(['--source', 'Telegram'], f.deps)).toBe(0);
    expect(f.result()).toMatchObject({ dropped: 3 });
    expect(f.result().instructions).toEqual([
      { source: 'Telegram', at: '2026-10-31 00:15', priority: 'P0', text: 'safe matching' },
    ]);
    expect(f.lines[0]).not.toContain('/fake/private/path');
  });

  it('emits stable JSON errors without raw exception text on read failures', async () => {
    const f = setup(async () => { throw new Error('fake private detail'); });
    expect(await runInboxPromptExport([], f.deps)).toBe(1);
    expect(f.result()).toEqual({ v: 1, error: 'read-failed' });
    expect(f.lines[0]).not.toContain('fake private detail');
    f.lines.length = 0;
    const broken = setup(async () => ({ bogus: true }) as unknown as InboxRead);
    expect(await runInboxPromptExport([], broken.deps)).toBe(1);
    expect(broken.result()).toEqual({ v: 1, error: 'read-failed' });
  });

  it('rejects invalid arguments without reading the inbox', async () => {
    const f = setup(async () => ({ sourceState: 'healthy', entries: [] }));
    for (const args of [
      ['--limit', '0'], ['--limit', '201'], ['--limit', '1.5'], ['--limit', 'abc'], ['--limit'],
      ['--source', 'bad/source'], ['--source', 'x'.repeat(41)], ['--source', '--limit'],
      ['--limit', '2', '--limit', '3'], ['--bogus', 'x'], ['orphan'], ['--help', '--limit', '2'],
    ]) {
      expect(await runInboxPromptExport(args, f.deps)).toBe(2);
      expect(f.result()).toEqual({ v: 1, error: 'invalid-arguments' });
      f.lines.length = 0;
    }
    expect(f.deps.read).not.toHaveBeenCalled();
    expect(await runInboxPromptExport(['--help'], f.deps)).toBe(0);
    expect(f.lines[0]).toContain('--source');
    expect(f.deps.read).not.toHaveBeenCalled();
  });
});
