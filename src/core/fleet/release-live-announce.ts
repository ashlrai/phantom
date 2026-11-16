/**
 * Release-live announcement (RQ-PHX-RELEASELIVEANNOUNCE96).
 *
 * When a newer Phantom release is published AND its updater feed is live, post
 * exactly one message to the owner/Leader thread (the existing relays carry it
 * to the desktop, phone and chat channels); when the installed app later
 * reaches that version, post exactly one follow-up. State lives in
 * `<leaderRoot>/release-announce.json`.
 *
 * Reuse: release facts and feed liveness come from release-live-notice.ts
 * (`fetchLatestRelease`, `observeMilestones`, `readPublicReleaseFeed`: a
 * release with missing/empty desktop assets or an unreadable feed is never
 * live), the installed version from app-update-status.ts, the post from
 * vision/leader-thread.ts `postLeaderMessage`, and the lock from
 * local-store-lock.ts. No new network code and no new channel sender.
 */
import { join } from 'node:path';
import { fetchLatestRelease, observeMilestones, readPublicReleaseFeed, type MilestoneReader, type ReleaseRunner } from './release-live-notice.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';

const REPO = 'ashlrai/phantom';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const STATE_MAX_BYTES = 4 * 1024;

export interface ReleaseAnnounceState {
  /** Newest version announced as published + feed live. */
  announced: string | null;
  /** Version whose "installed" follow-up (or in-message equivalent) is done. */
  installedAnnounced: string | null;
}
export interface ObservedRelease { version: string; live: boolean }
export interface ReleaseAnnouncePlan { messages: string[]; state: ReleaseAnnounceState }

const EMPTY: ReleaseAnnounceState = { announced: null, installedAnnounced: null };

function newer(a: string, b: string): boolean {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d !== 0) return d > 0; }
  return false;
}

/** Pure: which messages to post now, and the state to persist once they are posted. */
export function planReleaseAnnouncement(
  state: ReleaseAnnounceState, release: ObservedRelease | null, installed: string | null,
): ReleaseAnnouncePlan {
  const next = { ...state };
  const messages: string[] = [];
  const have = installed !== null && SEMVER.test(installed) ? installed : null;
  if (release && release.live && SEMVER.test(release.version)
    && (state.announced === null || newer(release.version, state.announced))) {
    if (state.announced === null && state.installedAnnounced === null && have === release.version) {
      // First run on an app that already has this release: nothing new to tell.
      next.announced = release.version;
      next.installedAnnounced = release.version;
    } else {
      messages.push(`Phantom v${release.version} is published and the update feed is live. Installed here: ${have ? `v${have}` : 'unknown'}.`);
      next.announced = release.version;
      if (have === release.version) next.installedAnnounced = release.version;
    }
  }
  if (next.announced !== null && have === next.announced && next.installedAnnounced !== next.announced) {
    messages.push(`Installed v${next.announced} on this Mac`);
    next.installedAnnounced = next.announced;
  }
  return { messages, state: next };
}

export function parseReleaseAnnounceState(text: string | null): ReleaseAnnounceState {
  if (text === null) return { ...EMPTY };
  try {
    const row: unknown = JSON.parse(text);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { ...EMPTY };
    const field = (key: string): string | null => {
      const value = (row as Record<string, unknown>)[key];
      return typeof value === 'string' && SEMVER.test(value) ? value : null;
    };
    return { announced: field('announced'), installedAnnounced: field('installedAnnounced') };
  } catch { return { ...EMPTY }; }
}

/**
 * Newest published (non-draft) release and whether it is live: the release has
 * every declared desktop asset uploaded AND the public updater feed serves
 * that version. Anything unreadable is not live, never an error.
 */
export async function readLiveRelease(
  run?: ReleaseRunner, feed: MilestoneReader = readPublicReleaseFeed, now: () => Date = () => new Date(),
): Promise<ObservedRelease | null> {
  const newest = await fetchLatestRelease(REPO, run);
  if (!newest || newest.draft || newest.prerelease) return null;
  const version = newest.tag.replace(/^v/, '');
  if (!SEMVER.test(version)) return null;
  const fact = await fetchLatestRelease(REPO, run, newest.tag);
  // Read the feed first: observeMilestones rejects evidence stamped after its `now`.
  let evidence: Awaited<ReturnType<MilestoneReader>> = null;
  try { evidence = await feed(REPO, newest.tag); } catch { evidence = null; }
  const [published, feedReady] = await observeMilestones(REPO, newest.tag, fact, now(), async () => evidence);
  return { version, live: published?.status === 'observed' && feedReady?.status === 'observed' };
}

export interface ReleaseAnnounceDeps {
  stateDir: string;
  readRelease(): Promise<ObservedRelease | null>;
  readInstalled(): string | null;
  /** Synchronous so the locked read-plan-post-write section never yields. */
  post(text: string): void;
}
export interface ReleaseAnnounceResult { posted: string[]; skipped: 'locked' | null }

export async function runReleaseAnnouncement(deps: ReleaseAnnounceDeps): Promise<ReleaseAnnounceResult> {
  // Network reads stay outside the lock; the lock only guards the sync section.
  const release = await deps.readRelease();
  let installed: string | null = null;
  try { installed = deps.readInstalled(); } catch { installed = null; }
  ensurePrivateDirectory(deps.stateDir);
  const path = join(deps.stateDir, 'release-announce.json');
  const lock = acquireLocalStoreLockWithOutcome(`${path}.lock`);
  if (lock.state !== 'acquired') return { posted: [], skipped: 'locked' };
  const posted: string[] = [];
  try {
    let state: ReleaseAnnounceState;
    try { state = parseReleaseAnnounceState(readPrivateFileCapped(path, STATE_MAX_BYTES)?.text ?? null); }
    catch { state = { ...EMPTY }; }
    const plan = planReleaseAnnouncement(state, release, installed);
    // A failed post leaves the state unadvanced, so the next tick retries it.
    for (const message of plan.messages) { deps.post(message); posted.push(message); }
    if (JSON.stringify(plan.state) !== JSON.stringify(state)) {
      writePrivateFileAtomic(path, `${JSON.stringify(plan.state)}\n`);
    }
  } finally { releaseLocalStoreLock(lock.lock); }
  return { posted, skipped: null };
}

/** Production wiring: the owner thread post, the installed bundle, the Leader state dir. */
export async function runDefaultReleaseAnnouncement(): Promise<ReleaseAnnounceResult> {
  const [thread, update, memo] = await Promise.all([
    import('../vision/leader-thread.js'), import('../app-update-status.js'), import('../vision/leader-memo.js'),
  ]);
  return runReleaseAnnouncement({
    stateDir: memo.leaderRoot(),
    readRelease: () => readLiveRelease(),
    readInstalled: update.readInstalledBundleVersion,
    post: text => { thread.postLeaderMessage({ channel: 'telegram', kind: 'update', text }); },
  });
}
