/**
 * RQ-PHX-NATIVEREADOWNERQUALIFY291S — owner-qualification contract for
 * EXISTING owner PR #5316 (RQ-PHX-INTENTNATIVEREADRECOVER230S), observed head
 * a888fc985676. The PR exposes the persisted intent ledger through two new
 * native gateway tools, `intent_list` and `intent_get`, both declared
 * safety 'read'.
 *
 * This suite covers the scenarios NOT already pinned by the owner's own
 * test/intent-native-read-preservation-230s.test.ts: non-object/array/scalar
 * argument bodies on both tools, extra keys beside valid values, the full
 * canonical status vocabulary, id pattern bounds, refusal-payload isError on
 * lookup misses, the zero-observed/missing/corrupt tri-state, a wider corrupt
 * battery that must never fall back to a successful empty result, whole
 * runs-dir byte stability across every outcome class, real CLI parity through
 * cmdFleetIntent, and reads served while KILL is engaged.
 *
 * Self-skips on trees without the owner change (master before #5316 merges):
 * the suite activates the moment `intent_list` appears in the native catalog.
 */
import { mkdtemp, mkdir, lstat, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIntent } from '../src/cli/fleet-intent.js';
import { callNativeTool, isNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { getIntent, listIntents } from '../src/core/intent/ledger.js';
import { INTENT_STATUSES } from '../src/core/intent/schema.js';

const OWNER_TREE = isNativeTool('intent_list');
const at = new Date().toISOString();
const item = (id: string, status: string) => ({
  id, title: `Owner directive ${id}`, source: 'owner note', owner: 'owner',
  rq: [`RQ-QUALIFY-${id.toUpperCase().replace(/[^A-Z0-9]/g, '')}`],
  prs: [{ repo: 'ashlrai/phantom', number: 5316, url: 'https://example.invalid/pr/5316', state: 'open' }],
  status,
  evidence: [{ at, kind: 'note', ref: `evidence ${id}` }],
  provenance: [{ source: `qualify source ${id}`, date: at, verbatim: true, partial: false }],
  partial: false, closureProposal: null, lastTouchedAt: at, staleAfterMs: 604800000,
  createdAt: at, updatedAt: at,
});
const body = (result: Awaited<ReturnType<typeof callNativeTool>>) => JSON.parse(result.content[0]!.text);
const text = (result: Awaited<ReturnType<typeof callNativeTool>>) => result.content[0]!.text;
const ledgerPath = (root: string) => join(root, 'intent', 'ledger.json');
const writeLedger = async (root: string, bytes: string) => {
  await mkdir(join(root, 'intent'), { recursive: true, mode: 0o700 });
  await writeFile(ledgerPath(root), bytes, { mode: 0o600 });
};

async function snapshotTree(root: string): Promise<Map<string, { bytes: Buffer; mode: number }>> {
  const out = new Map<string, { bytes: Buffer; mode: number }>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.set(relative(root, full), { bytes: await readFile(full), mode: (await lstat(full)).mode });
    }
  };
  await walk(root);
  return out;
}

