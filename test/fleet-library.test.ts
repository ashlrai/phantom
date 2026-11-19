/**
 * Library acceptance: files, media, shared context and agent memory in one
 * searchable list, through one reader that backs `phm library --json` and the
 * desktop API. Fixture stores and temp dirs only; never the real home.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdLibrary } from '../src/cli/library.js';
import {
  LIBRARY_ID, LIBRARY_KINDS, readAgentMemory, readLibrary, readLibraryItem, type LibraryDeps, type LibrarySources,
} from '../src/core/fleet/library.js';
import { appendSpecialistOutcome } from '../src/core/fleet/specialist-memory.js';
import { SPECIALIST_ROSTER_SCHEMA, saveSpecialistRoster, type Specialist } from '../src/core/fleet/roster.js';
import { createFleetLibraryFilesApi, VERSE_FLEET_LIBRARY_FILES_PATH } from '../src/core/verse/fleet-library-files-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const asOf = '2026-11-18T12:00:00.000Z';
const secret = 'ghp_' + 'librarysynthetic'.repeat(3);
let root: string, runsDir: string, rosterDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-library-'));
  runsDir = join(root, 'runs'); rosterDir = join(runsDir, 'queue', 'specialists');
  mkdirSync(rosterDir, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

const specialist = (id: string, callsign: string): Specialist => ({
  id, callsign, domain: 'web ui', allowedLanes: ['claude'], allowedModels: [], memoryPath: `memory/${id}.md`,
  currentJob: null, stats: { jobs: 0, merges: 0, reverts: 0, emptyRate: 0 },
});
async function seedAgentMemory(): Promise<void> {
  const ui = specialist('ui-lead', 'Pixel'), quiet = specialist('quiet', 'Quiet');
  await saveSpecialistRoster({ schema: SPECIALIST_ROSTER_SCHEMA, specialists: [ui, quiet] }, rosterDir);
  await appendSpecialistOutcome(ui, { job: 'RQ-1', outcome: 'merged', summary: 'Split tabs', at: '2026-11-18T10:00:00Z' }, rosterDir);
  await appendSpecialistOutcome(ui, { job: 'RQ-2', outcome: 'merged', summary: 'Keep one search box', pitfalls: ['Two search boxes confuse people'], at: '2026-11-18T11:00:00Z' }, rosterDir);
}

/** Fixture stores for every other source; agent memory reads the real temp roster. */
const stores: Omit<LibrarySources, 'agentMemory'> = {
  leaderFiles: async () => [{ name: 'VISION.md', size: 20, modifiedAt: '2026-11-18T11:30:00.000Z', preview: 'Ship safely' }],
  attachments: async () => ({ state: 'ok', items: [{ name: '0123456789abcdef.png', bytes: 16, type: 'image/png', modifiedAt: '2026-11-18T09:00:00.000Z' }] }),
  memory: async () => [{ id: 'fact-1', kind: 'fact', source: 'cos', updated: '2026-11-18T08:00:00.000Z', text: 'Use plain words' }],
  handoffs: async () => ({ state: 'complete', handoffs: [{ folder: 'review', name: 'NOTES.md', size: 10, modifiedAt: '2026-11-18T07:00:00.000Z', preview: 'Shared review notes' }] }),
  bus: () => ({ status: 'ok', messages: [], nextCursor: 0 }),
};
const deps = (): LibraryDeps => ({ runsDir, home: join(root, 'home'), now: () => new Date(asOf), sources: stores });

