import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { callNativeTool } from '../src/core/mcp-native.js';
import { readLedger } from '../src/core/intent/store.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/core/sandbox/policy.js', () => ({ killSwitchOn: () => false }));

const root = mkdtempSync(join(tmpdir(), 'intent-recut-'));
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('imports a directive through the native tool into the actual ledger', async () => {
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  const path = join(root, 'intent.jsonl');
  writeFileSync(path, JSON.stringify({ title: 'Recover this directive', source: 'test' }) + '\n');

  const result = await callNativeTool('intent_import', { paths: [path] });
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true, imported: 1 });
  expect((await readLedger()).items.map((item) => item.title)).toContain('Recover this directive');
});
