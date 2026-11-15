import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';

const originalRuns = process.env['ASHLR_RUNS_DIR'];
let root: string;
const at = '2026-11-01T00:00:00.000Z';
const item = {
  id: 'directive-1', title: 'Preserve the directive', source: 'owner note', owner: 'owner',
  rq: ['RQ-EXAMPLE-1'], prs: [], status: 'queued',
  evidence: [{ at, kind: 'note', ref: 'example evidence' }],
  provenance: [{ source: 'example source', date: at, verbatim: true, partial: false }],
  partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 604800000, createdAt: at, updatedAt: at,
};
const body = (result: Awaited<ReturnType<typeof callNativeTool>>) => JSON.parse(result.content[0]!.text);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-native-'));
  process.env['ASHLR_RUNS_DIR'] = root;
});
afterEach(async () => {
  if (originalRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = originalRuns;
  await rm(root, { recursive: true, force: true });
});

describe('native intent read preservation', () => {
  it('advertises closed read schemas and rejects malformed or injected arguments', async () => {
    for (const name of ['intent_list', 'intent_get']) {
      expect(nativeToolSafety(name)).toBe('read');
      expect(listNativeTools().find(tool => tool.name === name)?.inputSchema).toMatchObject({ additionalProperties: false });
    }
    expect(listNativeTools().find(tool => tool.name === 'intent_get')?.inputSchema).toMatchObject({ required: ['id'] });
    for (const [name, args] of [
      ['intent_list', { status: 'invalid' }], ['intent_list', { status: null }],
      ['intent_list', { root: '/tmp' }], ['intent_list', { env: {} }], ['intent_list', null],
      ['intent_get', {}], ['intent_get', { id: '../bad' }], ['intent_get', { id: 'valid', path: '/tmp' }],
    ] as const) expect((await callNativeTool(name, args)).isError).toBe(true);
  });

  it('reads persisted provenance and filters without changing ledger bytes', async () => {
    await mkdir(join(root, 'intent'), { mode: 0o700 });
    const path = join(root, 'intent', 'ledger.json');
    const bytes = JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: [item, { ...item, id: 'directive-2', status: 'merged' }] });
    await writeFile(path, bytes, { mode: 0o600 });
    const listed = body(await callNativeTool('intent_list', { status: 'queued' }));
    expect(listed).toMatchObject({ ok: true, present: true, sourceQuality: 'readable', countQuality: 'observed', items: 2, records: [item] });
    expect(body(await callNativeTool('intent_get', { id: item.id }))).toMatchObject({ ok: true, item });
    expect(body(await callNativeTool('intent_get', { id: 'missing' }))).toMatchObject({ ok: false, error: 'Intent not found.' });
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('distinguishes a missing ledger from a corrupt ledger', async () => {
    expect(body(await callNativeTool('intent_list', {}))).toMatchObject({ ok: true, present: false, sourceQuality: 'missing', records: [] });
    await mkdir(join(root, 'intent'));
    const path = join(root, 'intent', 'ledger.json');
    await writeFile(path, '{broken', { mode: 0o600 });
    expect((await callNativeTool('intent_list', {})).isError).toBe(true);
    expect((await callNativeTool('intent_get', { id: 'directive-1' })).isError).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });
});
