import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { usableModelName } from '../src/core/providers/coding-cli/catalog.js';
import { readRecordedCatalogFile } from '../src/core/providers/coding-cli/recorded-catalog-file.js';

function fakeCatalog(source: string, observedAt: string): Record<string, unknown> {
  const row = (accountStatus: string, candidate: string) => ({
    intent: 'code',
    backend: 'fake-cli',
    candidate,
    accountStatus,
  });
  return {
    version: 1,
    observedAt,
    source,
    meteredEnabledByDefault: false,
    machine: { chip: 'fake-chip', ramGb: 16, diskUsedPercent: 10, diskFreeGiB: 100, note: 'fixture' },
    concurrency: { 'fake-cli': 1 },
    backends: { 'fake-cli': { billing: 'subscription', bin: null, enabledByDefault: true } },
    tiers: {
      frontier: [row('listed', 'model-listed')],
      workhorse: [row('unverified', 'model-unverified')],
      cheap: [row('rejected', 'model-rejected')],
      local: [],
    },
    cacheListings: { codex: [], claudeAliases: [], grok: [], rejectedOnAccount: [] },
  };
}

describe('readRecordedCatalogFile', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'catalog-file-676s-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('preserves recorded statuses and provenance without implying live status', async () => {
    const file = join(dir, 'a.json');
    await writeFile(file, JSON.stringify(fakeCatalog('fake-source-a', '2026-01-01T00:00:00Z')));
    const result = await readRecordedCatalogFile(file);
    expect(result.path).toBe(file);
    expect(result.provenance).toEqual({ source: 'fake-source-a', observedAt: '2026-01-01T00:00:00Z', live: false });
    const rows = [result.catalog.tiers.frontier[0], result.catalog.tiers.workhorse[0], result.catalog.tiers.cheap[0]];
    expect(rows.map((r) => r?.accountStatus)).toEqual(['listed', 'unverified', 'rejected']);
    for (const r of rows) expect(usableModelName(r)).toBeNull();
  });

  it('reads two explicit files independently with no fallback', async () => {
    const a = join(dir, 'one.json');
    const b = join(dir, 'two.json');
    await writeFile(a, JSON.stringify(fakeCatalog('src-one', '2026-02-01T00:00:00Z')));
    await writeFile(b, JSON.stringify(fakeCatalog('src-two', '2026-03-01T00:00:00Z')));
    const [ra, rb] = await Promise.all([readRecordedCatalogFile(a), readRecordedCatalogFile(b)]);
    expect([ra.provenance.source, rb.provenance.source]).toEqual(['src-one', 'src-two']);
    expect([ra.path, rb.path]).toEqual([a, b]);
  });

  it('refuses blank paths', async () => {
    await expect(readRecordedCatalogFile('')).rejects.toThrow(/explicit non-empty path/);
    await expect(readRecordedCatalogFile('   ')).rejects.toThrow(/explicit non-empty path/);
  });

  it('propagates a missing file instead of falling back', async () => {
    await expect(readRecordedCatalogFile(join(dir, 'absent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('propagates malformed JSON and invalid catalogs', async () => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{not json');
    await expect(readRecordedCatalogFile(bad)).rejects.toThrow(/invalid JSON/);
    const invalid = join(dir, 'invalid.json');
    const doc = fakeCatalog('s', '2026-01-01T00:00:00Z');
    (doc['tiers'] as Record<string, Array<Record<string, unknown>>>)['frontier']![0]!['accountStatus'] = 'live';
    await writeFile(invalid, JSON.stringify(doc));
    await expect(readRecordedCatalogFile(invalid)).rejects.toThrow(/accountStatus/);
  });
});
