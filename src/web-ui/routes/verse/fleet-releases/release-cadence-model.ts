import { formatAge } from '../autonomy/format.js';
import { compareReleaseTags } from '../sections/release-gap-model.js';

/** A published release older than this means the release train has stalled. */
export const RELEASE_TRAIN_BEHIND_MS = 2 * 60 * 60 * 1000;

export interface ReleaseCadenceInput {
  installedVersion: string | null;
  newestVersion: string | null;
  newestPublishedAt: string | null | undefined;
  now: number;
}

export interface ReleaseCadenceView { line: string; tone: 'ok' | 'warn' | 'neutral'; behind: boolean }

const plain = (version: string | null) => (version ? version.replace(/^v/i, '') : 'unknown');

/** The cadence line: how far the installed build trails the newest release, and whether releases are still flowing. */
export function releaseCadence(input: ReleaseCadenceInput): ReleaseCadenceView {
  const { installedVersion, newestVersion, newestPublishedAt, now } = input;
  const state = installedVersion && newestVersion ? compareReleaseTags(installedVersion, newestVersion).state : 'unknown';
  const gap = state === 'behind' ? ' (behind)' : state === 'ahead' ? ' (dev build ahead)' : '';
  const versions = `Installed ${plain(installedVersion)} · newest published ${plain(newestVersion)}${gap}`;
  const publishedMs = newestPublishedAt ? Date.parse(newestPublishedAt) : NaN;
  if (!Number.isFinite(publishedMs)) return { line: `${versions} · Last published release: unknown`, tone: 'neutral', behind: false };
  const age = Math.max(0, now - publishedMs);
  const ago = formatAge(newestPublishedAt, now);
  if (age > RELEASE_TRAIN_BEHIND_MS) {
    return { line: `${versions} · Last published release: ${ago} ago · Release train is behind: no release in ${ago}`, tone: 'warn', behind: true };
  }
  return { line: `${versions} · Last published release: ${ago} ago`, tone: state === 'behind' ? 'warn' : 'ok', behind: false };
}
