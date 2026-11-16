import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetReleaseLag } from '../src/cli/fleet-release-lag.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { narrowReleaseLag, readReleaseLag, releaseLagLine, RELEASE_LAG_SCHEMA } from '../src/core/release/lag.js';

// Recorded fixture objects inlined from the original release-lag suite (PR #4373);
// values are plainly fake and no network or real HOME is touched.
const RELEASE = {
  tag_name: 'v3.31.2', draft: false, prerelease: false,
  published_at: '2026-11-09T08:12:44Z',
  html_url: 'https://github.com/ashlrai/phantom/releases/tag/v3.31.2',
  assets: [
    { name: 'latest.json' }, { name: 'manifest.json' }, { name: 'manifest.json.sig' },
    { name: 'ashlr-phantom-3.31.2.tgz' }, { name: 'ashlr-phantom-3.31.2.tgz.sig' },
    { name: 'Phantom_3.31.2_aarch64.app.tar.gz' }, { name: 'Phantom_3.31.2_aarch64.app.tar.gz.sig' },
  ],
};
const SEARCH = { total_count: 12, incomplete_results: false, items: [{ number: 4364 }] };

const now = () => new Date('2026-11-09T10:00:00.000Z');
const gh = (calls: string[] = [], release: unknown = RELEASE, search: unknown = SEARCH) => async (argv: string[]) => {
  calls.push(argv[1]!);
  if (argv[1]!.startsWith('repos/')) return { code: 0, stdout: JSON.stringify(release) };
  return { code: 0, stdout: JSON.stringify(search) };
};
const down = async () => ({ code: 1, stdout: '' });

afterEach(() => vi.restoreAllMocks());

describe('release lag reader', () => {
  it('reads every number from recorded fixtures', async () => {
    const calls: string[] = [];
    const lag = await readReleaseLag({ run: gh(calls), feedStatus: async () => 200, installedVersion: async () => '3.31.1', now });
    expect(lag).toEqual({
      schema: RELEASE_LAG_SCHEMA, checkedAt: '2026-11-09T10:00:00.000Z', latestTag: 'v3.31.2', assetCount: 7,
      feedOk: true, installedVersion: '3.31.1', mergedSince: 12,
    });
    expect(decodeURIComponent(calls[1]!)).toContain('merged:>2026-11-09T08:12:44Z');
    expect(releaseLagLine(lag)).toBe('Release · latest v3.31.2 · assets 7 · feed 200 · installed 3.31.1 · merged since 12');
    expect(narrowReleaseLag(JSON.parse(JSON.stringify(lag)))).toEqual(lag);
  });

  it('reports an empty published release as zero assets, not unknown', async () => {
    const lag = await readReleaseLag({
      run: gh([], { ...RELEASE, assets: [] }), feedStatus: async () => 200, installedVersion: async () => '3.31.1', now,
    });
    expect(lag).toMatchObject({ latestTag: 'v3.31.2', assetCount: 0, mergedSince: 12 });
  });

  it('prints "unknown" for anything it cannot read, never a guess', async () => {
    const lag = await readReleaseLag({ run: down, feedStatus: async () => null, installedVersion: async () => null, now });
    expect(lag).toMatchObject({ latestTag: 'unknown', assetCount: 'unknown', feedOk: 'unknown', installedVersion: 'unknown', mergedSince: 'unknown' });
    expect(releaseLagLine(lag)).toBe('Release · latest unknown · assets unknown · feed unknown · installed unknown · merged since unknown');
  });

  it('keeps the rest when one source fails, and reports a non-200 feed as false', async () => {
    const lag = await readReleaseLag({
      run: async (argv) => argv[1]!.startsWith('repos/') ? { code: 0, stdout: JSON.stringify(RELEASE) } : { code: 0, stdout: '{"total_count":"many"}' },
      feedStatus: async () => 404, installedVersion: async () => { throw new Error('plist'); }, now,
    });
    expect(lag).toMatchObject({ latestTag: 'v3.31.2', assetCount: 7, feedOk: false, installedVersion: 'unknown', mergedSince: 'unknown' });
    expect(releaseLagLine(lag)).toContain('feed not 200');
  });

  it('treats malformed release JSON as unknown and skips the PR search', async () => {
    const calls: string[] = [];
    const lag = await readReleaseLag({
      run: async (argv) => { calls.push(argv[1]!); return { code: 0, stdout: '{"tag_name":"v1 x","assets":"nope"}' }; },
      feedStatus: async () => 200, installedVersion: async () => '3.31.1', now,
    });
    expect(lag).toMatchObject({ latestTag: 'unknown', assetCount: 'unknown', mergedSince: 'unknown' });
    expect(calls).toHaveLength(1);
  });

  it('rejects shapes that are not the schema', () => {
    const lag = { schema: RELEASE_LAG_SCHEMA, checkedAt: '2026-11-09T10:00:00.000Z', latestTag: 'v1', assetCount: 1, feedOk: true, installedVersion: '1.0.0', mergedSince: 0 };
    expect(narrowReleaseLag(null)).toBeNull();
    expect(narrowReleaseLag({ schema: RELEASE_LAG_SCHEMA, latestTag: 1 })).toBeNull();
    expect(narrowReleaseLag({ ...lag, schema: 'other/v9' })).toBeNull();
    expect(narrowReleaseLag({ ...lag, assetCount: -1 })).toBeNull();
    expect(narrowReleaseLag({ ...lag, assetCount: 1.5 })).toBeNull();
    expect(narrowReleaseLag({ ...lag, mergedSince: '12' })).toBeNull();
    expect(narrowReleaseLag({ ...lag, feedOk: 'yes' })).toBeNull();
    expect(narrowReleaseLag(lag)).toEqual(lag);
  });
});

describe('ashlr fleet release-lag', () => {
  const sources = { run: gh(), feedStatus: async () => 200, installedVersion: async () => '3.31.1', now };
  const capture = () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
    return () => out;
  };

  it('prints the typed read as JSON and the same numbers as one line', async () => {
    const jsonOut = capture();
    expect(await cmdFleetReleaseLag(['--json'], sources)).toBe(0);
    const lag = JSON.parse(jsonOut());
    vi.restoreAllMocks();
    const lineOut = capture();
    expect(await cmdFleetReleaseLag([], sources)).toBe(0);
    expect(lineOut()).toBe(`${releaseLagLine(lag)}\n`);
  });

  it('refuses extra arguments with usage', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleetReleaseLag(['--bogus'], sources)).toBe(2);
  });

  it('resolves through the fleet convention dispatcher', async () => {
    expect(resolveFleetSubcommand('release-lag')).toEqual({ module: './fleet-release-lag.js', exportName: 'cmdFleetReleaseLag' });
    const loaders = { 'release-lag': () => import('../src/cli/fleet-release-lag.js') };
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleet(['release-lag', '--bogus'], loaders)).toBe(2);
    expect(await cmdFleet(['release-lag', '--help'], loaders)).toBe(0);
  });
});
