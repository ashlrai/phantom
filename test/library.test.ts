import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readLibrary, parseLibraryFilter, LIBRARY_KINDS } from '../src/core/fleet/library.js';
import { cmdLibrary } from '../src/cli/library.js';
import { listLeaderFiles } from '../src/core/fleet/library-files.js';
import { listMemory } from '../src/core/cos/memory.js';
import { readHandoffFiles } from '../src/core/fleet/handoff-files.js';
import { listLeaderAttachments } from '../src/core/verse/leader-attachment-list.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
vi.mock('node:fs/promises', () => ({ lstat: vi.fn(async () => ({ isDirectory: () => true })) }));
vi.mock('../src/core/fleet/library-files.js', () => ({ listLeaderFiles: vi.fn() }));
vi.mock('../src/core/cos/memory.js', () => ({ listMemory: vi.fn() }));
vi.mock('../src/core/fleet/handoff-files.js', () => ({ readHandoffFiles: vi.fn() }));
vi.mock('../src/core/verse/leader-attachment-list.js', () => ({ listLeaderAttachments: vi.fn() }));
vi.mock('../src/core/fleet/bus-inbox.js', () => ({ listBusInboxAfter: vi.fn(), BUS_INBOX_MAX_MESSAGES: 1024 }));
const asOf = '2026-11-17T12:00:00.000Z', now = () => new Date(asOf), deps = { now, sources: { agentMemory: async () => [] } };
const receipt = (cursor: number) => ({ cursor, receivedAt: now().getTime(), envelope: { id: `msg-${cursor}`, from: 'agent', to: 'leader', priority: 'P2' as const, ttl: 1000, body: 'Reviewed context' } });
beforeEach(() => {
  vi.mocked(listLeaderFiles).mockResolvedValue([{ name: 'VISION.md', size: 20, modifiedAt: asOf, preview: 'Ship safely' }]);
  vi.mocked(listMemory).mockResolvedValue([{ id: 'fact-1', kind: 'fact', source: 'cli', updated: '2026-11-17T10:00:00Z', text: 'Use plain words' }]);
  vi.mocked(readHandoffFiles).mockResolvedValue({ state: 'complete', handoffs: [{ folder: 'review', name: 'NOTES.md', size: 10, modifiedAt: asOf, preview: 'Ready for review' }] });
  vi.mocked(listLeaderAttachments).mockResolvedValue({ state: 'ok', items: [{ name: '0123456789abcdef.png', bytes: 16, type: 'image/png', modifiedAt: asOf }] });
  vi.mocked(listBusInboxAfter).mockReturnValue({ status: 'ok', messages: [receipt(4000)], nextCursor: 4000 });
});
afterEach(() => vi.restoreAllMocks());
it('projects each kind and media with stable identities, plain titles and newest-first source times', async () => {
  const result = await readLibrary({}, deps);
  expect(result.items.map(i => i.kind).sort()).toEqual(['context', 'file', 'media', 'memory', 'message']);
  expect(result.items.at(-1)?.title).toBe('Use plain words');
  expect(result.items.find(i => i.title === 'Vision')?.source).toBe('leader/VISION.md');
  expect(result).toEqual(await readLibrary({}, deps));
  expect(result.unavailable).toEqual([]);
});
it.each(LIBRARY_KINDS)('filters kind %s', async kind => {
  const rows = (await readLibrary({ kind }, deps)).items;
  expect(rows.length).toBeGreaterThan(0); expect(rows.every(i => i.kind === kind)).toBe(true);
});
it('applies since, case-insensitive terms, source matching and combined filters', async () => {
  expect((await readLibrary({ since: '1h' }, deps)).items).toHaveLength(4);
  expect((await readLibrary({ kind: 'file', since: '1h', q: 'VISION safely' }, deps)).items).toHaveLength(1);
  expect((await readLibrary({ q: 'absent' }, deps)).items).toEqual([]);
  for (const since of ['0h', '-1h', '1x', '1.5h']) expect(() => parseLibraryFilter({ since })).toThrow();
});
it('keeps good sources while reporting malformed and failed reads without diagnostic text', async () => {
  vi.mocked(listLeaderFiles).mockResolvedValue([{ name: 'bad', size: 1, modifiedAt: 'invalid', preview: 'bad' }]);
  vi.mocked(listMemory).mockRejectedValue(new Error('private diagnostic'));
  const result = await readLibrary({}, deps);
  expect(result.unavailable).toEqual(['Files', 'Memory']); expect(result.items).toHaveLength(3);
  expect(JSON.stringify(result)).not.toContain('private diagnostic');
});
it('scrubs complete secret-shaped source values before titles, previews, search and CLI JSON', async () => {
  const secret = 'ghp_' + 'synthetic'.repeat(6);
  vi.mocked(listMemory).mockResolvedValue([{ id: 'fact-1', kind: 'fact', source: 'cli', updated: asOf, text: `Saved ${secret}${String.fromCharCode(27)}` }]);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdLibrary(['--json', '--kind', 'memory'])).toBe(0);
  const json = String(output.mock.calls[0]![0]);
  expect(json).toContain('[REDACTED]'); expect(json).not.toContain(secret); expect(json).not.toContain('\\u001b');
  expect((await readLibrary({ q: secret }, deps)).items).toEqual([]);
});
it('pages across sparse cursors and excludes messages from outside channels', async () => {
  vi.mocked(listBusInboxAfter).mockReturnValueOnce({ status: 'ok', messages: Array.from({ length: 100 }, (_, i) => receipt(4000 + i)), nextCursor: 4099 })
    .mockReturnValueOnce({ status: 'ok', messages: [receipt(5000), { ...receipt(5001), envelope: { ...receipt(5001).envelope, channel: 'email', external: true } }], nextCursor: 5001 });
  expect((await readLibrary({ kind: 'message' }, deps)).items).toHaveLength(101);
  expect(listBusInboxAfter).toHaveBeenLastCalledWith(4099, 100, expect.any(Object));
});
