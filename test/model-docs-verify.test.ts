import { describe, expect, it, vi } from 'vitest';
import { verifyModelDocs } from '../src/core/fleet/model-docs-verify.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('model documentation verification', () => {
  it('reports confirmed, not-found and unknown from provider responses without credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.credentials).toBe('omit');
      expect(init?.redirect).toBe('error');
      if (String(input).includes('claude.com')) throw new Error('offline');
      return new Response('gpt-6-astra gpt-6.1-sol-extra', { status: 200 });
    });
    const dir = await mkdtemp(join(tmpdir(), 'model-docs-'));
    const registryPath = join(dir, 'registry.json');
    await writeFile(registryPath, JSON.stringify(['gpt-6-astra', 'gpt-6.1-sol', 'claude-opus-5-5'].map(id => ({
      id, provider: id.startsWith('gpt') ? 'openai' : 'anthropic',
      status: 'verified', verified_at: '2026-11-05', verified_source: id.startsWith('gpt') ? 'https://developers.openai.com/api/docs/models' : 'https://platform.claude.com/docs/en/models/overview',
    }))));
    const rows = await verifyModelDocs({ registryPath, fetch: fetcher, now: () => new Date('2026-11-09T00:00:00Z') }).finally(() => rm(dir, { recursive: true, force: true }));
    expect(rows.find(row => row.id === 'gpt-6-astra')?.status).toBe('confirmed');
    expect(rows.find(row => row.id === 'gpt-6.1-sol')?.status).toBe('not-found');
    expect(rows.find(row => row.id === 'claude-opus-5-5')?.status).toBe('unknown');
    expect(rows.every(row => row.checkedAt === '2026-11-09T00:00:00.000Z' && row.sourceUrl?.startsWith('https://'))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
