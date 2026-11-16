import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIntent } from '../src/cli/fleet-intent.js';
import { addIntent, updateIntent } from '../src/core/intent/ledger.js';
import { intentLedgerPath, readLedger, transactIntentLedger } from '../src/core/intent/store.js';

let root: string;
let previous: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-link-'));
  previous = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = root;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previous;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

const link = (title = 'RQ-FAKE-1', extra: string[] = []) =>
  cmdFleetIntent(['link', '--repo', 'fake/repo', '--number', '10', '--title', title, ...extra]);

describe('fleet intent link preservation', () => {
  it('serializes a real link with a held disk transaction and concurrent add/update', async () => {
    const item = await addIntent({ title: 'First directive', source: 'fixture', rq: ['RQ-FAKE-1'] });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = transactIntentLedger(undefined, async ledger => {
      entered();
      await gate;
      ledger.items[0]!.owner = 'held-writer';
    });
    await ready;
    const linked = link('RQ-FAKE-1', ['--json']);
    const early = await Promise.race([linked.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);
    const added = addIntent({ title: 'Second directive', source: 'fixture', rq: ['RQ-FAKE-2'] });
    const updated = updateIntent(item.id, { evidence: { ref: 'caller-note' } });
    release();
    const result = await linked;
    await Promise.all([held, added, updated]);
    expect(early).toBe(false);
    expect(result).toBe(0);
    const ledger = await readLedger();
    expect(ledger.items).toHaveLength(2);
    const first = ledger.items.find(row => row.id === item.id)!;
    expect(first.owner).toBe('held-writer');
    expect(first.prs).toMatchObject([{ repo: 'fake/repo', number: 10, state: 'merged' }]);
    expect(first.evidence.map(row => row.ref)).toEqual(['fake/repo#10', 'caller-note']);
  });

  it('retains duplicate, unmatched, malformed and output contracts', async () => {
    await addIntent({ title: 'First directive', source: 'fixture', rq: ['RQ-FAKE-1'] });
    await addIntent({ title: 'Unrelated directive', source: 'fixture', rq: ['RQ-OTHER-1'] });
    expect(await link('rq-fake-1', ['--json'])).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify({ ok: true, updated: 1 }));
    expect(await link()).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith('Linked 1.');
    expect(await link('RQ-NOMATCH-1', ['--json'])).toBe(0);
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify({ ok: true, updated: 0 }));
    const ledger = await readLedger();
    expect(ledger.items[0]!.prs).toHaveLength(1);
    expect(ledger.items[0]!.evidence.map(row => row.ref)).toEqual(['fake/repo#10', 'fake/repo#10']);
    expect(ledger.items[0]!.status).toBe('merged');
    expect(ledger.items[1]!.status).toBe('proposed');
    const before = await readFile(intentLedgerPath());
    expect(await cmdFleetIntent(['link', '--repo', 'bad', '--number', '10', '--title', 'RQ-OTHER-1', '--json'])).toBe(2);
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify({ ok: false, error: 'Invalid pull evidence.' }));
    expect(await cmdFleetIntent(['link', '--repo', 'fake/repo', '--number', '0', '--title', 'RQ-OTHER-1'])).toBe(2);
    expect(console.error).toHaveBeenLastCalledWith('Invalid pull evidence.');
    expect(await readFile(intentLedgerPath())).toEqual(before);
  });
});
