import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { improvementDigest } from '../src/core/improve/digest.js';
import { validBacklogItem } from '../src/core/cloud/backlog.js';

it('builds bounded aggregate proposals without leaking source text and retains unknowns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-'));
  try {
    const path = join(dir, 'jobs');
    const now = Date.parse('2026-11-01T00:00:00Z');
    writeFileSync(path, Array.from({ length: 3 }, () => JSON.stringify({ event: 'queued', ts: '2026-10-31T00:00:00Z', lane: 'private' })).join('\n'));
    const gh = async (args: string[]) => ({ ok: true, stderr: '', stdout: `HTTP/2 200 OK\n\n${JSON.stringify(args[4]!.endsWith('/pulls') ? [{ merged_at: '2026-10-31T00:00:00Z', title: 'private title' }] : { workflow_runs: [{ created_at: '2026-10-31T00:00:00Z', conclusion: 'failure' }, { created_at: '2026-10-31T00:00:00Z', conclusion: 'failure' }] })}` });
    const result = await improvementDigest('ashlrai/phantom', gh, now, path);
    expect(result.errors).toEqual([]);
    expect(result.items.map(i => i.area)).toEqual(['ci', 'test-speed', 'docs-drift', 'dead-code', 'orchestration']);
    expect(result.items.every(i => validBacklogItem(i) !== null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.items.every(i => i.prompt.includes('never auto-merge'))).toBe(true);
    const missing = await improvementDigest('ashlrai/phantom', async () => ({ ok: false, stdout: '', stderr: '' }), now, join(dir, 'missing'));
    expect(missing.items).toEqual([]);
    expect(missing.errors).toHaveLength(3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
