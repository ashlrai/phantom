import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDailyTtgS, loadExistingMetrics, saveMetrics, type CiMetrics } from '../src/core/ci-metrics.js';
import { cmdCiMetrics } from '../src/cli/ci-metrics.js';
import { FLEET_REPOS } from '../src/core/portfolio/restock-lint.js';
import { ashlrHome } from '../src/core/cloud/store.js';

// Fixture generator: maps repos (full ashlr/... keys) to workflow_runs arrays.
function fixture(
  data: Record<string, { workflow_runs: Array<{ id: number; name: string; event: string; conclusion: string | null; status: string; created_at: string; completed_at: string | null; head_branch: string }> }>,
): (args: string[]) => Promise<string> {
  return async (args: string[]) => {
    const path = (args as string[])[1] ?? '';
    const repoKey = path.split('repos/')[1]?.split('/actions')[0] ?? '';
    if (path.includes('actions/runs?')) {
      const runData = data[repoKey];
      if (!runData) return JSON.stringify({ workflow_runs: [] });
      return JSON.stringify(runData);
    }
    throw new Error('Unexpected request');
  };
}

// Fixture with one red-then-green pair: 17 min 20 sec = 1040 seconds.
function phantomFixture(): Record<string, { workflow_runs: Array<{ id: number; name: string; event: string; conclusion: string | null; status: string; created_at: string; completed_at: string | null; head_branch: string }> }> {
  const redTs = '2026-01-01T10:00:00Z';
  const greenTs = '2026-01-01T10:18:20Z';
  return {
    'ashlrai/phantom': { workflow_runs: [
      { id: 100, name: 'CI', event: 'schedule', conclusion: 'failure', status: 'completed', created_at: redTs, completed_at: redTs.replace('10:00', '10:01'), head_branch: 'master' },
      { id: 200, name: 'CI', event: 'schedule', conclusion: 'success', status: 'completed', created_at: greenTs, completed_at: greenTs, head_branch: 'master' },
    ]},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (process.env as Record<string, string | undefined>)['ASHLR_HOME'];
});