const originalRuns = process.env['ASHLR_RUNS_DIR'];
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'intent-native-owner-291s-'));
  process.env['ASHLR_RUNS_DIR'] = root;
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = originalRuns;
  await rm(join(homedir(), '.ashlr', 'KILL'), { force: true });
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!OWNER_TREE)('intent native read owner contract (PR #5316 head)', () => {
  it('advertises exactly the two read tools with canonical enum and id bounds', () => {
    for (const name of ['intent_list', 'intent_get']) {
      expect(isNativeTool(name)).toBe(true);
      expect(nativeToolSafety(name)).toBe('read');
    }
    // The read surface is exactly these two: no sibling intents leak into the catalog.
    for (const name of ['intent_read', 'intent_ledger', 'intent_summary', 'intent_query']) {
      expect(isNativeTool(name)).toBe(false);
    }
    const list = listNativeTools().find(t => t.name === 'intent_list')!.inputSchema as {
      properties: { status: { type: string; enum: string[] } }; additionalProperties: boolean;
    };
    const get = listNativeTools().find(t => t.name === 'intent_get')!.inputSchema as {
      properties: { id: { type: string; pattern: string } }; required: string[]; additionalProperties: boolean;
    };
    // The advertised enum is exactly the canonical vocabulary — order-insensitive, no extras.
    expect([...list.properties.status.enum].sort()).toEqual([...INTENT_STATUSES].sort());
    expect(list.additionalProperties).toBe(false);
    expect(get.required).toEqual(['id']);
    expect(get.properties.id.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$');
    expect(get.additionalProperties).toBe(false);
  });

  it('rejects non-object, array and scalar argument bodies on both tools', async () => {
    const cases: [string, unknown][] = [];
    for (const name of ['intent_list', 'intent_get']) {
      for (const args of [undefined, 'queued', 7, true, [], [{ id: 'a' }], [{ status: 'queued' }]]) {
        cases.push([name, args]);
      }
    }
    for (const [name, args] of cases) {
      const result = await callNativeTool(name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(text(result)).toContain(`Invalid arguments for ${name}:`);
    }
  });

  it('rejects wrong types and extra keys even beside valid values, without echoing them', async () => {
    const sentinel = 'HARBOR-XYZZY-9x';
    const cases: [string, unknown][] = [
      ['intent_list', { status: 0 }], ['intent_list', { status: [] }], ['intent_list', { status: {} }],
      ['intent_list', { status: false }], ['intent_list', { status: sentinel }],
      ['intent_list', { status: 'queued', path: '/tmp' }], ['intent_list', { status: 'queued', root: '/tmp' }],
      ['intent_list', { status: 'queued', env: {} }],
      ['intent_get', { id: 0 }], ['intent_get', { id: [] }], ['intent_get', { id: {} }],
      ['intent_get', { id: null }], ['intent_get', { id: undefined }],
      ['intent_get', { id: 'valid-id', path: '/tmp' }], ['intent_get', { id: 'valid-id', status: 'queued' }],
      ['intent_get', { id: `x/${sentinel}` }],
    ];
    for (const [name, args] of cases) {
      const result = await callNativeTool(name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(text(result)).toContain(`Invalid arguments for ${name}:`);
      expect(text(result)).not.toContain(sentinel);
    }
  });

  it('accepts exactly the canonical status vocabulary', async () => {
    const one = item('alpha', 'queued');
    const two = item('beta', 'merged');
    await writeLedger(root, JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: [one, two] }));
    for (const status of INTENT_STATUSES) {
      const result = body(await callNativeTool('intent_list', { status }));
      expect(result.ok, status).toBe(true);
      expect(result.records.map((r: { id: string }) => r.id)).toEqual(
        status === 'queued' ? ['alpha'] : status === 'merged' ? ['beta'] : []);
    }
    for (const bad of ['', 'Queued', 'QUEUED', ' queued', 'queued ', 'pro posed', 'closedd']) {
      expect((await callNativeTool('intent_list', { status: bad })).isError, JSON.stringify(bad)).toBe(true);
    }
    // An explicit undefined status is the absent filter, not a rejection.
    const unfiltered = body(await callNativeTool('intent_list', { status: undefined }));
    expect(unfiltered.records.map((r: { id: string }) => r.id)).toEqual(['alpha', 'beta']);
  });

  it('bounds the id pattern exactly and separates invalid ids from misses', async () => {
    const seed = item('a'.repeat(81), 'queued');
    await writeLedger(root, JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: [seed] }));
    // Boundary ids that pass validation reach the handler.
    expect(body(await callNativeTool('intent_get', { id: 'a'.repeat(81) }))).toMatchObject({ ok: true });
    for (const id of ['a-b_c:d.e', 'A0-._:z9', 'b'.repeat(81)]) {
      const result = await callNativeTool('intent_get', { id });
      expect(result.isError).toBe(true); // absent, but validated
      expect(body(result)).toMatchObject({ ok: false, error: 'Intent not found.' });
    }
    // Malformed ids are rejected before any read.
    for (const id of ['', 'a'.repeat(82), '.lead', '-lead', '_lead', ':lead', 'a/b', 'a b', 'aé', 'a\0b']) {
      const result = await callNativeTool('intent_get', { id });
      expect(result.isError, JSON.stringify(id)).toBe(true);
      expect(text(result)).toContain('Invalid arguments for intent_get:');
    }
  });

  it('serves the CLI and the core ledger over identical persisted state', async () => {
    const one = item('alpha', 'queued');
    const two = item('beta', 'merged');
    await writeLedger(root, JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: [one, two] }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // MCP and CLI list share one envelope: { ok, ...summary, records }.
    const lastJson = () => JSON.parse(String(logSpy.mock.calls.at(-1)![0]));
    const mcpList = body(await callNativeTool('intent_list', {}));
    expect(await cmdFleetIntent(['list', '--json'])).toBe(0);
    const cliList = lastJson();
    expect(cliList).toEqual(mcpList);
    expect(mcpList.records).toEqual([one, two]);
    expect(mcpList).toMatchObject({ ok: true, present: true, sourceQuality: 'readable', countQuality: 'observed', items: 2 });

    const mcpFiltered = body(await callNativeTool('intent_list', { status: 'merged' }));
    expect(await cmdFleetIntent(['list', '--status', 'merged', '--json'])).toBe(0);
    expect(lastJson().records).toEqual(mcpFiltered.records);
    expect(mcpFiltered.records).toEqual([two]);
    expect(mcpFiltered.items).toBe(2); // the summary still counts the whole ledger

    // MCP and CLI get share one item round-trip, provenance included.
    const mcpGet = body(await callNativeTool('intent_get', { id: 'alpha' }));
    expect(await cmdFleetIntent(['get', 'alpha', '--json'])).toBe(0);
    const cliGet = lastJson();
    expect(mcpGet).toEqual({ ok: true, item: one });
    expect(cliGet.item).toEqual(mcpGet.item);
    expect(mcpGet.item.provenance).toEqual(one.provenance);

    // The core functions behind the CLI read the same rows the tools return.
    expect((await listIntents({ status: 'queued' })).items).toEqual([one]);
    expect(await getIntent('beta')).toEqual(two);

    // Lookup misses refuse on both surfaces (exit 2 / isError), never succeed empty.
    const miss = await callNativeTool('intent_get', { id: 'absent-id' });
    expect(miss.isError).toBe(true);
    expect(body(miss)).toMatchObject({ ok: false, error: 'Intent not found.' });
    logSpy.mockClear();
    expect(await cmdFleetIntent(['get', 'absent-id', '--json'])).toBe(2);
    expect(lastJson()).toMatchObject({ ok: false });
  });

  it('keeps zero-observed, missing and corrupt states distinct — no silent empty success', async () => {
    // Missing ledger: list reports absent-but-observed, get refuses as not found.
    const missing = body(await callNativeTool('intent_list', {}));
    expect(missing).toMatchObject({ ok: true, present: false, sourceQuality: 'missing', items: 0, records: [] });
    const missGet = await callNativeTool('intent_get', { id: 'alpha' });
    expect(missGet.isError).toBe(true);
    expect(body(missGet)).toMatchObject({ ok: false, error: 'Intent not found.' });

    // Empty-but-present ledger: a real zero, observed — never conflated with missing.
    await writeLedger(root, JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: [] }));
    expect(body(await callNativeTool('intent_list', {}))).toMatchObject(
      { ok: true, present: true, sourceQuality: 'readable', countQuality: 'observed', items: 0, records: [] });
    expect(body(await callNativeTool('intent_list', { status: 'queued' }))).toMatchObject(
      { ok: true, present: true, items: 0, records: [] });

    // Every corrupt or wrong-shaped body is an error on BOTH tools, never ok+empty.
    const sentinel = 'HARBOR-XYZZY-9x';
    const corrupts = [
      `{broken ${sentinel}`,
      '[]',
      '{}',
      '{"schema":"other","items":[]}',
      '{"schema":"ashlr.intent-ledger/v1"}',
      '{"schema":"ashlr.intent-ledger/v1","items":"nope"}',
      JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: [{ id: 'x' }] }),
      JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: Array(2001).fill(item('y', 'queued')) }),
    ];
    for (const bytes of corrupts) {
      await writeLedger(root, bytes);
      for (const call of [callNativeTool('intent_list', {}), callNativeTool('intent_get', { id: 'alpha' })]) {
        const result = await call;
        expect(result.isError, bytes.slice(0, 40)).toBe(true);
        expect(text(result)).not.toContain('records');
        expect(text(result)).not.toContain(sentinel);
      }
      expect(await readFile(ledgerPath(root), 'utf8')).toBe(bytes);
    }
    // Non-regular ledger paths fail too: a directory and a symlink both error.
    await rm(ledgerPath(root));
    await mkdir(ledgerPath(root));
    for (const call of [callNativeTool('intent_list', {}), callNativeTool('intent_get', { id: 'alpha' })]) {
      expect((await call).isError).toBe(true);
    }
    await rm(ledgerPath(root), { recursive: true });
    const real = join(root, 'real-ledger.json');
    await writeFile(real, JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: [item('z', 'queued')] }), { mode: 0o600 });
    await symlink(real, ledgerPath(root));
    for (const call of [callNativeTool('intent_list', {}), callNativeTool('intent_get', { id: 'z' })]) {
      expect((await call).isError).toBe(true);
    }
  });

  it('leaves the runs tree byte-identical across success, refusal and error paths', async () => {
    const one = item('alpha', 'queued');
    const two = item('beta', 'merged');
    await writeLedger(root, JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: [one, two] }));
    const before = await snapshotTree(root);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const battery = [
      callNativeTool('intent_list', {}), callNativeTool('intent_list', { status: 'queued' }),
      callNativeTool('intent_list', { status: 'closed' }), callNativeTool('intent_get', { id: 'alpha' }),
      callNativeTool('intent_get', { id: 'absent' }), callNativeTool('intent_list', { status: 'bad' }),
      callNativeTool('intent_get', { id: '../bad' }), callNativeTool('intent_list', null),
      callNativeTool('intent_get', {}), callNativeTool('intent_list', { status: 'queued', path: '/x' }),
    ];
    for (const call of battery) await call;
    await cmdFleetIntent(['list', '--json']);
    await cmdFleetIntent(['get', 'alpha', '--json']);
    await cmdFleetIntent(['get', 'absent', '--json']);
    const after = await snapshotTree(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, prev] of before) {
      expect(after.get(path)!.bytes.equals(prev.bytes), path).toBe(true);
      expect(after.get(path)!.mode).toBe(prev.mode);
    }
  });

  it('still serves persisted reads while the kill switch is engaged', async () => {
    const one = item('alpha', 'queued');
    await writeLedger(root, JSON.stringify({ schema: 'ashlr.intent-ledger/v1', items: [one] }));
    await mkdir(join(homedir(), '.ashlr'), { recursive: true });
    await writeFile(join(homedir(), '.ashlr', 'KILL'), 'kill\n', { mode: 0o600 });
    expect(body(await callNativeTool('intent_list', {}))).toMatchObject({ ok: true, records: [one] });
    expect(body(await callNativeTool('intent_get', { id: 'alpha' }))).toEqual({ ok: true, item: one });
    // Write-safety siblings stay refused — the read classification is real, not absent.
    const write = await callNativeTool('intent_link', { repo: 'ashlrai/phantom', number: 1, title: 'evidence' });
    expect(write.isError).toBe(true);
    expect(text(write)).toContain('kill switch');
  });
});
