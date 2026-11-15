import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetIntentSummary } from '../src/cli/fleet-intent-summary.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentSummary } from '../src/core/intent/summary.js';

const roots: string[] = [];
const previousRoot = process.env['ASHLR_RUNS_DIR'];
const now = Date.parse('2026-11-09T00:00:00Z');
const item: IntentItem = {
  id: 'one', title: 'Example directive', source: 'fixture', owner: 'owner', rq: ['RQ-TEST-1'],
  prs: [], status: 'merged', evidence: [], provenance: [], partial: true, closureProposal: null,
  lastTouchedAt: '2026-11-01T00:00:00Z', staleAfterMs: 1000,
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
};

async function fixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'intent-quality-'));
  roots.push(root);
  process.env['ASHLR_RUNS_DIR'] = root;
  return { root, path: join(root, 'intent', 'ledger.json') };
}
async function put(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
}
async function cli(json = true): Promise<{ code: number; output: string }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await cmdFleetIntentSummary(json ? ['--json'] : []);
    return { code, output: log.mock.calls.map((call) => String(call[0])).join('\n') };
  } finally { log.mockRestore(); }
}
afterEach(async () => {
  if (previousRoot === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previousRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('intent summary source quality', () => {
  it('reports absent evidence without creating directories', async () => {
    const { root } = await fixture();
    expect(await intentSummary({ nowMs: now })).toMatchObject({ present: false, sourceQuality: 'missing', countQuality: 'observed', items: 0 });
    expect(await cli(false)).toEqual({ code: 0, output: 'Intent ledger not present.' });
    expect(JSON.parse((await cli()).output)).toMatchObject({ sourceQuality: 'missing' });
    expect(await readdir(root)).toEqual([]);
  });
  it('preserves readable empty and populated counts and staleness', async () => {
    const { path } = await fixture();
    await put(path, JSON.stringify(emptyLedger()));
    expect(await intentSummary({ nowMs: now })).toMatchObject({ present: true, sourceQuality: 'readable', countQuality: 'observed', items: 0 });
    await put(path, JSON.stringify({ ...emptyLedger(), items: [item] }));
    expect(await intentSummary({ nowMs: now })).toMatchObject({ items: 1, tracked: 1, merged: 1, shipped: 0, verified: 0, partial: 1, stale: 1, staleItems: [{ id: 'one', title: item.title, status: 'merged' }] });
    expect((await cli()).code).toBe(0);
    await expect(intentSummary({ nowMs: NaN })).rejects.toThrow('Time must be valid.');
  });
  it.each(['corrupt', 'schema', 'symlink', 'oversized', 'directory'] as const)('reports %s as unavailable without leaking source details', async (kind) => {
    const { root, path } = await fixture();
    const secret = 'PRIVATE_FIXTURE_CONTENT';
    if (kind === 'symlink') {
      await put(join(root, 'target'), JSON.stringify(emptyLedger()));
      await mkdir(join(root, 'intent'));
      await symlink(join(root, 'target'), path);
    } else if (kind === 'directory') await mkdir(path, { recursive: true });
    else await put(path, kind === 'corrupt' ? secret : kind === 'schema' ? JSON.stringify({ schema: secret, items: [] }) : 'x'.repeat(2 * 1024 * 1024 + 1));
    const before = await readdir(join(root, 'intent'));
    expect(await intentSummary({ nowMs: now })).toMatchObject({ present: false, sourceQuality: 'unavailable', countQuality: 'unknown' });
    const json = await cli();
    expect(json.code).toBe(1);
    expect(JSON.parse(json.output)).toMatchObject({ sourceQuality: 'unavailable', countQuality: 'unknown' });
    const human = await cli(false);
    expect(human.code).toBe(1);
    expect(human.output).toContain('evidence is unavailable');
    for (const output of [json.output, human.output]) {
      expect(output).not.toContain(root);
      expect(output).not.toContain(secret);
    }
    expect(await readdir(join(root, 'intent'))).toEqual(before);
  });
});
