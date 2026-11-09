import { describe, expect, it } from 'vitest';
import { formatReleaseStatus, getReleaseStatus } from '../src/core/release/status.js';

describe('release status', () => {
  it('reports GitHub assets, default branch commits and the updater response', async () => {
    const calls: string[] = [];
    const report = await getReleaseStatus({ repos: ['phantom', 'locus'], feed: async () => 404, read: async (endpoint) => {
      calls.push(endpoint);
      const phantom = endpoint.includes('/phantom');
      if (endpoint.endsWith('/tags?per_page=1')) return [{ name: 'v1.0' }];
      if (endpoint.includes('/releases/tags/')) return { assets: phantom ? [] : [{ name: 'bundle' }] };
      if (endpoint.includes('/compare/')) return { ahead_by: phantom ? 3 : 0 };
      return { default_branch: 'main' };
    } });
    expect(report.repos).toEqual([
      { repo: 'ashlrai/phantom', defaultBranch: 'main', latestTag: 'v1.0', hasAssets: false, unreleasedCommits: 3, updaterHttpStatus: 404 },
      { repo: 'ashlrai/locus', defaultBranch: 'main', latestTag: 'v1.0', hasAssets: true, unreleasedCommits: 0, updaterHttpStatus: null },
    ]);
    expect(calls).toContain('repos/ashlrai/locus/compare/v1.0...main');
    const table = formatReleaseStatus(report);
    expect(table).toContain('Unreleased commits');
    expect(table).toContain('404');
    expect(table).toContain('No');
  });
  it('keeps failed reads unknown and accepts a healthy feed', async () => {
    const report = await getReleaseStatus({ repos: ['phantom'], feed: async () => 200, read: async () => { throw new Error('offline'); } });
    expect(report.repos[0]).toMatchObject({ latestTag: null, hasAssets: null, unreleasedCommits: null, updaterHttpStatus: 200 });
    expect(formatReleaseStatus(report)).toContain('Unknown');
  });
});
