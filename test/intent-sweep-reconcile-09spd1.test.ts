import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cmdFleetIntentSweep } from '../src/cli/fleet-intent-sweep.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const old = '2026-11-01T00:00:00Z';
const now = '2026-11-09T00:00:00Z';
const roots: string[] = [];
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previous;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function item(id: string, status: IntentStatus, touched = old): IntentItem {
  return { id, title: `Directive ${id}`, source: 'fake note', owner: 'owner', rq: [], prs: [], status,
    evidence: [{ at: old, kind: 'note', ref: 'original evidence' }], provenance: [], partial: false,
    closureProposal: null, lastTouchedAt: touched, staleAfterMs: 60_000, createdAt: old, updatedAt: old };
}
async function run(args: string[]) {
  let out = ''; let err = '';
  const code = await cmdFleetIntentSweep([...args, '--json'], { output: text => { out = text; }, error: text => { err = text; } });
  return { code, out: out ? JSON.parse(out) as { stale: Array<{ id: string; status: string; action: string }>; updated: number } : undefined, err };
}

it('sweeps the private ledger through the CLI without treating staleness as completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'intent-sweep-')); roots.push(root);
  process.env['ASHLR_RUNS_DIR'] = root;
  expect((await run(['--now', now])).out?.stale).toEqual([]);
  expect(await readdir(root)).toEqual([]);
  const items = [item('active', 'in-progress'), item('merged', 'merged'), item('fresh', 'in-progress', now),
    ...(['shipped', 'verified', 'closed', 'superseded'] as const).map(status => item(status, status))];
  await writeLedger({ ...emptyLedger(), items }, root);
  const path = intentLedgerPath(root);
  const before = await readFile(path, 'utf8');
  const dry = await run(['--now', now]);
  expect(dry.code).toBe(0);
  expect(dry.out?.stale).toMatchObject([{ id: 'active', status: 'in-progress', action: 'requeue' }, { id: 'merged', status: 'merged', action: 'await-verification' }]);
  expect(await readFile(path, 'utf8')).toBe(before);
  expect((await run(['--apply', '--now', now])).out?.updated).toBe(2);
  const ledger = await readLedger(root);
  expect(ledger.items[0]).toMatchObject({ status: 'queued', lastTouchedAt: now, evidence: [{ ref: 'original evidence' }, { kind: 'sweep', ref: 'requeue' }] });
  expect(ledger.items[1]).toMatchObject({ status: 'merged', evidence: [{ ref: 'original evidence' }, { ref: 'await-verification' }] });
  expect(ledger.items.slice(2)).toEqual(items.slice(2));
  const applied = await readFile(path, 'utf8');
  expect((await run(['--apply', '--now', now])).out?.updated).toBe(0);
  expect(await readFile(path, 'utf8')).toBe(applied);
  for (const time of ['2026-11-10T00:00:00Z', '2026-11-11T00:00:00Z']) {
    expect((await run(['--apply', '--now', time])).code).toBe(0);
  }
  const final = await readLedger(root);
  expect(final.items[0]?.status).toBe('queued');
  expect(final.items[0]?.closureProposal).toBeNull();
  expect(final.items[1]?.status).toBe('merged');
  const last = await readFile(path, 'utf8');
  expect((await run(['--apply', '--now', 'bad'])).code).toBe(1);
  expect((await run(['--apply', '--unknown'])).code).toBe(2);
  expect(await readFile(path, 'utf8')).toBe(last);
});
