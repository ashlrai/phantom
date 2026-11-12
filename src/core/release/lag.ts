import { createInstalledReleaseReader } from '../fleet/installed-release-evidence.js';
import { ghRunner, type ReleaseRunner } from '../fleet/release-live-notice.js';
import { RELEASE_LAG_SCHEMA, UNKNOWN, type ReleaseLagV1 } from './lag-shape.js';

export * from './lag-shape.js';

export const RELEASE_LAG_REPO = 'ashlrai/phantom';
export const RELEASE_LAG_FEED_URL = `https://github.com/${RELEASE_LAG_REPO}/releases/latest/download/latest.json`;

export interface ReleaseLagSources {
  run?: ReleaseRunner;
  /** HTTP status of the update feed, or null when it could not be reached. */
  feedStatus?: () => Promise<number | null>;
  /** Installed app version, or null when unreadable. */
  installedVersion?: () => Promise<string | null>;
  now?: () => Date;
}

const safeText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\x21-\x7e]+$/.test(value);

async function readJson(run: ReleaseRunner, endpoint: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await run(['api', endpoint]);
    if (result.code !== 0) return null;
    const value: unknown = JSON.parse(result.stdout);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function readFeedStatus(): Promise<number | null> {
  try {
    const response = await fetch(RELEASE_LAG_FEED_URL, { signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    return response.status;
  } catch { return null; }
}

async function readInstalledVersion(): Promise<string | null> {
  return (await createInstalledReleaseReader()(RELEASE_LAG_REPO, ''))?.version ?? null;
}

export async function readReleaseLag(sources: ReleaseLagSources = {}): Promise<ReleaseLagV1> {
  const run = sources.run ?? ghRunner;
  const [release, feed, installed] = await Promise.all([
    readJson(run, `repos/${RELEASE_LAG_REPO}/releases/latest`),
    (sources.feedStatus ?? readFeedStatus)().catch(() => null),
    (sources.installedVersion ?? readInstalledVersion)().catch(() => null),
  ]);
  const published = release && typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at))
    ? new Date(release.published_at).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
  const merged = published
    ? await readJson(run, `search/issues?q=${encodeURIComponent(`repo:${RELEASE_LAG_REPO} is:pr is:merged merged:>${published}`)}&per_page=1`)
    : null;
  return {
    schema: RELEASE_LAG_SCHEMA,
    checkedAt: (sources.now ?? (() => new Date()))().toISOString(),
    latestTag: release && safeText(release.tag_name) ? release.tag_name : UNKNOWN,
    assetCount: release && Array.isArray(release.assets) ? release.assets.length : UNKNOWN,
    feedOk: feed === null ? UNKNOWN : feed === 200,
    installedVersion: safeText(installed) ? installed : UNKNOWN,
    mergedSince: merged && Number.isSafeInteger(merged.total_count) && (merged.total_count as number) >= 0
      ? merged.total_count as number : UNKNOWN,
  };
}
