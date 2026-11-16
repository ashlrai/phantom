import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { callNativeTool } from '../src/core/mcp-native.js';

it('refuses a symlinked needs ledger through the native wait tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recut-needs-wait-'));
  const previous = process.env.ASHLR_RUNS_DIR;
  try {
    writeFileSync(join(root, 'target'), '- [x] resolved nm-0123456789ab timestamp\n');
    symlinkSync(join(root, 'target'), join(root, 'NEEDS-MASON.md'));
    process.env.ASHLR_RUNS_DIR = root;
    const response = await callNativeTool('phantom_fleet_needs_wait', { itemId: 'nm-0123456789ab', timeoutMs: 10 });
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0]!.text)).toEqual({ itemId: 'nm-0123456789ab', status: 'unavailable' });
  } finally {
    if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
    else process.env.ASHLR_RUNS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
