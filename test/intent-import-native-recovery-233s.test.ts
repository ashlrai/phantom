import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolDefs } from '../src/core/mcp-native.js';
import { intentLedgerPath, readLedger } from '../src/core/intent/store.js';

// Recovered from PR #4491 commit 83f83a7315dba1ed39836c9beb0d9d5868ec999c
// (test/intent-import-native-preservation-09spz1.test.ts) against the current
// native MCP dispatch. The importer spy wraps the real module so malformed
// calls can be proven never to reach importIntentFiles.
const gate = vi.hoisted(() => ({ audit: vi.fn(), importFiles: vi.fn() }));
vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/config.js')>()),
  loadConfig: () => ({}),
}));
vi.mock('../src/core/sandbox/audit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/sandbox/audit.js')>()),
  audit: gate.audit,
}));
vi.mock('../src/core/intent/import.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/intent/import.js')>();
  return {
    ...mod,
    importIntentFiles: (...args: Parameters<typeof mod.importIntentFiles>) => {
      gate.importFiles(...args);
      return mod.importIntentFiles(...args);
    },
  };
});

const name = 'intent_import';
let root: string;
let first: string;
let second: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-intent-native-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  gate.audit.mockClear();
  gate.importFiles.mockClear();
  first = join(root, 'first.jsonl');
  second = join(root, 'second.jsonl');
  writeFileSync(first, JSON.stringify({ title: 'First directive', rq: 'RQ-EXAMPLE-1', source: 'source one' }) + '\n' + JSON.stringify({ title: 'Unrelated directive', source: 'source one' }) + '\n');
  writeFileSync(second, JSON.stringify({ title: 'Same request', rq: 'RQ-EXAMPLE-1', source: 'source two' }) + '\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('native intent import recovery', () => {
  it('advertises the original schema and append safety', () => {
    const schema = { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['paths'], additionalProperties: false };
    expect(listNativeTools().find((tool) => tool.name === name)?.inputSchema).toEqual(schema);
    expect(nativeToolDefs().find((tool) => tool.name === name)).toMatchObject({ inputSchema: schema, safety: 'append' });
  });

  it('imports and deduplicates across sources and repeated calls', async () => {
    const result = await callNativeTool(name, { paths: [first, second] });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, schema: 'ashlr.intent-ledger/v1', imported: 2, deduped: 1, items: 2 });
    const ledger = await readLedger();
    expect(ledger.items).toHaveLength(2);
    expect(ledger.items.find((item) => item.rq.includes('RQ-EXAMPLE-1'))?.provenance.map((row) => row.source)).toEqual(['source one', 'source two']);
    expect(ledger.items.some((item) => item.title === 'Unrelated directive')).toBe(true);
    const repeat = await callNativeTool(name, { paths: [first, second] });
    expect(JSON.parse(repeat.content[0].text)).toEqual({ ok: true, schema: 'ashlr.intent-ledger/v1', imported: 0, deduped: 3, items: 2 });
    const repeatedLedger = await readLedger();
    expect(repeatedLedger.items.map((item) => item.id)).toEqual(ledger.items.map((item) => item.id));
    expect(repeatedLedger.items.map((item) => item.provenance)).toEqual(ledger.items.map((item) => item.provenance));
    expect(JSON.stringify(gate.audit.mock.calls)).not.toContain(first);
  });

  it('leaves the ledger bytes unchanged if a later file is invalid', async () => {
    await callNativeTool(name, { paths: [first] });
    const before = readFileSync(intentLedgerPath());
    writeFileSync(second, '{invalid json');
    expect((await callNativeTool(name, { paths: [first, second] })).isError).toBe(true);
    expect(readFileSync(intentLedgerPath())).toEqual(before);
  });

  it('rejects malformed arguments before invoking the importer', async () => {
    for (const input of [null, [], 'bad', {}, { paths: [] }, { paths: [first, 42] }, { paths: ['  '] }, { paths: [first], extra: true }, { paths: first }]) {
      expect((await callNativeTool(name, input)).isError).toBe(true);
    }
    expect(gate.importFiles).not.toHaveBeenCalled();
  });

  it('refuses writes while KILL is on', async () => {
    await callNativeTool(name, { paths: [first] });
    const before = readFileSync(intentLedgerPath());
    mkdirSync(join(root, '.ashlr'), { recursive: true });
    writeFileSync(join(root, '.ashlr', 'KILL'), '');
    expect((await callNativeTool(name, { paths: [second] })).isError).toBe(true);
    expect(gate.importFiles).toHaveBeenCalledTimes(1);
    expect(readFileSync(intentLedgerPath())).toEqual(before);
  });
});
