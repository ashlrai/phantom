/** One plain answer to "is my app current, and if not, why?". Read-only: one GitHub
 * release read, one GET of the updater feed and the installed bundle version. No auth,
 * no gh, no artifact download. Every read is injectable so tests never touch the network. */
import { readInstalledBundleVersion, versionNewer } from '../app-update-status.js';

export const UPDATE_DOCTOR_SCHEMA = 'phantom.app-update-doctor.v1';
export const UPDATE_FEED_URL = 'https://github.com/ashlrai/phantom/releases/latest/download/latest.json';
const RELEASE_URL = 'https://api.github.com/repos/ashlrai/phantom/releases/latest';
const VERSION = /^\d+\.\d+\.\d+$/;

export type UpdateDoctorVerdict = 'current' | 'update_available' | 'feed_broken' | 'release_missing_assets' | 'unknown';
export interface UpdateDoctorReport {
  schema: typeof UPDATE_DOCTOR_SCHEMA;
  as_of: string;
  installed_version: string | null;
  latest_release: string | null;
  latest_has_assets: boolean | null;
  feed_url: string;
  /** HTTP status of the feed GET, or null when it could not be reached. */
  feed_status: number | null;
  feed_version: string | null;
  verdict: UpdateDoctorVerdict;
  next_step: string;
}
export interface UpdateDoctorDeps {
  installedVersion?: () => string | null;
  /** Latest published release: tag and whether it carries any assets; null when unreadable. */
  latestRelease?: () => Promise<{ tag: string; hasAssets: boolean } | null>;
  /** One GET of the updater feed; status null when unreachable, version null when unreadable. */
  feed?: () => Promise<{ status: number | null; version: string | null }>;
  now?: () => Date;
}

const timeout = () => AbortSignal.timeout(10_000);
async function readLatestRelease(fetcher: typeof fetch): Promise<{ tag: string; hasAssets: boolean } | null> {
  try {
    const response = await fetcher(RELEASE_URL, { signal: timeout(), headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') return null;
    const row = body as Record<string, unknown>;
    if (typeof row.tag_name !== 'string' || !VERSION.test(row.tag_name.replace(/^v/u, '')) || !Array.isArray(row.assets)) return null;
    return { tag: row.tag_name, hasAssets: row.assets.length > 0 };
  } catch { return null; }
}
async function readFeed(fetcher: typeof fetch): Promise<{ status: number | null; version: string | null }> {
  try {
    const response = await fetcher(UPDATE_FEED_URL, { signal: timeout() });
    if (!response.ok) return { status: response.status, version: null };
    try {
      const body: unknown = await response.json();
      const version = body && typeof body === 'object' ? (body as Record<string, unknown>).version : null;
      return { status: response.status, version: typeof version === 'string' && VERSION.test(version) ? version : null };
    } catch { return { status: response.status, version: null }; }
  } catch { return { status: null, version: null }; }
}

export async function updateDoctor(deps: UpdateDoctorDeps = {}, fetcher: typeof fetch = fetch): Promise<UpdateDoctorReport> {
  const [release, feed] = await Promise.all([
    (deps.latestRelease ?? (() => readLatestRelease(fetcher)))().catch(() => null),
    (deps.feed ?? (() => readFeed(fetcher)))().catch(() => ({ status: null, version: null })),
  ]);
  let installed: string | null = null;
  try { installed = (deps.installedVersion ?? readInstalledBundleVersion)(); } catch { /* unknown */ }
  const latest = release?.tag.replace(/^v/u, '') ?? null;
  const tag = release ? `v${latest}` : null;
  const report = (verdict: UpdateDoctorVerdict, next_step: string): UpdateDoctorReport => ({
    schema: UPDATE_DOCTOR_SCHEMA, as_of: (deps.now ?? (() => new Date()))().toISOString(), installed_version: installed,
    latest_release: release ? tag : null, latest_has_assets: release ? release.hasAssets : null, feed_url: UPDATE_FEED_URL,
    feed_status: feed.status, feed_version: feed.version, verdict, next_step,
  });

  if (release && !release.hasAssets) return report('release_missing_assets', `Release ${tag} has no assets; the release train must finish signing.`);
  if (feed.status === 404) return report('feed_broken', `The update feed returned 404; publish the update files for ${tag ?? 'the latest release'}.`);
  if (feed.version && latest && feed.version !== latest) {
    return report('feed_broken', `The update feed offers ${feed.version} but the latest release is ${tag}; republish the feed.`);
  }
  if (feed.status === null || feed.status < 200 || feed.status >= 300 || !feed.version) {
    return report('unknown', 'The update feed could not be read; check your connection and run this again.');
  }
  if (!installed) return report('unknown', 'The installed app version could not be read; open Phantom and run this again.');
  if (versionNewer(feed.version, installed)) return report('update_available', `Version ${feed.version} is ready; quit Phantom normally to install it.`);
  return report('current', `Phantom ${installed} is current; no action needed.`);
}
