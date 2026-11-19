/** Library through the injectable reader: fixture stores only, no module mocks, no real home. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdLibrary } from '../src/cli/library.js';
import {
  LIBRARY_KINDS, LIBRARY_SCHEMA_VERSION, readLibrary, readLibraryItem, type LibraryDeps, type LibrarySources,
} from '../src/core/fleet/library.js';

const asOf = '2026-11-17T12:00:00.000Z';
const secret = 'ghp_' + 'fixture'.repeat(6);
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'library-fixtures-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

const empty: LibrarySources = {
  leaderFiles: async () => [],
  attachments: async () => ({ state: 'ok', items: [] }),
  memory: async () => [],
  handoffs: async () => ({ state: 'absent', handoffs: [] }),
  bus: () => ({ status: 'ok', messages: [], nextCursor: 0 }),
  agentMemory: async () => [],
};
const full: LibrarySources = {
  leaderFiles: async () => [{ name: 'VISION.md', size: 20, modifiedAt: '2026-11-17T11:00:00.000Z', preview: 'Ship safely' }],
  attachments: async () => ({ state: 'ok', items: [{ name: '0123456789abcdef.png', bytes: 16, type: 'image/png', modifiedAt: '2026-11-17T09:00:00.000Z' }] }),
  memory: async () => [{ id: 'fact-1', kind: 'fact', source: 'cos', updated: '2026-11-17T10:00:00.000Z', text: 'Use plain words' }],
  handoffs: async () => ({ state: 'complete', handoffs: [{ folder: 'review', name: 'NOTES.md', size: 10, modifiedAt: '2026-11-17T08:00:00.000Z', preview: 'Ready for review' }] }),
  bus: after => ({ status: 'ok', nextCursor: 7, messages: after ? [] : [{ cursor: 7, receivedAt: Date.parse(asOf),
    envelope: { id: 'msg-7', from: 'claude-3', to: 'leader', priority: 'P2', ttl: 1000, body: 'Reviewed context' } }] }),
  agentMemory: async () => [],
};
const deps = (sources: Partial<LibrarySources>): LibraryDeps => ({ runsDir: join(root, 'runs'), home: join(root, 'home'), now: () => new Date(asOf), sources });

describe('readLibrary with fixture sources', () => {
  it('reports an empty Library as empty, not unavailable', async () => {
    expect(await readLibrary({}, deps(empty))).toEqual({ v: LIBRARY_SCHEMA_VERSION, asOf, items: [], unavailable: [] });
  });

  it('keeps a stable versioned schema: exact snapshot and row keys, newest first', async () => {
    const snapshot = await readLibrary({}, deps(full));
    expect(Object.keys(snapshot).sort()).toEqual(['asOf', 'items', 'unavailable', 'v']);
    expect(snapshot.v).toBe(1);
    for (const item of snapshot.items) {
      expect(Object.keys(item).sort()).toEqual(['asOf', 'id', 'kind', 'owner', 'preview', 'size', 'source', 'title']);
      expect(item.id).toMatch(/^(file|media|memory|message|context):[0-9a-f]{16}$/);
    }
    expect(snapshot.items.map(i => i.asOf)).toEqual([...snapshot.items.map(i => i.asOf)].sort().reverse());
  });

  it.each([
    ['file', { title: 'Vision', source: 'leader/VISION.md', owner: 'leader', size: 20, preview: 'Ship safely' }],
    ['memory', { title: 'Use plain words', source: '~/.phantom/memory/fact-1.md', owner: 'cos', size: 15 }],
    ['message', { title: 'claude-3 → leader', source: 'bus', owner: 'claude-3', size: 16, preview: 'Reviewed context' }],
    ['context', { title: 'review: Notes', source: 'handoff/review/NOTES.md', owner: null, size: 10 }],
  ] as const)('projects the %s kind with owner and size (unknown stays null)', async (kind, expected) => {
    const rows = (await readLibrary({ kind }, deps(full))).items;
    expect(rows.every(row => row.kind === kind)).toBe(true);
    expect(rows[0]).toMatchObject(expected);
  });

  it('shows media with unknown owner and its byte size', async () => {
    const media = (await readLibrary({ kind: 'media' }, deps(full))).items.find(row => row.title === 'Screenshot');
    expect(media).toMatchObject({ owner: null, size: 16, source: 'inbox-attachments/0123456789abcdef.png' });
  });

  it('covers every kind', async () => {
    expect(new Set((await readLibrary({}, deps(full))).items.map(i => i.kind))).toEqual(new Set(LIBRARY_KINDS));
  });

  it('finds a search hit across title, source and preview, and returns nothing on a miss', async () => {
    expect((await readLibrary({ q: 'PLAIN words' }, deps(full))).items.map(i => i.kind)).toEqual(['memory']);
    expect((await readLibrary({ q: 'handoff/review' }, deps(full))).items.map(i => i.kind)).toEqual(['context']);
    expect((await readLibrary({ q: 'nothing like this' }, deps(full))).items).toEqual([]);
  });

  it('redacts secrets with the existing scrubber in every field, and search never matches the raw secret', async () => {
    const leaky: Partial<LibrarySources> = {
      ...full,
      memory: async () => [{ id: 'fact-2', kind: 'fact', source: `cos ${secret}`, updated: asOf, text: `Token is ${secret}` }],
    };
    const snapshot = await readLibrary({ kind: 'memory' }, deps(leaky));
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain(secret);
    expect(snapshot.items[0]!.preview).toContain('[REDACTED]');
    expect(snapshot.items[0]!.owner).toContain('[REDACTED]');
    expect((await readLibrary({ q: secret }, deps(leaky))).items).toEqual([]);
  });

  it('marks a failed source unavailable without leaking its error, and keeps the rest', async () => {
    const snapshot = await readLibrary({}, deps({ ...full, handoffs: async () => { throw new Error('private diagnostic'); } }));
    expect(snapshot.unavailable).toEqual(['Context']);
    expect(snapshot.items).toHaveLength(4);
    expect(JSON.stringify(snapshot)).not.toContain('private diagnostic');
  });
});

describe('readLibraryItem and phm library show', () => {
  it('returns one item by id, null for an unknown id, and refuses a malformed id', async () => {
    const [first] = (await readLibrary({ kind: 'memory' }, deps(full))).items;
    expect((await readLibraryItem(first!.id, deps(full))).item).toEqual(first);
    expect((await readLibraryItem('memory:0000000000000000', deps(full))).item).toBeNull();
    await expect(readLibraryItem('../etc/passwd', deps(full))).rejects.toThrow('Invalid Library id.');
  });

  it('prints one item as JSON or text, exits 1 when missing and 2 on a bad id', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readItem = (id: string) => readLibraryItem(id, deps(full));
    const [first] = (await readLibrary({ kind: 'message' }, deps(full))).items;
    expect(await cmdLibrary(['show', first!.id, '--json'], { readItem })).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual({ v: 1, asOf, item: first, unavailable: [] });
    expect(await cmdLibrary(['show', first!.id], { readItem })).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toContain('bus · by claude-3 · 2026-11-17T12:00:00.000Z · 16 bytes');
    expect(await cmdLibrary(['show', 'message:0000000000000000'], { readItem })).toBe(1);
    expect(log).toHaveBeenLastCalledWith('No Library item has that id.');
    for (const args of [['show'], ['show', 'nope'], ['show', first!.id, 'extra'], ['show', first!.id, '--json', '--json']]) {
      expect(await cmdLibrary(args, { readItem })).toBe(2);
    }
    expect(err).toHaveBeenCalled();
  });

  it('lists rows in text with unknown owner and size spelled out', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = () => readLibrary({ kind: 'context' }, deps({ ...full, handoffs: async () => ({ state: 'complete', handoffs: [
      { folder: 'review', name: 'NOTES.md', size: Number.NaN, modifiedAt: asOf, preview: 'Ready' }] }) }));
    expect(await cmdLibrary(['--kind', 'context'], { read })).toBe(0);
    expect(String(log.mock.calls[0]![0])).toContain('by unknown · 2026-11-17T12:00:00.000Z · size unknown');
  });
});
