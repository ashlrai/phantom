import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseDoneName, parseIngestedTsv, readDropJobFates } from '../src/core/fleet/drop-job-fate.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const dir = await mkdtemp(join(tmpdir(), 'drop-fate-')); roots.push(dir); return dir; }
const row = (id: string) => `2026-11-01 00:00:00\tRQ-PHX-${id}\tclaude\tcodex-personal\tmid\tFake\ttitle\n`;
it('parses tabs in titles, short rows and malformed lines', () => {
  const rows = parseIngestedTsv(row('ABC123') + '\n2026-11-01 00:00:00\tRQ-PHX-SHORT\ninvalid\n');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ id: 'RQ-PHX-ABC123', title: 'Fake\ttitle', lane: 'codex-personal' });
  expect(rows[1]).toMatchObject({ id: 'RQ-PHX-SHORT', lane: '', title: '' });
});
it('parses only safe done names', () => {
  expect(parseDoneName('RQ-PHX-ABC123.md.denied-path')).toEqual({ id: 'ABC123', reason: 'denied-path' });
  expect(parseDoneName('RQ-PHX-ABC123.md.other reason.v2')).toEqual({ id: 'ABC123', reason: 'other reason.v2' });
  for (const name of ['RQ-PHX-ABC123.md.bad/path', 'RQ-PHX-ABC123.md.bad\\path', 'RQ-PHX-ABC123.md', '../RQ-PHX-ABC123.md.denied-path', 'RQ-PHX-a.md.bad', 'RQ-PHX-ABC123.md.']) expect(parseDoneName(name)).toBeNull();
});
it('combines newest accepted and rejected evidence with queue existence', async () => {
  const dir = await root();
  await mkdir(join(dir, 'leader/drop/done'), { recursive: true });
  await mkdir(join(dir, 'queue/prompts'), { recursive: true });
  await writeFile(join(dir, 'leader/drop/ingested.tsv'), row('ABC123') + row('DEF456'));
  await writeFile(join(dir, 'leader/drop/done/RQ-PHX-BAD123.md.denied-path'), 'fake rejected prompt');
  await writeFile(join(dir, 'queue/prompts/RQ-PHX-ABC123.md'), 'fake queued prompt');
  const data = await readDropJobFates({ runsRoot: dir, now: () => Date.now() });
  expect(data.sourceState).toBe('healthy');
  expect(data.fates).toHaveLength(3);
  expect(data.fates.find(f => f.id === 'ABC123')).toMatchObject({ fate: 'ingested', queued: true });
  expect(data.fates.find(f => f.id === 'BAD123')).toMatchObject({ fate: 'rejected', reason: 'denied-path', queued: false });
  expect((await readDropJobFates({ runsRoot: dir, limit: 1 })).fates).toHaveLength(1);
});
it('tails only 64 KB and discards the partial first line', async () => {
  const dir = await root();
  await mkdir(join(dir, 'leader/drop'), { recursive: true });
  await writeFile(join(dir, 'leader/drop/ingested.tsv'), row('OLD123') + 'x'.repeat(70000) + '\n' + row('NEW123'));
  expect((await readDropJobFates({ runsRoot: dir })).fates.map(f => f.id)).toEqual(['NEW123']);
});
it('returns missing for a fresh root and refuses outside symlinks', async () => {
  const dir = await root();
  expect(await readDropJobFates({ runsRoot: dir })).toMatchObject({ sourceState: 'missing', fates: [] });
  const outside = await root();
  await mkdir(join(outside, 'drop'), { recursive: true });
  await writeFile(join(outside, 'drop/ingested.tsv'), row('SECRET'));
  await symlink(outside, join(dir, 'leader'), 'dir');
  expect(await readDropJobFates({ runsRoot: dir })).toMatchObject({ sourceState: 'degraded', fates: [] });
});