describe('computeDailyTtgS', () => {
  it('computes daily_ttg_s from a red-then-green pair (fixture)', async () => {
    const gh = fixture(phantomFixture());
    const result = await computeDailyTtgS(gh);

    const phantom = result['ashlrai/phantom'];
    expect(phantom).toBeDefined();
    // Red: 10:01:00, Green: 10:18:20 → 17*60+20 = 1040 seconds.
    expect(phantom!.daily_ttg_s).toBe(1040);
    expect(phantom!.lastRedRunId).toBe(100);
    expect(phantom!.lastGreenRunId).toBe(200);
  });

  it('handles repos with only green runs (no red→green pair)', async () => {
    const gh = fixture(phantomFixture());
    const result = await computeDailyTtgS(gh);

    // Check all FLEET_REPOS are present in the result.
    const allRepos = new Set(FLEET_REPOS.map(r => `ashlrai/${r}`));
    for (const repo of allRepos) {
      expect(result[repo]).toBeDefined();
    }
    // Phantom has a pair; other repos (not in phantomFixture) should have null values.
    const cloudflare = result['ashlrai/phantom-secrets']; // next repo in FLEET_REPOS
    expect(cloudflare!.daily_ttg_s).toBeNull();
    expect(cloudflare!.lastRedRunId).toBeNull();
    expect(cloudflare!.lastGreenRunId).toBeNull();
  });

  it('matches the next green run after a red run (ordered by completed_at)', async () => {
    // Multiple green runs after one red run.
    const data = {
      'ashlrai/phantom': { workflow_runs: [
        { id: 100, name: 'CI', event: 'schedule', conclusion: 'failure', status: 'completed', created_at: '2026-01-01T10:00:00Z', completed_at: '2026-01-01T10:01:00Z', head_branch: 'master' },
        // First green after red (used for the pair).
        { id: 200, name: 'CI', event: 'schedule', conclusion: 'success', status: 'completed', created_at: '2026-01-01T10:18:20Z', completed_at: '2026-01-01T10:18:20Z', head_branch: 'master' },
        // Later green (no subsequent red, should not affect the pair).
        { id: 400, name: 'CI', event: 'schedule', conclusion: 'success', status: 'completed', created_at: '2026-01-01T12:00:00Z', completed_at: '2026-01-01T12:00:00Z', head_branch: 'master' },
      ]},
    };
    const gh = fixture(data);
    const result = await computeDailyTtgS(gh);

    const phantom = result['ashlrai/phantom'];
    // Should compute the pair from red (100) to first green (200): 1040s.
    expect(phantom!.daily_ttg_s).toBe(1040);
    expect(phantom!.lastRedRunId).toBe(100);
    expect(phantom!.lastGreenRunId).toBe(200);
  });

  it('handles cancelled/skipped runs (not filtered — only conclusion check matters)', async () => {
    const data = {
      'ashlrai/phantom': { workflow_runs: [
        { id: 100, name: 'CI', event: 'schedule', conclusion: 'failure', status: 'completed', created_at: '2026-01-01T10:00:00Z', completed_at: '2026-01-01T10:01:00Z', head_branch: 'master' },
        { id: 150, name: 'CI', event: 'schedule', conclusion: 'cancelled', status: 'completed', created_at: '2026-01-01T10:10:00Z', completed_at: '2026-01-01T10:10:00Z', head_branch: 'master' },
        { id: 200, name: 'CI', event: 'schedule', conclusion: 'success', status: 'completed', created_at: '2026-01-01T10:18:20Z', completed_at: '2026-01-01T10:18:20Z', head_branch: 'master' },
      ]},
    };
    const gh = fixture(data);
    const result = await computeDailyTtgS(gh);

    const phantom = result['ashlrai/phantom'];
    expect(phantom!.daily_ttg_s).toBe(1040);
  });

  it('uses completed_at when available, falls back to created_at when null', async () => {
    // Red with no completed_at (falls back to created_at = 10:00:00).
    // Green with completed_at = 10:18:20. Diff: 18min 20sec = 1100s.
    const data = {
      'ashlrai/phantom': { workflow_runs: [
        { id: 100, name: 'CI', event: 'schedule', conclusion: 'failure', status: 'completed', created_at: '2026-01-01T10:00:00Z', completed_at: null, head_branch: 'master' },
        { id: 200, name: 'CI', event: 'schedule', conclusion: 'success', status: 'completed', created_at: '2026-01-01T10:18:20Z', completed_at: '2026-01-01T10:18:20Z', head_branch: 'master' },
      ]},
    };
    const gh = fixture(data);
    const result = await computeDailyTtgS(gh);

    const phantom = result['ashlrai/phantom'];
    // 18*60+20 = 1100 seconds.
    expect(phantom!.daily_ttg_s).toBe(1100);
  });

  it('handles empty repos (no runs) gracefully', async () => {
    const gh = fixture({} as Record<string, { workflow_runs: Array<{ id: number }> }>);
    const result = await computeDailyTtgS(gh);

    for (const repo of FLEET_REPOS) {
      const key = `ashlrai/${repo}`;
      expect(result[key]).toBeDefined();
      expect(result[key].daily_ttg_s).toBeNull();
      expect(result[key].lastRedRunId).toBeNull();
      expect(result[key].lastGreenRunId).toBeNull();
    }
  });
});

