import { describe, expect, it } from 'vitest';
import { buildReleaseCadence, cadenceText, readReleaseCadence, CADENCE_SCHEMA } from '../src/core/release/cadence.js';
import { cmdRelease } from '../src/cli/release.js';
import { buildPulseAlerts } from '../src/core/fleet/pulse-alerts.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const rel = (h: number, assets = 3) => ({ tag: 'v1.2.3', publishedAt: hoursAgo(h), assets });
const row = (release: ReturnType<typeof rel> | null, mergedSince: number | null, repo = 'alpha') => buildReleaseCadence([{ repo, release, mergedSince }], NOW).repos[0]!;

describe('buildReleaseCadence', () => {
  it('fresh: under 6 hours, or nothing merged since', () => {
    expect(row(rel(2), 9).status).toBe('fresh');
    expect(row(rel(100), 0).status).toBe('fresh');
  });
  it('due: 6 to 24 hours with merges since', () => {
    expect(row(rel(6), 1).status).toBe('due');
    expect(row(rel(24), 1).status).toBe('due');
  });
  it('stale: over 24 hours with merges since', () => {
    expect(row(rel(24.5), 4)).toEqual({ repo: 'alpha', latest_tag: 'v1.2.3', published_at: hoursAgo(24.5), has_assets: true, hours_since: 24.5, merged_since: 4, status: 'stale' });
  });
  it('a published release with 0 assets reports has_assets false', () => {
    expect(row(rel(2, 0), 0).has_assets).toBe(false);
    expect(cadenceText(buildReleaseCadence([{ repo: 'alpha', release: rel(2, 0), mergedSince: 0 }], NOW)).join('\n')).toContain('NO assets');
  });
  it('a repo with no releases says so, not fresh', () => {
    expect(row(null, 0)).toMatchObject({ latest_tag: 'none', published_at: 'unknown', has_assets: 'unknown', hours_since: 'unknown', status: 'no_release' });
  });
  it('unknown merged count past 6 hours is unknown, never fresh; unreadable repo is all unknown', () => {
    expect(row(rel(30), null)).toMatchObject({ merged_since: 'unknown', status: 'unknown' });
    expect(buildReleaseCadence([{ repo: 'alpha', release: null, mergedSince: null, readable: false }], NOW).repos[0]).toEqual({
      repo: 'alpha', latest_tag: 'unknown', published_at: 'unknown', has_assets: 'unknown', hours_since: 'unknown', merged_since: 'unknown', status: 'unknown' });
  });
});

describe('readReleaseCadence', () => {
  it('reads releases and merged counts, skipping drafts and prereleases; a failed repo is unknown', async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      if (url.includes('/beta/')) return { ok: false, json: async () => ({}) };
      if (url.includes('search/issues')) return { ok: true, json: async () => ({ total_count: 5 }) };
      return { ok: true, json: async () => [
        { tag_name: 'v9', draft: true, prerelease: false, published_at: hoursAgo(1), assets: [] },
        { tag_name: 'v8', draft: false, prerelease: true, published_at: hoursAgo(1), assets: [] },
        { tag_name: 'v7', draft: false, prerelease: false, published_at: hoursAgo(30), assets: [{}, {}] }] };
    };
    const report = await readReleaseCadence({ repos: ['alpha', 'beta'], now: NOW, fetch });
    expect(report.schema).toBe(CADENCE_SCHEMA);
    expect(report.repos.map(r => [r.repo, r.latest_tag, r.status])).toEqual([['alpha', 'v7', 'stale'], ['beta', 'unknown', 'unknown']]);
    expect(urls.every(u => u.startsWith('https://api.github.com/'))).toBe(true);
  });
  it('a repo whose list is empty has no release', async () => {
    const report = await readReleaseCadence({ repos: ['alpha'], now: NOW, fetch: async () => ({ ok: true, json: async () => [] }) });
    expect(report.repos[0]!.status).toBe('no_release');
  });
});

describe('phm release cadence', () => {
  const run = async (args: string[]) => {
    let out = '', err = '';
    const o = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
    let code: number;
    const seen: (string[] | undefined)[] = [];
    try { code = await cmdRelease(args, { cadence: async repos => { seen.push(repos); return buildReleaseCadence([{ repo: 'alpha', release: rel(30), mergedSince: 2 }], NOW); } }); }
    finally { process.stdout.write = o; process.stderr.write = e; }
    return { code, out, err, seen };
  };
  it('--json prints the schema id and passes --repos through', async () => {
    const r = await run(['cadence', '--repos', 'alpha,beta', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ schema: CADENCE_SCHEMA, repos: [{ repo: 'alpha', status: 'stale' }] });
    expect(r.seen).toEqual([['alpha', 'beta']]);
  });
  it('plain words without --json; bad arguments exit 2', async () => {
    expect((await run(['cadence'])).out).toContain('alpha: stale: v1.2.3 30 hours ago, 2 merged since');
    expect((await run(['cadence', '--repos'])).code).toBe(2);
    expect((await run(['cadence', '--nope'])).code).toBe(2);
    expect((await run(['cadence', '--repos', 'a/../b'])).code).toBe(2);
  });
});

describe('release_stale pulse alert', () => {
  const quiet = { marks: [], starved: { lanes: {}, waiting_elsewhere: 0, open_rows: 0 }, spend: null };
  it('stale and zero-asset releases alert; fresh does not; unread is listed as unknown', () => {
    const releases = buildReleaseCadence([
      { repo: 'old', release: rel(30), mergedSince: 3 }, { repo: 'bare', release: rel(1, 0), mergedSince: 0 },
      { repo: 'ok', release: rel(1), mergedSince: 2 }, { repo: 'lost', release: null, mergedSince: null, readable: false }], NOW);
    const pulse = buildPulseAlerts({ ...quiet, marks: null, releases } as never, NOW);
    expect(pulse.alerts.filter(a => a.kind === 'release_stale').map(a => a.lane)).toEqual(['old', 'bare']);
    expect(pulse.unknown).toContain('Release cadence: lost could not be read.');
    expect(buildPulseAlerts({ ...quiet, marks: null, releases: null } as never, NOW).unknown.join(' ')).toContain('GitHub releases could not be read');
  });
});
