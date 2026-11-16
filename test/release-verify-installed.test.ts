/**
 * RELEASE-CONTINUOUS-1 (5): each release is verified end to end (assets,
 * updater feed, installed app self-updated) and recorded once in
 * releases.jsonl. Hermetic: injected reads, temp files, no network or HOME.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendMetric, bundleVersion, easternTime, expectedAssets, publicReader, readInstalledVersion, recordedTags, verifyInstalledRelease,
  // @ts-expect-error untyped repository script
} from '../scripts/release-verify-installed.mjs';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'release-verify-')); dirs.push(dir); return dir; }

const asset = (name: string) => ({ name, state: 'uploaded', size: 10 });
function release(version: string, overrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-11-16T19:33:05Z',
    assets: expectedAssets(version).map(asset), ...overrides,
  };
}
function reader(data: Record<string, unknown>) {
  const reads: string[] = [];
  const read = async (path: string) => { reads.push(path); return Object.hasOwn(data, path) ? data[path] : null; };
  return { read, reads };
}
const world = (version: string, feed: string, extra: Record<string, unknown> = {}) => reader({
  [`repos/ashlrai/phantom/releases/tags/v${version}`]: release(version),
  feed: { version: feed },
  [`repos/ashlrai/phantom/commits/v${version}`]: { commit: { committer: { date: '2026-11-16T18:00:00Z' } } },
  ...extra,
});
const plist = (version: string) => `<?xml version="1.0"?><plist><dict><key>CFBundleName</key><string>Phantom</string>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>`;

describe('release end-to-end verification', () => {
  it('verifies assets, feed and the self-updated bundle, then computes merge-to-installed minutes', async () => {
    const { read } = world('3.30.36', '3.30.36');
    const result = await verifyInstalledRelease({ tag: 'v3.30.36', read, installedVersion: '3.30.36', now: '2026-11-16T19:45:00Z' });
    expect(result.state).toBe('verified');
    expect(result.line).toEqual({
      schema: 'phantom.release-metrics.v1', tag: 'v3.30.36', publishedEt: '2026-11-16 14:33:05 EST',
      mergeToInstalledMinutes: 105, installedVersion: '3.30.36',
      mergedAt: '2026-11-16T18:00:00.000Z', publishedAt: '2026-11-16T19:33:05.000Z', installedObservedAt: '2026-11-16T19:45:00.000Z',
      assets: 7, feed: 'latest',
    });
  });

  it('accepts a feed and an installed app that already moved to a newer release', async () => {
    const { read } = world('3.30.36', '3.30.37');
    const result = await verifyInstalledRelease({ tag: 'v3.30.36', read, installedVersion: '3.30.37', now: '2026-11-16T20:00:00Z' });
    expect(result.state).toBe('verified');
    expect(result.line.feed).toBe('superseded');
  });

  it.each([
    ['a draft', { 'repos/ashlrai/phantom/releases/tags/v3.30.36': release('3.30.36', { draft: true }) }, '3.30.36', 'release-draft'],
    ['a 0-asset release', { 'repos/ashlrai/phantom/releases/tags/v3.30.36': release('3.30.36', { assets: [] }) }, '3.30.36', 'zero-assets'],
    ['a missing signature', { 'repos/ashlrai/phantom/releases/tags/v3.30.36': release('3.30.36', { assets: expectedAssets('3.30.36').slice(1).map(asset) }) }, '3.30.36', 'asset-set-incomplete'],
    ['an empty asset', { 'repos/ashlrai/phantom/releases/tags/v3.30.36': release('3.30.36', { assets: expectedAssets('3.30.36').map((name: string) => ({ ...asset(name), size: 0 })) }) }, '3.30.36', 'asset-set-incomplete'],
    ['a stale feed', { feed: { version: '3.30.35' } }, '3.30.36', 'feed-not-updated'],
    ['an unreadable feed', { feed: null }, '3.30.36', 'feed-not-updated'],
    ['an app that has not self-updated', {}, '3.30.35', 'awaiting-self-update'],
    ['no installed app', {}, null, 'app-not-installed'],
  ])('holds as pending for %s', async (_label, extra, installed, reason) => {
    const { read } = world('3.30.36', '3.30.36', extra);
    const result = await verifyInstalledRelease({ tag: 'v3.30.36', read, installedVersion: installed, now: '2026-11-16T19:45:00Z' });
    expect(result).toMatchObject({ state: 'pending', reason });
    expect(result.line).toBeUndefined();
  });

  it('refuses a release whose identity does not match the requested tag', async () => {
    const { read } = world('3.30.36', '3.30.36', { 'repos/ashlrai/phantom/releases/tags/v3.30.36': release('3.30.35') });
    expect(await verifyInstalledRelease({ tag: 'v3.30.36', read, installedVersion: '3.30.36', now: '2026-11-16T19:45:00Z' }))
      .toMatchObject({ state: 'refused', reason: 'release-identity' });
  });

  it('uses the latest published release when no tag is given', async () => {
    const { read, reads } = world('3.30.36', '3.30.36', { 'repos/ashlrai/phantom/releases/latest': release('3.30.36') });
    expect((await verifyInstalledRelease({ read, installedVersion: '3.30.36', now: '2026-11-16T19:45:00Z' })).state).toBe('verified');
    expect(reads[0]).toBe('repos/ashlrai/phantom/releases/latest');
  });

  it('reads CFBundleShortVersionString from the bundle Info.plist only', () => {
    const app = join(temp(), 'Phantom.app');
    expect(readInstalledVersion(app)).toBeNull();
    const files: Record<string, string> = { [join(app, 'Contents', 'Info.plist')]: plist('3.30.36') };
    expect(readInstalledVersion(app, { read: (path: string) => { if (!files[path]) throw new Error('ENOENT'); return files[path]; } })).toBe('3.30.36');
    expect(readInstalledVersion(app, { read: () => 'bplist00...', plutil: () => '3.30.37\n' })).toBe('3.30.37');
    expect(readInstalledVersion(app, { read: () => 'bplist00...', plutil: () => null })).toBeNull();
    expect(bundleVersion(plist('not-a-version'))).toBeNull();
  });

  it('formats published time in Eastern time across the DST boundary', () => {
    expect(easternTime('2026-11-16T19:33:05Z')).toBe('2026-11-16 14:33:05 EST');
    expect(easternTime('2026-07-01T16:00:00Z')).toBe('2026-07-01 12:00:00 EDT');
  });

  it('appends exactly one line per tag and keeps other writers’ lines', () => {
    const path = join(temp(), 'metrics', 'releases.jsonl');
    const line = { schema: 'phantom.release-metrics.v1', tag: 'v3.30.36', publishedEt: 'x', mergeToInstalledMinutes: 1, installedVersion: '3.30.36' };
    expect(appendMetric(path, line)).toBe(true);
    expect(appendMetric(path, { ...line, mergeToInstalledMinutes: 99 })).toBe(false);
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json`);
    expect(appendMetric(path, { ...line, tag: 'v3.30.37' })).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect([...recordedTags(text)]).toEqual(['v3.30.36', 'v3.30.37']);
    expect(text.split('\n').filter(Boolean)).toHaveLength(3);
    expect(JSON.parse(text.split('\n')[0]!).mergeToInstalledMinutes).toBe(1);
  });

  it('reads only this public repository and its updater endpoint, anonymously', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"version":"3.30.36"}', { status: 200 }); };
    const read = publicReader({ fetchImpl });
    await read('feed');
    await read('repos/ashlrai/phantom/releases/latest');
    await expect(read('repos/other/repo/releases/latest')).rejects.toThrow(/unreviewed/);
    expect(calls.map((call) => call.url)).toEqual([
      'https://github.com/ashlrai/phantom/releases/latest/download/latest.json',
      'https://api.github.com/repos/ashlrai/phantom/releases/latest',
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe('GET');
      expect(JSON.stringify(call.init.headers ?? {})).not.toMatch(/authorization|token/i);
    }
  });

  it('the Security pin package carries the same verifier bytes and matching SHA256 lines', () => {
    const root = join(__dirname, '..');
    const pkg = join(root, 'contrib', 'mac', 'staged', 'RELEASE-CONTINUOUS-1');
    const source = readFileSync(join(root, 'scripts', 'release-verify-installed.mjs'));
    expect(readFileSync(join(pkg, 'release-verify-installed.mjs')).equals(source)).toBe(true);
    const sums = Object.fromEntries(readFileSync(join(pkg, 'SHA256'), 'utf8').trim().split('\n').map((line) => line.split(/\s+/).reverse()));
    for (const file of ['release-verify-installed.mjs', 'release-autorun.diff']) {
      expect(sums[file], file).toBe(createHash('sha256').update(readFileSync(join(pkg, file))).digest('hex'));
    }
    const diff = readFileSync(join(pkg, 'release-autorun.diff'), 'utf8');
    expect(diff).not.toMatch(/release-sign|codesign|notar|security find|keychain-allowed/i);
    expect(diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'))).toEqual([]);
  });
});
