import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateDoctor, UPDATE_DOCTOR_SCHEMA, type UpdateDoctorDeps } from '../src/core/desktop/update-doctor.js';
import { cmdApp } from '../src/cli/app.js';

const now = () => new Date('2026-11-19T00:00:00.000Z');
const run = (installed: string | null, release: { tag: string; hasAssets: boolean } | null, feed: { status: number | null; version: string | null }) =>
  updateDoctor({ installedVersion: () => installed, latestRelease: async () => release, feed: async () => feed, now } satisfies UpdateDoctorDeps);

afterEach(() => vi.restoreAllMocks());

describe('app update-doctor verdicts', () => {
  it('current', async () => {
    const r = await run('3.30.9', { tag: 'v3.30.9', hasAssets: true }, { status: 200, version: '3.30.9' });
    expect(r).toMatchObject({ schema: UPDATE_DOCTOR_SCHEMA, as_of: '2026-11-19T00:00:00.000Z', verdict: 'current', latest_release: 'v3.30.9', latest_has_assets: true, feed_status: 200, feed_version: '3.30.9' });
  });
  it('update_available', async () => {
    const r = await run('3.29.15', { tag: 'v3.30.9', hasAssets: true }, { status: 200, version: '3.30.9' });
    expect(r.verdict).toBe('update_available');
    expect(r.installed_version).toBe('3.29.15');
  });
  it('feed_broken on 404', async () => {
    const r = await run('3.29.15', { tag: 'v3.30.9', hasAssets: true }, { status: 404, version: null });
    expect(r.verdict).toBe('feed_broken');
    expect(r.feed_status).toBe(404);
  });
  it('feed_broken on version mismatch', async () => {
    const r = await run('3.29.15', { tag: 'v3.30.9', hasAssets: true }, { status: 200, version: '3.30.1' });
    expect(r.verdict).toBe('feed_broken');
  });
  it('release_missing_assets', async () => {
    const r = await run('3.29.15', { tag: 'v3.30.9', hasAssets: false }, { status: 404, version: null });
    expect(r.verdict).toBe('release_missing_assets');
    expect(r.next_step).toBe('Release v3.30.9 has no assets; the release train must finish signing.');
  });
  it('unknown when the feed is unreachable, the version is unreadable, or the release is unreadable', async () => {
    expect((await run('3.29.15', { tag: 'v3.30.9', hasAssets: true }, { status: null, version: null })).verdict).toBe('unknown');
    expect((await run(null, { tag: 'v3.30.9', hasAssets: true }, { status: 200, version: '3.30.9' })).verdict).toBe('unknown');
    const r = await run('3.30.9', null, { status: 200, version: '3.30.9' });
    expect(r).toMatchObject({ verdict: 'current', latest_release: null, latest_has_assets: null });
  });
  it('reads release and feed through one injected fetcher without auth', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify(String(url).includes('api.github.com') ? { tag_name: 'v2.0.0', assets: [{}] } : { version: '2.0.0' }), { status: 200 });
    }) as typeof fetch;
    const r = await updateDoctor({ installedVersion: () => '1.0.0', now }, fetcher);
    expect(r.verdict).toBe('update_available');
    expect(urls).toHaveLength(2);
  });
});

describe('phm app update-doctor', () => {
  it('prints typed JSON and rejects bad usage', async () => {
    const report = await run('3.30.9', { tag: 'v3.30.9', hasAssets: true }, { status: 200, version: '3.30.9' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdApp(['update-doctor', '--json'], undefined, async () => report)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0])).schema).toBe(UPDATE_DOCTOR_SCHEMA);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdApp(['update-doctor', '--bogus'])).toBe(2);
  });
});
