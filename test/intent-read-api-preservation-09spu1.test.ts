import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listIntents, getIntent } from '../src/core/intent/read.js';
import { cmdFleetIntentRead } from '../src/cli/fleet-intent-read.js';
import { summarize } from '../src/core/intent/summary.js';
import { readLedger } from '../src/core/intent/store.js';

const at = '2026-11-05T00:00:00.000Z';
const nowMs = Date.parse('2026-11-06T00:00:00.000Z');
const item = (id: string, status: 'queued' | 'merged', partial = false) => ({
  id, title: `Directive ${id}`, source: 'fixture', owner: 'owner', rq: id === 'one' ? ['RQ-TEST-1'] : [],
  prs: [], status, evidence: [], provenance: [], partial, closureProposal: null,
  lastTouchedAt: at, staleAfterMs: 1000, createdAt: at, updatedAt: at,
});
const items = [item('one', 'queued'), item('two', 'merged', true), item('three', 'queued')];
let root: string;
let previous: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-api-'));
  previous = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = root;
});
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('original intent read cases', () => {
  it('keeps ledger order, filters records only, and summarizes the same full ledger', async () => {
    await mkdir(join(root, 'intent'));
    const path = join(root, 'intent', 'ledger.json');
    const bytes = ` ${JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items })}\n`;
    await writeFile(path, bytes);
    const result = await listIntents({ root, status: 'queued', nowMs });
    expect(result.items).toEqual([items[0], items[2]]);
    expect((await listIntents({ root, nowMs })).items).toEqual(items);
    expect(result.summary).toEqual(summarize(await readLedger(root), nowMs));
    expect(result.summary).toMatchObject({ items: 3, tracked: 1, merged: 1, stale: 3, partial: 1, sourceQuality: 'readable' });
    expect(await getIntent('two', root)).toEqual(items[1]);
    expect(await getIntent('absent', root)).toBeNull();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetIntentRead(['list', '--status', 'merged', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.pop()?.[0]))).toEqual({ ok: true, records: [items[1]] });
    expect(await cmdFleetIntentRead(['get', 'one', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.pop()?.[0]))).toEqual({ ok: true, item: items[0] });
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
  it('distinguishes missing from malformed, without creating state', async () => {
    expect((await listIntents({ root, nowMs })).summary).toMatchObject({ present: false, sourceQuality: 'missing', countQuality: 'observed' });
    expect(await getIntent('absent', root)).toBeNull();
    await expect(readFile(join(root, 'intent', 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(root, 'intent'));
    await writeFile(join(root, 'intent', 'ledger.json'), '{bad');
    await expect(listIntents({ root, nowMs })).rejects.toThrow();
    await expect(getIntent('absent', root)).rejects.toThrow();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetIntentRead(['list', '--json'])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ ok: false });
  });
});
