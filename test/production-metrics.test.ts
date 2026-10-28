import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { collectProduction, type ProductionReads } from '../src/core/metrics/production.js';
import { cmdMetrics } from '../src/cli/metrics.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/production-metrics/cohort.json', import.meta.url), 'utf8'));
const commit = 'a'.repeat(40);
function harness(options: { cargo?: boolean; missing?: boolean; registryError?: boolean; releaseError?: boolean; compareError?: boolean } = {}) {
  const github = vi.fn(async (path: string, paginate?: boolean): Promise<unknown> => {
    if (path.endsWith('/pulls?state=all&per_page=100')) { expect(paginate).toBe(true); return fixture.pulls; }
    if (path.endsWith('/releases?per_page=100')) {
      if (options.releaseError) throw new Error('offline');
      return fixture.releases;
    }
    if (path.endsWith('/commits/v1.0.0')) return { sha: commit };
    if (path.includes('/compare/')) {
      if (options.compareError) throw new Error('offline');
      return { status: path.includes('merge4') ? 'diverged' : 'ahead' };
    }
    if (path.includes(`/contents/package.json?ref=${commit}`)) return options.cargo ? null
      : { encoding: 'base64', content: Buffer.from(JSON.stringify(fixture.npm)).toString('base64') };
    if (path.includes(`/contents/Cargo.toml?ref=${commit}`)) return options.cargo
      ? { encoding: 'base64', content: Buffer.from(fixture.cargo).toString('base64') } : null;
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  const registry = vi.fn(async (url: string): Promise<unknown> => {
    expect(url).toBe(options.cargo ? 'https://crates.io/api/v1/crates/fixture/1.0.0'
      : 'https://registry.npmjs.org/%40example%2Ffixture/1.0.0');
    if (options.registryError) throw new Error('offline');
    return options.missing ? null : options.cargo ? fixture.crate : fixture.npm;
  });
  return { github, registry } satisfies ProductionReads;
}

describe('production metrics with offline fixtures', () => {
  it('counts every bridge PR once by repo and lane, with ancestry and exact version evidence', async () => {
    const reads = harness();
    const report = await collectProduction('example/repo', reads);
    expect(report.groups).toEqual([
      { repo: 'example/repo', lane: 'claude', total: 1, merged: 1, released: 1, published: 1, releaseUnknown: 0, publicationUnknown: 0, productionShare: 1 },
      { repo: 'example/repo', lane: 'codex', total: 3, merged: 2, released: 1, published: 1, releaseUnknown: 0, publicationUnknown: 0, productionShare: 1 / 3 },
    ]);
    expect(report.rows.find(row => row.number === 4)?.released).toBe('no');
    expect(reads.registry).toHaveBeenCalledTimes(1);
    expect(reads.github.mock.calls.filter(([path]) => path.includes('/commits/'))).toHaveLength(1);
  });
  it('supports crates and lane filtering', async () => {
    const report = await collectProduction('example/repo', harness({ cargo: true }), 'bridge', 'claude');
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].productionShare).toBe(1);
  });
  it('distinguishes absent versions from unavailable registry evidence', async () => {
    const missing = await collectProduction('example/repo', harness({ missing: true }));
    const unavailable = await collectProduction('example/repo', harness({ registryError: true }));
    expect(missing.rows[0]).toMatchObject({ released: 'yes', published: 'no' });
    expect(unavailable.rows[0]).toMatchObject({ released: 'yes', published: 'unknown' });
    expect(unavailable.groups[1].publicationUnknown).toBe(1);
  });
  it.each([{ releaseError: true }, { compareError: true }])('never calls registry or reports success with unavailable release inclusion: %j', async options => {
    const reads = harness(options);
    const report = await collectProduction('example/repo', reads);
    expect(report.rows[0]).toMatchObject({ released: 'unknown', published: 'unknown' });
    expect(reads.registry).not.toHaveBeenCalled();
  });
  it('rejects mismatched registry versions and yanked crates as positive evidence', async () => {
    const reads = harness();
    reads.registry.mockResolvedValue({ name: fixture.npm.name, version: '9.9.9' });
    expect((await collectProduction('example/repo', reads)).rows[0].published).toBe('unknown');
    const cargo = harness({ cargo: true });
    cargo.registry.mockResolvedValue({ version: { ...fixture.crate.version, yanked: true } });
    expect((await collectProduction('example/repo', cargo)).groups[0].published).toBe(0);
  });
  it('reports unknown when no supported public root manifest exists', async () => {
    const reads = harness();
    const original = reads.github.getMockImplementation()!;
    reads.github.mockImplementation((path, paginate) => path.includes('/contents/') ? Promise.resolve(null) : original(path, paginate));
    expect((await collectProduction('example/repo', reads)).rows[0].published).toBe('unknown');
  });
  it('emits versioned JSON for multiple repos and validates arguments before reads', async () => {
    const reads = harness();
    const out = vi.fn();
    expect(await cmdMetrics(['prod', '--repo', 'example/two', '--repo', 'example/repo', '--lane', 'codex', '--json'], reads, out)).toBe(0);
    const result = JSON.parse(out.mock.calls[0][0]);
    expect(result.schemaVersion).toBe(1);
    expect(result.reports.map((report: { repo: string }) => report.repo)).toEqual(['example/repo', 'example/two']);
    reads.github.mockClear();
    expect(await cmdMetrics(['prod', '--repo', '../bad'], reads, out, vi.fn())).toBe(2);
    expect(reads.github).not.toHaveBeenCalled();
  });
  it('keeps a merged PR unreleased when no release exists', async () => {
    const reads = harness();
    const original = reads.github.getMockImplementation()!;
    reads.github.mockImplementation((path, paginate) => path.includes('/releases?') ? Promise.resolve([[]]) : original(path, paginate));
    const report = await collectProduction('example/repo', reads);
    expect(report.rows[0]).toMatchObject({ merged: true, released: 'no', published: 'no' });
    expect(reads.registry).not.toHaveBeenCalled();
  });
  it('accepts identical commits and rejects behind or diverged release ancestry', async () => {
    for (const status of ['identical', 'behind', 'diverged']) {
      const reads = harness();
      const original = reads.github.getMockImplementation()!;
      reads.github.mockImplementation((path, paginate) => path.includes('/compare/') ? Promise.resolve({ status }) : original(path, paginate));
      expect((await collectProduction('example/repo', reads)).rows[0].released).toBe(status === 'identical' ? 'yes' : 'no');
    }
  });
  it('supports an explicit bridge label and preserves ambiguous lanes as unknown', async () => {
    const reads = harness();
    const original = reads.github.getMockImplementation()!;
    reads.github.mockImplementation((path, paginate) => path.includes('/pulls?') ? Promise.resolve([[{
      number: 99, head: { ref: 'feature' }, labels: [{ name: 'router-bridge' }, { name: 'lane:a' }, { name: 'lane:b' }], merged_at: null,
    }]]) : original(path, paginate));
    expect((await collectProduction('example/repo', reads)).groups).toEqual([]);
    expect((await collectProduction('example/repo', reads, 'router-bridge')).groups[0]).toMatchObject({ lane: 'unknown', total: 1, productionShare: 0 });
  });
  it('does not infer publication from a private manifest', async () => {
    const reads = harness();
    const original = reads.github.getMockImplementation()!;
    reads.github.mockImplementation((path, paginate) => path.includes('/contents/package.json') ? Promise.resolve({
      encoding: 'base64', content: Buffer.from(JSON.stringify({ ...fixture.npm, private: true })).toString('base64'),
    }) : original(path, paginate));
    expect((await collectProduction('example/repo', reads)).rows[0].published).toBe('unknown');
    expect(reads.registry).not.toHaveBeenCalled();
  });
  it('counts a PR once across several release tags', async () => {
    const reads = harness();
    const original = reads.github.getMockImplementation()!;
    reads.github.mockImplementation((path, paginate) => {
      if (path.includes('/releases?')) return Promise.resolve([[{ tag_name: 'v1.0.0', draft: false, prerelease: false }, { tag_name: 'v1.0.1', draft: false, prerelease: false }]]);
      if (path.endsWith('/commits/v1.0.1')) return Promise.resolve({ sha: commit });
      return original(path, paginate);
    });
    const report = await collectProduction('example/repo', reads);
    expect(report.rows[0].releases).toEqual(['v1.0.0', 'v1.0.1']);
    expect(report.groups[1].published).toBe(1);
  });
  it('preserves unknown evidence for a tag that cannot be resolved', async () => {
    const reads = harness();
    const original = reads.github.getMockImplementation()!;
    reads.github.mockImplementation((path, paginate) => path.includes('/commits/') ? Promise.resolve(null) : original(path, paginate));
    expect((await collectProduction('example/repo', reads)).rows[0].released).toBe('unknown');
    expect(reads.registry).not.toHaveBeenCalled();
  });
  it('infers the current repository through a read-only GitHub request', async () => {
    const reads = harness();
    const original = reads.github.getMockImplementation()!;
    reads.github.mockImplementation((path, paginate) => path === 'repos/{owner}/{repo}'
      ? Promise.resolve({ full_name: 'example/repo' }) : original(path, paginate));
    const out = vi.fn();
    expect(await cmdMetrics(['prod', '--json'], reads, out, vi.fn())).toBe(0);
    expect(JSON.parse(out.mock.calls[0][0]).reports[0].repo).toBe('example/repo');
  });
  it('fails closed without printing upstream errors', async () => {
    const err = vi.fn();
    expect(await cmdMetrics(['prod', '--repo', 'example/repo'], { github: async () => { throw new Error('private diagnostic'); } }, vi.fn(), err)).toBe(1);
    expect(err.mock.calls.flat().join('')).not.toContain('private diagnostic');
  });
});
