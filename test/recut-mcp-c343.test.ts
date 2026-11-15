import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callNativeTool, nativeToolDefs } from '../src/core/mcp-native.js';
import { readLedger } from '../src/core/intent/store.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => false }));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'recut-mcp-c343-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('intent_import native tool (recut of #4673)', () => {
  it('imports a JSONL directive and returns the ledger result shape', async () => {
    const path = join(root, 'in.jsonl');
    writeFileSync(path, JSON.stringify({ title: 'Recut check directive', rq: 'RQ-RECUT-C343', source: 'test' }) + '\n');

    const result = await callNativeTool('intent_import', { paths: [path] });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({ ok: true, schema: 'ashlr.intent-ledger/v1', imported: 1, deduped: 0, items: 1 });
    expect((await readLedger()).items.map((item) => item.title)).toContain('Recut check directive');
  });

  it('is registered with append safety', () => {
    expect(nativeToolDefs().find((tool) => tool.name === 'intent_import')?.safety).toBe('append');
  });

  it('rejects an invalid call before reaching the importer', async () => {
    for (const input of [{}, { paths: [] }, { paths: ['  '] }, { paths: ['x'], extra: 1 }]) {
      expect((await callNativeTool('intent_import', input)).isError).toBe(true);
    }
  });
});
