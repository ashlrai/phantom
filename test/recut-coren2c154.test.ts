import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { callNativeTool } from '../src/core/mcp-native.js';

it('waits on an open item through the native tool without changing its ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recut-coren2c154-'));
  const previous = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = root;
  try {
    const file = join(root, 'NEEDS-MASON.md');
    const content = '- [ ] fake item\n';
    writeFileSync(file, content);
    const { createHash } = await import('node:crypto');
    const itemId = `nm-${createHash('sha256').update('fake item').digest('hex').slice(0, 12)}`;
    const result = await callNativeTool('phantom_fleet_needs_wait', { itemId, timeoutMs: 5, pollMs: 100 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ itemId, status: 'timeout' });
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(file, 'utf8')).toBe(content);
  } finally {
    if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
    else process.env.ASHLR_RUNS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