describe('agent memory', () => {
  it('lists each agent that has memory, newest outcome first in the preview, owned by the agent', async () => {
    await seedAgentMemory();
    const rows = await readAgentMemory(rosterDir);
    expect(rows.map(r => r.id)).toEqual(['ui-lead']);
    const [item] = (await readLibrary({ kind: 'memory', q: 'pixel' }, deps())).items;
    expect(item).toMatchObject({ kind: 'memory', title: 'Pixel memory', owner: 'Pixel', source: 'specialists/memory/ui-lead.md', size: rows[0]!.size });
    expect(item!.preview).toContain('Keep one search box');
    expect(item!.preview).not.toContain('Split tabs');
    expect(item!.preview).not.toMatch(/^[#>]/);
  });

  it('is empty, not unavailable, when no roster or memory folder exists', async () => {
    expect(await readAgentMemory(join(root, 'nowhere'))).toEqual([]);
    expect((await readLibrary({ kind: 'memory' }, deps())).unavailable).toEqual([]);
  });

  it('fails closed on a symlinked memory folder and names only the source', async () => {
    await saveSpecialistRoster({ schema: SPECIALIST_ROSTER_SCHEMA, specialists: [specialist('ui-lead', 'Pixel')] }, rosterDir);
    const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'ui-lead.md'), 'outside the roster');
    symlinkSync(elsewhere, join(rosterDir, 'memory'));
    await expect(readAgentMemory(rosterDir)).rejects.toThrow();
    const snapshot = await readLibrary({}, deps());
    expect(snapshot.unavailable).toEqual(['Agent memory']);
    expect(JSON.stringify(snapshot)).not.toContain('outside the roster');
    expect(snapshot.items.length).toBeGreaterThan(0);
  });

  it('redacts secret-shaped text the agent recorded', async () => {
    await saveSpecialistRoster({ schema: SPECIALIST_ROSTER_SCHEMA, specialists: [specialist('ui-lead', 'Pixel')] }, rosterDir);
    mkdirSync(join(rosterDir, 'memory'));
    writeFileSync(join(rosterDir, 'memory', 'ui-lead.md'), `\n## ${asOf} — note\n> token ${secret}\n`);
    const snapshot = await readLibrary({ kind: 'memory' }, deps());
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.items.find(i => i.owner === 'Pixel')?.preview).toContain('[REDACTED]');
  });
});

describe('one list of files, media, shared context and agent memory', () => {
  it('gives media its own kind so files and media filter separately', async () => {
    await seedAgentMemory();
    const all = await readLibrary({}, deps());
    expect(LIBRARY_KINDS).toEqual(['file', 'media', 'memory', 'message', 'context']);
    expect(all.items.map(i => `${i.kind}:${i.title}`)).toEqual([
      'file:Vision', 'memory:Pixel memory', 'media:Screenshot', 'memory:Use plain words', 'context:review: Notes',
    ]);
    expect((await readLibrary({ kind: 'file' }, deps())).items.map(i => i.title)).toEqual(['Vision']);
    expect((await readLibrary({ kind: 'media' }, deps())).items.map(i => i.title)).toEqual(['Screenshot']);
    for (const item of all.items) expect(item.id).toMatch(LIBRARY_ID);
  });

  it('searches every kind with one query and opens one item by id', async () => {
    await seedAgentMemory();
    expect((await readLibrary({ q: 'shared review' }, deps())).items.map(i => i.kind)).toEqual(['context']);
    expect((await readLibrary({ q: 'image/png' }, deps())).items.map(i => i.kind)).toEqual(['media']);
    const [memory] = (await readLibrary({ q: 'search box' }, deps())).items;
    expect((await readLibrary({ since: '90m' }, deps())).items.map(i => i.title)).toEqual(['Vision', 'Pixel memory']);
    expect((await readLibraryItem(memory!.id, deps())).item).toEqual(memory);
  });
});

describe('typed API and CLI share the same snapshot', () => {
  it('serves kind=media through the desktop route and phm library --json prints the same shape', async () => {
    await seedAgentMemory();
    const snapshot = await readLibrary({ kind: 'media' }, deps());
    const reader = vi.fn(async () => snapshot);
    let status = 0, text = '';
    const res = { writeHead(code: number) { status = code; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    const path = `${VERSE_FLEET_LIBRARY_FILES_PATH}/items`;
    const ctx = { token: 'library', allowDispatch: true, readSession: { expiresAt: Date.now() + 60_000 } } as VerseApiContext;
    await createFleetLibraryFilesApi({ readLibrary: reader, runsDir })(ctx,
      { url: `${path}?kind=media&q=png`, headers: { 'x-ashlr-token': 'library' } } as IncomingMessage, res, path, 'GET');
    expect(status).toBe(200);
    expect(reader).toHaveBeenCalledWith({ kind: 'media', since: undefined, q: 'png' }, expect.any(Object));
    expect(JSON.parse(text)).toEqual(snapshot);

    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdLibrary(['--json', '--kind', 'media'], { read: reader })).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toEqual(snapshot);
    expect(await cmdLibrary(['--kind', 'pictures'], { read: reader })).toBe(2);
  });

  it('prints agent memory in plain words with its owner', async () => {
    await seedAgentMemory();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdLibrary(['--kind', 'memory', '--q', 'pixel'], { read: filter => readLibrary(filter, deps()) })).toBe(0);
    expect(String(output.mock.calls[0]![0])).toContain('Pixel memory (memory)\n  specialists/memory/ui-lead.md · by Pixel');
  });
});
