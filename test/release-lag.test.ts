import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdRelease } from '../src/cli/release.js';
import { narrowReleaseLag, readReleaseLag, releaseLagLine, RELEASE_LAG_SCHEMA } from '../src/core/release/lag.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/release-lag/${name}`, import.meta.url), 'utf8');
const now = () => new Date('2026-11-09T10:00:00.000Z');
const gh = (calls: string[] = []) => async (argv: string[]) => {
  calls.push(argv[1]!);
  if (argv[1]!.startsWith('repos/')) return { code: 0, stdout: fixture('release-latest.json') };
  return { code: 0, stdout: fixture('search-merged.json') };
};
const down = async () => ({ code: 1, stdout: '' });

afterEach(() => vi.restoreAllMocks());

describe('release lag', () => {
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

  it('prints "unknown" for anything it cannot read, never a guess', async () => {
    const lag = await readReleaseLag({ run: down, feedStatus: async () => null, installedVersion: async () => null, now });
    expect(lag).toMatchObject({ latestTag: 'unknown', assetCount: 'unknown', feedOk: 'unknown', installedVersion: 'unknown', mergedSince: 'unknown' });
    expect(releaseLagLine(lag)).toBe('Release · latest unknown · assets unknown · feed unknown · installed unknown · merged since unknown');
  });

  it('keeps the rest when one source fails, and reports a non-200 feed as false', async () => {
    const lag = await readReleaseLag({
      run: async (argv) => argv[1]!.startsWith('repos/') ? { code: 0, stdout: fixture('release-latest.json') } : { code: 0, stdout: '{"total_count":"many"}' },
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
    expect(narrowReleaseLag(null)).toBeNull();
    expect(narrowReleaseLag({ schema: RELEASE_LAG_SCHEMA, latestTag: 1 })).toBeNull();
  });
});

describe('phm release lag', () => {
  const sources = { run: gh(), feedStatus: async () => 200, installedVersion: async () => '3.31.1', now };
  const capture = () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
    return () => out;
  };

  it('--json prints the typed read and the line prints the same numbers', async () => {
    const jsonOut = capture();
    expect(await cmdRelease(['lag', '--json'], sources)).toBe(0);
    const lag = JSON.parse(jsonOut());
    vi.restoreAllMocks();
    const lineOut = capture();
    expect(await cmdRelease(['lag'], sources)).toBe(0);
    expect(lineOut()).toBe(`${releaseLagLine(lag)}\n`);
  });

  it('refuses extra arguments with usage', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdRelease(['lag', '--bogus'], sources)).toBe(2);
  });
});
