import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { callNativeTool } from '../src/core/mcp-native.js';

it('reports an unavailable needs ledger through the native tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recut-needs-'));
  const previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = root;
  try {
    const itemId = 'nm-123456abcdef';
    const result = await callNativeTool('phantom_fleet_needs_wait', { itemId, timeoutMs: 10 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ itemId, status: 'unavailable' });
  } finally {
    if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
    else process.env.ASHLR_RUNS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
