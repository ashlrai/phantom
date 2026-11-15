import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetIntentEvidence } from '../src/cli/fleet-intent-evidence.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const at = '2026-11-05T21:46:00.000Z';
const item = (id: string, status: IntentItem['status'] = 'queued'): IntentItem => ({
  id, title: id, source: 'fixture', owner: 'fixture', rq: [`RQ-${id.toUpperCase()}-1`], prs: [], status,
  evidence: [], provenance: [], partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
});
let root = '';
const previous = process.env['ASHLR_RUNS_DIR'];
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});
async function setup(withLedger = true): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'intent-evidence-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  if (withLedger) await writeLedger({ ...emptyLedger(), items: [item('alpha'), item('beta', 'verified'), item('gamma', 'closed')] });
}
async function run(args: string[]): Promise<{ code: number; result: { dryRun: boolean; applied: boolean; matches: { id: string; status: string }[] } }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetIntentEvidence([...args, '--json']);
  const result = code === 0 ? JSON.parse(String(log.mock.calls.at(-1)?.[0])) : undefined;
  log.mockRestore();
  return { code, result };
}
const merged = ['merged', '--repo', 'example/project', '--number', '42', '--title', 'RQ-ALPHA-1 and RQ-BETA-1', '--at', at];

describe('fleet intent evidence', () => {
  it('previews merges without changing bytes and persists explicit evidence', async () => {
    await setup();
    const path = intentLedgerPath();
    const before = await readFile(path, 'utf8');
    const preview = await run(merged);
    expect(preview).toMatchObject({ code: 0, result: { dryRun: true, applied: false, matches: [{ id: 'alpha', status: 'merged' }, { id: 'beta', status: 'verified' }] } });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect((await run([...merged, '--apply'])).result.applied).toBe(true);
    const ledger = await readLedger();
    expect(ledger.items[0]!.prs).toEqual([{ repo: 'example/project', number: 42, state: 'merged' }]);
    expect(ledger.items[1]!.status).toBe('verified');
  });
  it('associates release keys and notes, preserving terminal states and ignoring nonmatches', async () => {
    await setup();
    const result = await run(['shipped', '--release', 'v1.2.3', '--rq', 'RQ-ALPHA-1,RQ-GAMMA-1', '--notes', 'RQ-BETA-1', '--at', at, '--apply']);
    expect(result.result.matches).toEqual([{ id: 'alpha', status: 'shipped' }, { id: 'beta', status: 'verified' }, { id: 'gamma', status: 'closed' }]);
    expect((await readLedger()).items[0]!.evidence[0]).toEqual({ at, kind: 'release', ref: 'v1.2.3' });
    expect((await run(['merged', '--repo', 'example/project', '--number', '9', '--title', 'unrelated', '--apply'])).result.matches).toEqual([]);
  });
  it('rejects invalid arguments without writing', async () => {
    await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await readFile(intentLedgerPath(), 'utf8');
    for (const args of [
      ['merged', '--repo', 'bad', '--number', '1', '--title', 'x'],
      ['merged', '--repo', 'a/b', '--number', '1.5', '--title', 'x'],
      ['shipped', '--release', 'v1', '--rq', 'bad'],
      ['shipped', '--release', 'v1'],
      [...merged, '--at', 'bad'],
    ]) expect((await run([...args, '--apply'])).code).toBe(2);
    expect(await readFile(intentLedgerPath(), 'utf8')).toBe(before);
  });
  it('does not create a missing ledger, even on apply', async () => {
    await setup(false);
    expect((await run([...merged, '--apply'])).result).toEqual({ dryRun: false, applied: false, matches: [] });
    await expect(stat(intentLedgerPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
