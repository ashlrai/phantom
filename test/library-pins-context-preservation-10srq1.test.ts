import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { buildContextPack, packTokens } from '../src/core/fleet/context-pack.js';
import { addPin, libraryPinsPath, removePin } from '../src/core/fleet/library-pins.js';

let root: string;
const now = Date.UTC(2026, 10, 1);
const options = () => ({ root: join(root, 'bus'), home: root, runsDir: root, job: 'JOB-1', lane: 'claude', now: () => now });
const sections = (json: string) => (JSON.parse(json) as { sections: { name: string; rows: unknown[] }[] }).sections;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pin-context-'));
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({
    last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50,
    lanes: { claude: { running: 1, target: 2, queued: 0, held: true, held_reason: 'synthetic hold' } },
  }));
  await writeFile(join(root, 'queue', 'dispatch-events.log'), '2026-11-01 00:00:00 MERGED job=old\n');
  expect(appendBusInbox({ id: 'fixture', from: 'core', to: 'claude', priority: 'P0', ttl: 60000, body: { job: 'JOB-1', text: 'synthetic' } }, options()).status).toBe('posted');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('reads stored references once, never their contents, and reflects removal', async () => {
  const empty = sections(await buildContextPack(options()));
  expect(empty.map(section => section.name)).toEqual(['fleet', 'blockers', 'merges', 'threads']);
  const ref = join(root, 'reference.txt');
  await writeFile(ref, 'ordinary unique reference contents sentinel');
  const pin = addPin({ kind: 'file', title: 'Reference title', ref }, { home: root });
  const json = await buildContextPack(options());
  expect(sections(json).at(-1)).toEqual({ name: 'pinned-by-mason', rows: [{ kind: 'file', title: 'Reference title', ref }] });
  expect(json).not.toContain('ordinary unique reference contents sentinel');
  expect(removePin(pin.id, { home: root })).toBe(true);
  expect(sections(await buildContextPack(options())).map(section => section.name)).toEqual(empty.map(section => section.name));
});

it('keeps fleet context available for missing or damaged pin storage', async () => {
  const missing = sections(await buildContextPack(options()));
  await mkdir(join(root, '.phantom'));
  await writeFile(libraryPinsPath(root), '{damaged');
  expect(sections(await buildContextPack(options()))).toEqual(missing);
});

it('trims pins before fleet and blockers under a bounded budget', async () => {
  addPin({ kind: 'note', title: 'Large pin', ref: 'x'.repeat(500) }, { home: root });
  const full = sections(await buildContextPack(options()));
  expect(full.at(-1)?.name).toBe('pinned-by-mason');
  const json = await buildContextPack({ ...options(), maxTokens: 500 });
  expect(packTokens(json)).toBeLessThanOrEqual(500);
  const trimmed = sections(json);
  expect(trimmed.find(section => section.name === 'fleet')?.rows).toEqual(full.find(section => section.name === 'fleet')?.rows);
  expect(trimmed.find(section => section.name === 'blockers')?.rows).toEqual(full.find(section => section.name === 'blockers')?.rows);
  expect(trimmed.some(section => section.name === 'pinned-by-mason' && section.rows.length > 0)).toBe(false);
});
