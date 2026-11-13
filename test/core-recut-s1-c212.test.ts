import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem, type IntentStatus } from '../src/core/intent/schema.js';
import { intentLedgerPath, readLedger, writeLedger } from '../src/core/intent/store.js';

const gate = vi.hoisted(() => ({ killed: false }));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => gate.killed }));

const old = '2020-01-01T00:00:00Z';
const previous = process.env['ASHLR_RUNS_DIR'];
let root: string;
function item(status: IntentStatus, rq = ['RQ-FAKE-1']): IntentItem {
  return { id: status, title: `Directive ${status}`, source: 'fake note', owner: 'owner', rq, prs: [], status,
    evidence: [{ at: old, kind: 'note', ref: 'original' }], provenance: [], partial: false,
    closureProposal: null, lastTouchedAt: old, staleAfterMs: 60_000, createdAt: old, updatedAt: old };
}
const call = (args: unknown = {}) => callNativeTool('intent_stale', args);
const payload = async (args: unknown = {}) => {
  const result = await call(args);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-native-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  gate.killed = false;
});
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  await rm(root, { recursive: true, force: true });
});

it('discovers the strict append tool and previews without changing the ledger', async () => {
  expect(listNativeTools().find(tool => tool.name === 'intent_stale')?.inputSchema).toEqual({
    type: 'object', properties: { apply: { type: 'boolean' } }, additionalProperties: false,
  });
  expect(nativeToolSafety('intent_stale')).toBe('append');
  await writeLedger({ ...emptyLedger(), items: [item('in-progress')] });
  const before = await readFile(intentLedgerPath());
  expect(await payload()).toMatchObject({ ok: true, applied: false, updated: 0,
    stale: [{ id: 'in-progress', status: 'in-progress', action: 'requeue' }] });
  expect(await readFile(intentLedgerPath())).toEqual(before);
});

it('refreshes stale tracking without closing or dispatching work', async () => {
  const items = [item('in-progress'), item('merged'), item('proposed', []),
    ...(['shipped', 'verified', 'closed', 'superseded'] as const).map(status => item(status))];
  await writeLedger({ ...emptyLedger(), items });
  const result = await payload({ apply: true });
  expect(result).toMatchObject({ ok: true, applied: true, updated: 3, stale: [
    { id: 'in-progress', status: 'queued', action: 'requeue' },
    { id: 'merged', status: 'merged', action: 'await-verification' },
    { id: 'proposed', status: 'proposed', action: 'propose-superseded' },
  ] });
  const saved = await readLedger();
  for (const [index, action] of ['requeue', 'await-verification', 'propose-superseded'].entries()) {
    const entry = saved.items[index]!;
    expect(Date.parse(entry.updatedAt)).toBeGreaterThan(Date.parse(old));
    expect(entry.lastTouchedAt).toBe(entry.updatedAt);
    expect(entry.evidence.at(-1)).toMatchObject({ at: entry.updatedAt, kind: 'sweep', ref: action, note: 'Local stale tracking refreshed; no job dispatched.' });
  }
  expect(saved.items.slice(3)).toEqual(items.slice(3));
  expect(await readdir(root)).toEqual(['intent']);
});

it('rejects unknown keys and nonboolean apply before mutation', async () => {
  await writeLedger({ ...emptyLedger(), items: [item('in-progress')] });
  const before = await readFile(intentLedgerPath());
  for (const args of [{ apply: true, root: '/fake' }, { apply: 'true' }, { apply: null }, { now: old }, { paths: [] }]) {
    expect((await call(args)).isError).toBe(true);
    expect(await readFile(intentLedgerPath())).toEqual(before);
  }
});

it('reports corrupt ledgers and refuses both preview and apply under KILL', async () => {
  await writeLedger({ ...emptyLedger(), items: [item('in-progress')] });
  await writeFile(intentLedgerPath(), '{broken');
  expect((await call({ apply: true })).isError).toBe(true);
  expect(await readFile(intentLedgerPath(), 'utf8')).toBe('{broken');
  await writeLedger({ ...emptyLedger(), items: [item('in-progress')] });
  const before = await readFile(intentLedgerPath());
  gate.killed = true;
  expect((await call()).isError).toBe(true);
  expect((await call({ apply: true })).isError).toBe(true);
  expect(await readFile(intentLedgerPath())).toEqual(before);
});
