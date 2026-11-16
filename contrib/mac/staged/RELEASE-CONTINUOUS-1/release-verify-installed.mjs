#!/usr/bin/env node
/**
 * scripts/release-verify-installed.mjs: end-to-end check of one Phantom release
 * on this Mac, then one metrics line (RELEASE-CONTINUOUS-1 step 5).
 *
 *   node scripts/release-verify-installed.mjs [--tag vX.Y.Z] [--app /Applications/Phantom.app]
 *        [--metrics ~/.ashlr-runs/metrics/releases.jsonl] [--json]
 *
 * Verifies, with anonymous GET reads of the public repository only:
 *   1. assets: the published (non-draft) release carries exactly the seven
 *      signed desktop assets, each uploaded and non-empty;
 *   2. feed: releases/latest/download/latest.json serves this version, or a
 *      newer published release is latest (superseded, still verified);
 *   3. installed: the app bundle's Info.plist CFBundleShortVersionString is at
 *      least this version, so the installed app self-updated.
 * When all three hold and the tag has no line yet, it appends one JSON line:
 *   { tag, publishedEt, mergeToInstalledMinutes, installedVersion, ... }
 * Merge time is the tagged commit's committer date (the release PR merge).
 * Installed time is when this check first observed the version, so the
 * minutes are an upper bound within one poll interval.
 *
 * Never writes anything else, never signs, publishes, or reads credentials,
 * keychains or app data. Exit 0 = verified (line appended or already present),
 * 3 = not yet (pending: draft, assets, feed or self-update), 1 = refused.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'ashlrai/phantom';
export const METRICS_SCHEMA = 'phantom.release-metrics.v1';
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The seven signed desktop assets, identical to the release-autorun rev2 set. */
export function expectedAssets(version) {
  return [
    'manifest.json', 'manifest.json.sig', 'latest.json',
    `Phantom_${version}_aarch64.app.tar.gz`, `Phantom_${version}_aarch64.app.tar.gz.sig`,
    `ashlr-phantom-${version}.tgz`, `ashlr-phantom-${version}.tgz.sig`,
  ].sort();
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** CFBundleShortVersionString from an XML Info.plist. Binary plists go through plutil. */
export function bundleVersion(plistText) {
  const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/.exec(plistText);
  return match && VERSION.test(match[1]) ? match[1] : null;
}

export function readInstalledVersion(app, { read = readFileSync, plutil = defaultPlutil } = {}) {
  const plist = join(app, 'Contents', 'Info.plist');
  let bytes;
  try { bytes = read(plist); } catch { return null; }
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  if (text.startsWith('bplist')) {
    const value = plutil(plist);
    return typeof value === 'string' && VERSION.test(value.trim()) ? value.trim() : null;
  }
  return bundleVersion(text);
}

function defaultPlutil(plist) {
  try {
    return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8', timeout: 5000 });
  } catch { return null; }
}

/** "2026-11-16 09:33:05 EST": wall time in America/New_York with its abbreviation. */
export function easternTime(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error('invalid timestamp');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

export function recordedTags(metricsText) {
  const tags = new Set();
  for (const line of metricsText.split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (typeof row?.tag === 'string') tags.add(row.tag); } catch { /* keep other writers' lines */ }
  }
  return tags;
}

/**
 * Pure decision over observations. `read(path)` returns parsed JSON for
 * `repos/<repo>/...` paths and `feed` for the updater endpoint, or null on 404.
 */
export async function verifyInstalledRelease({ tag, read, installedVersion, now }) {
  const release = tag ? await read(`repos/${REPOSITORY}/releases/tags/${tag}`) : await read(`repos/${REPOSITORY}/releases/latest`);
  if (!release) return { state: 'pending', reason: 'release-not-published', tag };
  const name = release.tag_name;
  if (typeof name !== 'string' || !TAG.test(name) || (tag && name !== tag)) return { state: 'refused', reason: 'release-identity', tag };
  if (release.draft !== false || release.prerelease !== false) return { state: 'pending', reason: 'release-draft', tag: name };
  const version = name.slice(1);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const names = assets.map(asset => asset?.name).sort();
  const complete = JSON.stringify(names) === JSON.stringify(expectedAssets(version))
    && assets.every(asset => asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0);
  if (!complete) return { state: 'pending', reason: assets.length === 0 ? 'zero-assets' : 'asset-set-incomplete', tag: name, assets: assets.length };

  const feed = await read('feed');
  const feedVersion = typeof feed?.version === 'string' && VERSION.test(feed.version) ? feed.version : null;
  if (!feedVersion || compareVersions(feedVersion, version) < 0) return { state: 'pending', reason: 'feed-not-updated', tag: name, feedVersion };

  if (!installedVersion) return { state: 'pending', reason: 'app-not-installed', tag: name, feedVersion };
  if (compareVersions(installedVersion, version) < 0) return { state: 'pending', reason: 'awaiting-self-update', tag: name, feedVersion, installedVersion };

  const commit = await read(`repos/${REPOSITORY}/commits/${name}`);
  const mergedAt = commit?.commit?.committer?.date;
  const merged = Date.parse(mergedAt ?? '');
  const published = Date.parse(release.published_at ?? '');
  const observed = Date.parse(now);
  if (!Number.isFinite(merged) || !Number.isFinite(published) || !Number.isFinite(observed) || observed < merged) {
    return { state: 'refused', reason: 'timestamps', tag: name };
  }
  return {
    state: 'verified', tag: name, feedVersion, installedVersion,
    line: {
      schema: METRICS_SCHEMA, tag: name, publishedEt: easternTime(release.published_at),
      mergeToInstalledMinutes: Math.round((observed - merged) / 60_000), installedVersion,
      mergedAt: new Date(merged).toISOString(), publishedAt: new Date(published).toISOString(),
      installedObservedAt: new Date(observed).toISOString(), assets: assets.length,
      feed: feedVersion === version ? 'latest' : 'superseded',
    },
  };
}

/** Appends the verified line once per tag. Returns true when it wrote. */
export function appendMetric(path, line) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (recordedTags(existing).has(line.tag)) return false;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${existing && !existing.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`, { mode: 0o600 });
  return true;
}

/** Anonymous GET reads of the public repository and its updater endpoint. */
export function publicReader({ fetchImpl = fetch } = {}) {
  return async path => {
    const url = path === 'feed'
      ? `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`
      : `https://api.github.com/${path}`;
    if (path !== 'feed' && !path.startsWith(`repos/${REPOSITORY}/`)) throw new Error('unreviewed read');
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000),
      headers: path === 'feed' ? {} : { Accept: 'application/vnd.github+json' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`read failed (${response.status})`);
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('read too large');
    return JSON.parse(text);
  };
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('usage: release-verify-installed.mjs [--tag vX.Y.Z] [--app path] [--metrics path] [--json]\n');
    return 0;
  }
  const tag = argValue(args, '--tag');
  if (tag && !TAG.test(tag)) throw new Error('invalid --tag');
  const app = resolve(argValue(args, '--app') ?? '/Applications/Phantom.app');
  const metrics = resolve(argValue(args, '--metrics') ?? join(homedir(), '.ashlr-runs', 'metrics', 'releases.jsonl'));
  const result = await verifyInstalledRelease({ tag, read: publicReader(), installedVersion: readInstalledVersion(app), now: new Date().toISOString() });
  const appended = result.state === 'verified' ? appendMetric(metrics, result.line) : false;
  const report = { ...result, appended };
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(report)}\n`
    : `${report.state} ${report.tag ?? ''} ${report.reason ?? ''}${appended ? ` appended to ${metrics}` : ''}\n`);
  return result.state === 'verified' ? 0 : result.state === 'pending' ? 3 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`release verify refused: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
