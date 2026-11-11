import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { emptyLedger, type IntentItem } from '../src/core/intent/schema.js';
import { intentLedgerPath, writeLedger } from '../src/core/intent/store.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => false }));

const old = '2020-01-01T00:00:00Z';
const previous = process.env['ASHLR_RUNS_DIR'];
let root: string;

function staleItem(): IntentItem {
  return { id: 'in-progress', title: 'Directive recut', source: 'fake note', owner: 'owner',
    rq: ['RQ-FAKE-RECUT'], prs: [], status: 'in-progress',
    evidence: [{ at: old, kind: 'note', ref: 'original' }], provenance: [], partial: false,
    closureProposal: null, lastTouchedAt: old, staleAfterMs: 60_000, createdAt: old, updatedAt: old };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'recut-s114-'));
  process.env['ASHLR_RUNS_DIR'] = root;
});
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previous;
  await rm(root, { recursive: true, force: true });
});

it('exposes intent_stale as a strict append tool whose preview leaves the ledger untouched', async () => {
  expect(listNativeTools().find(tool => tool.name === 'intent_stale')?.inputSchema).toEqual({
    type: 'object', properties: { apply: { type: 'boolean' } }, additionalProperties: false,
  });
  expect(nativeToolSafety('intent_stale')).toBe('append');
  await writeLedger({ ...emptyLedger(), items: [staleItem()] });
  const before = await readFile(intentLedgerPath());
  const result = await callNativeTool('intent_stale', {});
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true, applied: false, updated: 0,
    stale: [{ id: 'in-progress', status: 'in-progress', action: 'requeue' }] });
  expect(await readFile(intentLedgerPath())).toEqual(before);
});
