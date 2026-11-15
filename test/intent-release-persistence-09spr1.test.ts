import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetIntentEvidence } from '../src/cli/fleet-intent-evidence.js';
import { noteShippedRelease } from '../src/core/intent/release.js';
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
async function setup(items: IntentItem[] | null = [item('alpha'), item('beta', 'verified'), item('gamma', 'closed'), item('delta')]): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'intent-release-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  if (items) await writeLedger({ ...emptyLedger(), items }, root);
}
async function run(args: string[]): Promise<{ code: number; result: { dryRun: boolean; applied: boolean; matches: { id: string; status: string }[] } }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetIntentEvidence([...args, '--json']);
  const result = code === 0 ? JSON.parse(String(log.mock.calls.at(-1)?.[0])) : undefined;
  log.mockRestore();
  return { code, result };
}

describe('noteShippedRelease', () => {
  it('persists matched releases, preserves terminal statuses and leaves unrelated records alone', async () => {
    await setup();
    const before = await readLedger(root);
    const out = await noteShippedRelease({ release: 'v1.0.0', rq: ['RQ-ALPHA-1', 'RQ-BETA-1', 'RQ-GAMMA-1'] }, { root, now: at });
    expect(out).toEqual({ updated: 3, matches: [{ id: 'alpha', status: 'shipped' }, { id: 'beta', status: 'verified' }, { id: 'gamma', status: 'closed' }] });
    const after = await readLedger(root);
    expect(after.items.map((i) => i.status)).toEqual(['shipped', 'verified', 'closed', 'queued']);
    expect(after.items[0]!.evidence).toEqual([{ at, kind: 'release', ref: 'v1.0.0' }]);
    expect(after.items[3]).toEqual(before.items[3]);
  });
  it('does not create or rewrite a ledger when missing, empty or unmatched', async () => {
    await setup(null);
    expect(await noteShippedRelease({ release: 'v1', rq: ['RQ-ALPHA-1'] }, { root, now: at })).toEqual({ updated: 0, matches: [] });
    await expect(stat(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeLedger(emptyLedger(), root);
    const empty = await readFile(intentLedgerPath(root), 'utf8');
    await noteShippedRelease({ release: 'v1', rq: ['RQ-ALPHA-1'] }, { root, now: at });
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(empty);
    await setup();
    const bytes = await readFile(intentLedgerPath(root), 'utf8');
    expect((await noteShippedRelease({ release: 'v1', rq: ['RQ-NOPE-1'] }, { root, now: at })).updated).toBe(0);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(bytes);
  });
  it('prefers opts.now, then release.at, then the current time', async () => {
    await setup();
    const early = '2026-11-01T00:00:00.000Z';
    await noteShippedRelease({ release: 'a', rq: ['RQ-ALPHA-1'], at: early }, { root, now: at });
    await noteShippedRelease({ release: 'b', rq: ['RQ-DELTA-1'], at: early }, { root });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    try { await noteShippedRelease({ release: 'c', rq: ['RQ-BETA-1'] }, { root }); } finally { vi.useRealTimers(); }
    const items = (await readLedger(root)).items;
    expect(items[0]!.evidence[0]!.at).toBe(at);
    expect(items[3]!.evidence[0]!.at).toBe(early);
    expect(items[1]!.evidence[0]!.at).toBe('2026-11-09T12:00:00.000Z');
  });
  it('propagates corrupted ledger failures', async () => {
    await setup(null);
    await mkdir(join(root, 'intent'), { recursive: true });
    await writeFile(intentLedgerPath(root), '{not json');
    await expect(noteShippedRelease({ release: 'v1', rq: ['RQ-ALPHA-1'] }, { root, now: at })).rejects.toThrow(/not valid JSON/);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe('{not json');
  });
});

describe('fleet intent-evidence shipped via the shared operation', () => {
  const args = ['shipped', '--release', 'v2.0.0', '--rq', 'RQ-ALPHA-1,RQ-BETA-1', '--at', at];
  it('dry-run leaves bytes unchanged and --apply reports persisted ids and statuses', async () => {
    await setup();
    const before = await readFile(intentLedgerPath(root), 'utf8');
    const preview = await run(args);
    expect(preview).toEqual({ code: 0, result: { dryRun: true, applied: false, matches: [{ id: 'alpha', status: 'shipped' }, { id: 'beta', status: 'verified' }] } });
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe(before);
    const applied = await run([...args, '--apply']);
    expect(applied).toEqual({ code: 0, result: { dryRun: false, applied: true, matches: preview.result.matches } });
    const items = (await readLedger(root)).items;
    expect(items.map((i) => i.status)).toEqual(['shipped', 'verified', 'closed', 'queued']);
    expect(items[0]!.evidence).toEqual([{ at, kind: 'release', ref: 'v2.0.0' }]);
  });
  it('does not create a ledger and exits 1 on a corrupted one', async () => {
    await setup(null);
    expect((await run([...args, '--apply'])).result).toEqual({ dryRun: false, applied: false, matches: [] });
    await expect(stat(intentLedgerPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(root, 'intent'), { recursive: true });
    await writeFile(intentLedgerPath(root), 'garbage');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await run([...args, '--apply'])).code).toBe(1);
    expect(await readFile(intentLedgerPath(root), 'utf8')).toBe('garbage');
  });
});
