import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { familyKey, familyStops, pruneFamilyStops, readFamilyStops } from '../src/core/fleet/empty-family-stops.js';
import { readRecutGateFacts, shouldEmitRecut } from '../src/core/fleet/recut-gate.js';
import { yieldTally } from '../src/core/fleet/slot-yield.js';
const now = Date.parse('2026-11-21T16:00:00Z');
const ids = ['RQ-PHX-LANDUIDIRTY706', 'RQ-PHX-LANDCLIDIRTY707'];
const rows = (jobs: string[]) => jobs.flatMap((job, i) => [{ job, event: 'launch', ts: new Date(now - 1000 - i).toISOString() }, { job, event: 'finish', ts: new Date(now - i).toISOString(), empty: true }]);
const runs = (input: object[]) => { const t = yieldTally(now, 24); input.forEach(r => t.add(JSON.stringify(r))); return t.runs(); };
it('groups area siblings and strips cycle variants without grouping unrelated jobs', () => {
  expect(ids.map(familyKey)).toEqual(['LAND*DIRTY', 'LAND*DIRTY']);
  expect(['RQ-PHX-REDTESTFIXC740C', 'RQ-PHX-REDTYPEFIXC741D', 'RQ-PHX-REDTESTFIXC742B'].map(familyKey)).toEqual(['REDTESTFIX', 'REDTYPEFIX', 'REDTESTFIX']);
});
it('stops siblings for two hours; six zero-PR launches for a day; protects merged work and running launches', () => {
  const reason = new Map([[ids[0]!, 'no eligible PR']]);
  expect(familyStops(runs(rows([ids[0]!])), reason, now)[0]).toMatchObject({ key: 'LAND*DIRTY', until: now + 7200000, evidence: [ids[0]] });
  const six = rows(Array.from({ length: 6 }, (_, i) => `RQ-PHX-REDTESTFIXC74${i}B`));
  expect(familyStops(runs(six), new Map(), now)[0]?.until).toBe(now + 86400000);
  expect(familyStops(runs(six), new Map(), now + 86400000)).toEqual([]);
  expect(familyStops(runs([...six, { job: 'RQ-PHX-REDTESTFIXC740B', event: 'outcome', outcome: 'MERGED', ts: new Date(now).toISOString() }]), new Map(), now)).toEqual([]);
  expect(familyStops(runs([...rows([ids[0]!]), { job: ids[0], event: 'merged', ts: new Date(now).toISOString() }]), reason, now)).toEqual([]);
  expect(familyStops(runs([...six, { job: 'RQ-PHX-REDTESTFIXC740B', event: 'publish', class: 'pr', ts: new Date(now).toISOString() }]), new Map(), now)).toEqual([]);
  expect(familyStops(runs(six.slice(0, -1)), new Map(), now)).toEqual([]);
  expect(familyStops(runs(rows([ids[0]!])), reason, now + 7200000)).toEqual([]);
});
it('previews then removes only unlaunched rows, preserving claims, prompts and logs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'families-'));
  try {
    await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'metrics/jobs.jsonl'), rows([ids[0]!]).map(r => JSON.stringify(r)).join('\n'));
    await writeFile(join(root, `${ids[0]}.log`), 'No eligible API PR among open PRs');
    await writeFile(join(root, 'queue/claimed.tsv'), 'RQ-PHX-LANDVERSEDIRTY707\twork\n');
    const text = `- READY ${ids[0]} work\n- READY ${ids[1]} work\n- CLAIMED RQ-PHX-LANDWEBUIDIRTY707\n- READY RQ-PHX-LANDVERSEDIRTY707 work\n- READY OTHER work\n`;
    await writeFile(join(root, 'queue/router-queue.md'), text);
    await writeFile(join(root, `${ids[1]}.prompt`), 'plain work');
    await writeFile(join(root, 'queue/ready.tsv'), `${ids[1]}\tphantom\twork\n`);
    const facts = await readRecutGateFacts(ids[1]!, { metrics: join(root, 'metrics/jobs.jsonl'), now, git: async () => ({ code: 0, stdout: '' }), stopFile: null });
    expect(shouldEmitRecut(facts!).emit).toBe(false);
    expect((await pruneFamilyStops(root, false, now)).removed).toContain(ids[1]);
    expect(await readFile(join(root, 'queue/router-queue.md'), 'utf8')).toBe(text);
    expect((await pruneFamilyStops(root, true, now)).removed).toEqual([ids[1]]);
    expect(await readFile(join(root, 'queue/router-queue.md'), 'utf8')).toBe(text.replace(`- READY ${ids[1]} work\n`, ''));
    expect(await readFile(join(root, 'queue/ready.tsv'), 'utf8')).toBe('');
    expect(await readFile(join(root, `${ids[1]}.prompt`), 'utf8')).toBe('plain work');
    expect(await readFile(join(root, `${ids[0]}.log`), 'utf8')).toBe('No eligible API PR among open PRs');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['broken', 'null', '[]'])('refuses to prune with malformed outcome evidence: %s', async invalid => {
  const root = await mkdtemp(join(tmpdir(), 'families-invalid-'));
  try {
    await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
    const metrics = join(root, 'metrics/jobs.jsonl');
    await writeFile(metrics, rows([ids[0]!]).map(r => JSON.stringify(r)).join('\n') + '\n' + invalid);
    await writeFile(join(root, `${ids[0]}.log`), 'No eligible API PR among open PRs');
    await writeFile(join(root, 'queue/claimed.tsv'), '');
    const ready = `${ids[1]}\tphantom\twork\n`;
    await writeFile(join(root, 'queue/ready.tsv'), ready);
    expect(await readFamilyStops(metrics, now)).toMatchObject({ known: false, stops: [] });
    expect(await pruneFamilyStops(root, true, now)).toMatchObject({ known: false, removed: [] });
    expect(await readFile(join(root, 'queue/ready.tsv'), 'utf8')).toBe(ready);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('refuses to apply without readable claims evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'families-claims-'));
  try {
    await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'metrics/jobs.jsonl'), rows([ids[0]!]).map(r => JSON.stringify(r)).join('\n'));
    const ready = `${ids[1]}\tphantom\twork\n`;
    await writeFile(join(root, 'queue/ready.tsv'), ready);
    await expect(pruneFamilyStops(root, true, now)).rejects.toThrow('Claims unreadable');
    expect(await readFile(join(root, 'queue/ready.tsv'), 'utf8')).toBe(ready);
  } finally { await rm(root, { recursive: true, force: true }); }
});
