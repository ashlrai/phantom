/** Read-only diagnosis of the public desktop update feed. No artifacts are fetched. */
import { readInstalledBundleVersion, versionNewer } from './app-update-status.js';

const FEED = 'https://github.com/ashlrai/phantom/releases/latest/download/latest.json';
const RELEASE = 'https://api.github.com/repos/ashlrai/phantom/releases/latest';
export type UpdateFeedDiagnosisReason = 'feed-404' | 'no-assets' | 'already-current' | 'available' | 'unknown';
export interface UpdateFeedDiagnosis { installedVersion: string | null; feedVersion: string | null; reason: UpdateFeedDiagnosisReason; message: string }

export async function updateFeedDiagnosis(installedVersion = readInstalledBundleVersion(), fetcher: typeof fetch = fetch): Promise<UpdateFeedDiagnosis> {
  const result = (feedVersion: string | null, reason: UpdateFeedDiagnosisReason, message: string): UpdateFeedDiagnosis => ({ installedVersion, feedVersion, reason, message });
  try {
    const response = await fetcher(FEED, { signal: AbortSignal.timeout(10000) });
    if (response.status === 404) {
      try {
        const release = await fetcher(RELEASE, { signal: AbortSignal.timeout(10000) });
        if (release.ok) {
          const body: unknown = await release.json();
          if (body && typeof body === 'object' && 'assets' in body && Array.isArray(body.assets) && body.assets.length === 0)
            return result(null, 'no-assets', 'The latest release has no assets.');
        }
      } catch { /* The feed 404 is still known. */ }
      return result(null, 'feed-404', 'The update feed was not found.');
    }
    if (!response.ok) return result(null, 'unknown', 'Could not check the update feed.');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('version' in body) || typeof body.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(body.version))
      return result(null, 'unknown', 'The update feed could not be understood.');
    const version = body.version;
    if (!installedVersion) return result(version, 'unknown', 'The installed app version is unknown.');
    if (!versionNewer(version, installedVersion)) return result(version, 'already-current', 'The installed app is already current with the update feed.');
    return result(version, 'available', 'A newer version is on the update feed; its signature has not been checked.');
  } catch { return result(null, 'unknown', 'Could not reach the update feed; the update status is unknown.'); }
}
