import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { callNativeTool } from '../src/core/mcp-native.js';

it('reports a resolved item through the native tool and rejects extra arguments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recut-needs-wait-'));
  const prior = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = root;
  try {
    const itemId = 'nm-123456abcdef';
    writeFileSync(join(root, 'NEEDS-MASON.md'), `- [x] resolved ${itemId} timestamp\n`);
    const result = await callNativeTool('phantom_fleet_needs_wait', { itemId, timeoutMs: 10 });
    expect(JSON.parse(result.content[0]!.text)).toEqual({ itemId, status: 'resolved' });
    expect((await callNativeTool('phantom_fleet_needs_wait', { itemId, timeoutMs: 10, extra: true })).isError).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.ASHLR_RUNS_DIR;
    else process.env.ASHLR_RUNS_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
