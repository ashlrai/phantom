// Pure shape of the release-lag read: no node imports, so the web bundle can use it.
/**
 * Release lag: how far the installed Phantom desktop app trails the last real
 * release. One typed read backs the CLI (`ashlr fleet release-lag`), the
 * `/api/verse/fleet/release-lag` route and the Fleet header line. A field that
 * could not be read is the string "unknown"; nothing is inferred or guessed.
 */
export const RELEASE_LAG_SCHEMA = 'phantom.release-lag/v1';
export const UNKNOWN = 'unknown';
export type Unknown = typeof UNKNOWN;

export interface ReleaseLagV1 {
  schema: typeof RELEASE_LAG_SCHEMA;
  checkedAt: string;
  /** Tag of the latest published (non-draft, non-prerelease) release. */
  latestTag: string | Unknown;
  /** Assets attached to that release. */
  assetCount: number | Unknown;
  /** True when releases/latest/download/latest.json answers 200, false for any other status. */
  feedOk: boolean | Unknown;
  /** CFBundleShortVersionString of /Applications/Phantom.app (read-only). */
  installedVersion: string | Unknown;
  /** Pull requests merged after the latest release was published. */
  mergedSince: number | Unknown;
}

/** The one human line; the same numbers as the JSON, in plain words. */
export function releaseLagLine(lag: ReleaseLagV1): string {
  const feed = lag.feedOk === UNKNOWN ? UNKNOWN : lag.feedOk ? '200' : 'not 200';
  return `Release · latest ${lag.latestTag} · assets ${lag.assetCount} · feed ${feed} · installed ${lag.installedVersion} · merged since ${lag.mergedSince}`;
}

/** Narrow an untrusted response (web client) to the typed shape, or null. */
export function narrowReleaseLag(raw: unknown): ReleaseLagV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string';
  const count = (v: unknown) => v === UNKNOWN || (Number.isSafeInteger(v) && (v as number) >= 0);
  return row.schema === RELEASE_LAG_SCHEMA && text(row.checkedAt) && text(row.latestTag) && text(row.installedVersion)
    && count(row.assetCount) && count(row.mergedSince) && (row.feedOk === UNKNOWN || typeof row.feedOk === 'boolean')
    ? raw as ReleaseLagV1 : null;
}