describe('loadExistingMetrics / saveMetrics', () => {
  let root: string;
  let metrics: CiMetrics;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-metrics-'));
    vi.stubEnv('ASHLR_HOME', join(root, 'nested', 'ashlr'));
    metrics = {
      v: 1, generatedAt: '2026-01-01T00:00:00Z', target_s: 7200,
      repos: {
        'ashlrai/phantom': { repo: 'ashlrai/phantom', daily_ttg_s: 1040, lastRedRunId: 100, lastGreenRunId: 200 },
        'ashlrai/unknown': { repo: 'ashlrai/unknown', daily_ttg_s: null, lastRedRunId: null, lastGreenRunId: null },
      },
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('validates the data shape: v, target_s, and repos per repo', async () => {
    const metrics: CiMetrics = {
      v: 1,
      generatedAt: '2026-01-01T00:00:00Z',
      target_s: 7200,
      repos: {
        'ashlrai/phantom': { repo: 'ashlrai/phantom', daily_ttg_s: 1040, lastRedRunId: 100, lastGreenRunId: 200 },
      },
    };
    // Verify the data shape is valid.
    expect(metrics.v).toBe(1);
    expect(metrics.target_s).toBe(7200);
    expect(typeof metrics.repos).toBe('object');
    expect(Object.keys(metrics.repos).length).toBe(1);
    const entry = metrics.repos['ashlrai/phantom'];
    expect(entry.daily_ttg_s).toBe(1040);
    expect(entry.lastRedRunId).toBe(100);
    expect(entry.lastGreenRunId).toBe(200);
  });

  it('round trips measured and unknown entries into a previously absent home', async () => {
    expect(await loadExistingMetrics()).toBeNull();
    const path = await saveMetrics(metrics);
    expect(path).toBe(join(ashlrHome(), 'ci-metrics.json'));
    expect(await loadExistingMetrics()).toEqual(metrics);
    expect(existsSync(join(ashlrHome(), 'ci-metrics'))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['version', { v: 2 }], ['timestamp', { generatedAt: 'invalid' }],
    ['target', { target_s: -1 }], ['array', { repos: [] }], ['null repos', { repos: null }],
    ['null entry', { repos: { 'ashlrai/phantom': null } }],
    ['missing fields', { repos: { 'ashlrai/phantom': {} } }],
  ])('refuses an invalid %s', async (_name, patch) => {
    const path = await saveMetrics(metrics);
    writeFileSync(path, JSON.stringify({ ...metrics, ...patch }));
    expect(await loadExistingMetrics()).toBeNull();
  });

  it.each([
    { repo: 'other/repo' }, { daily_ttg_s: -1 }, { daily_ttg_s: '1040' },
    { lastRedRunId: 1.5 }, { lastGreenRunId: 0 },
  ])('refuses malformed entry fields %j', async patch => {
    const path = await saveMetrics(metrics);
    Object.assign(metrics.repos['ashlrai/phantom'], patch);
    writeFileSync(path, JSON.stringify(metrics));
    expect(await loadExistingMetrics()).toBeNull();
  });

  it('refuses corrupt and oversized files', async () => {
    const path = await saveMetrics(metrics);
    writeFileSync(path, '{broken');
    expect(await loadExistingMetrics()).toBeNull();
    writeFileSync(path, ' '.repeat(1024 * 1024) + JSON.stringify(metrics));
    expect(await loadExistingMetrics()).toBeNull();
  });

  it('replaces a target symlink without changing its destination', async () => {
    mkdirSync(ashlrHome(), { recursive: true });
    const other = join(root, 'other.json');
    writeFileSync(other, 'untouched');
    symlinkSync(other, join(ashlrHome(), 'ci-metrics.json'));
    expect(await loadExistingMetrics()).toBeNull();
    await saveMetrics(metrics);
    expect(readFileSync(other, 'utf8')).toBe('untouched');
    expect(await loadExistingMetrics()).toEqual(metrics);
  });

  it('surfaces write failures without damaging the previous snapshot', async () => {
    const path = await saveMetrics(metrics);
    const before = readFileSync(path, 'utf8');
    vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('serialization failed'); });
    await expect(saveMetrics(metrics)).rejects.toThrow('serialization failed');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('CLI replaces a cached unknown pair when the same red run turns green', async () => {
    metrics.repos['ashlrai/phantom'].daily_ttg_s = null;
    metrics.repos['ashlrai/phantom'].lastGreenRunId = null;
    await saveMetrics(metrics);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdCiMetrics(['--json'], { gh: fixture(phantomFixture()) })).toBe(0);
    expect((await loadExistingMetrics())?.repos['ashlrai/phantom'].daily_ttg_s).toBe(1040);
    expect((await loadExistingMetrics())?.repos['ashlrai/phantom'].lastGreenRunId).toBe(200);
  });

  it('CLI preserves a saved pair when the next read has no green run', async () => {
    await saveMetrics(metrics);
    const data = phantomFixture();
    data['ashlrai/phantom'].workflow_runs.pop();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdCiMetrics(['--json'], { gh: fixture(data) })).toBe(0);
    expect((await loadExistingMetrics())?.repos['ashlrai/phantom']).toEqual(metrics.repos['ashlrai/phantom']);
  });
});

describe('cmdCiMetrics CLI', () => {
  it('returns usage on --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdCiMetrics(['--help'])).toBe(0);
    expect(log.mock.calls[0]![0]).toMatch(/usage:/i);
  });

  it('rejects unknown args', async () => {
    expect(await cmdCiMetrics(['--bogus'])).toBe(2);
  });
});
