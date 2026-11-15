import type { DesktopUpdateState } from '../../../app/desktop-updates.js';
import type { FeedItem } from './feed-model.js';

/** Release stages are observations, not a release history or proof that a failed feed is a 404. */
export function releaseFeedItems(raw: unknown, native: DesktopUpdateState | null, observedAt: string): FeedItem[] {
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  const add = (version: string, state: string, title: string, alert = false) => {
    const id = `release:${version}:${state}`;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({ id, at: observedAt, kind: alert ? 'alert' : 'update', title });
  };
  if (raw && typeof raw === 'object') {
    const response = raw as Record<string, unknown>;
    if (response.schema === 'verse.release-stages.v1' && Array.isArray(response.stages)) {
      const version = typeof response.tag === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(response.tag) ? response.tag : 'unknown version';
      const stamp = typeof response.checkedAt === 'string' && Number.isFinite(Date.parse(response.checkedAt)) ? response.checkedAt : observedAt;
      observedAt = stamp;
      for (const rawStage of response.stages) {
        if (!rawStage || typeof rawStage !== 'object') continue;
        const stage = rawStage as Record<string, unknown>;
        if (stage.stage === 'published') {
          if (version !== 'unknown version' && stage.status === 'observed') add(version, 'published', `${version} is public; the required desktop assets are present.`);
          else if (version !== 'unknown version' && typeof stage.reason === 'string' && stage.reason.startsWith('desktop asset evidence incomplete;')) add(version, 'assets-incomplete', `${version} is public; required desktop assets are missing or invalid.`, true);
          else add(version, 'publication-unknown', `${version}: publication or desktop asset state is unknown.`);
        } else if (stage.stage === 'feed-ready') {
          if (version !== 'unknown version' && stage.status === 'observed' && typeof stage.version === 'string') add(version, 'feed-ready', `${version}: the updater feed serves ${stage.version}.`);
          else add(version, 'feed-unknown', `${version}: updater feed availability is unknown.`);
        }
      }
      if (!response.stages.length) add(version, 'release-unknown', `${version}: release state is unknown.`);
    }
  }
  if (native?.phase === 'installed') {
    const version = native.version ? `v${native.version}` : 'unknown version';
    add(version, 'installed', `${version}: desktop update installed; restart is pending.`);
  }
  return items;
}
