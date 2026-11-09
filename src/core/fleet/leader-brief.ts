import { readInstalledBundleVersion, versionNewer } from '../app-update-status.js';
import { defaultReleasePublicReader, discoverLatestRelease } from '../release-public-facts.js';
import { listGoalsDetailed } from '../goals/store.js';
import { progressOf } from '../goals/advance.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { goalLine, openGoals } from '../../web-ui/routes/verse/goals-pane/goals-pane-model.js';
import type { GoalSummary } from '../../web-ui/data/queries.js';

export interface BriefInputs {
  merges24h: number | null; openPrs: number | null;
  installed: string | null; latest: string | null; needsMason: number | null;
  goals: GoalSummary[] | null; lanes: string[] | null;
}
export interface LeaderBrief {
  at: string; merges24h: number | null; openPrs: number | null;
  release: { installed: string | null; latest: string | null; behind: boolean | null };
  needsMason: number | null; goals: Array<{ objective: string; percentText: string }>;
  lanes: string[]; text: string;
}
const clean = (value: string, limit: number) => value.replace(/\s+/g, ' ').trim().slice(0, limit);
const count = (value: number | null) => value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
const version = (value: string | null) => value && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value) ? value : null;
export function buildLeaderBrief(input: BriefInputs, now: number | Date): LeaderBrief {
  const installed = version(input.installed), latest = version(input.latest);
  const merges24h = count(input.merges24h), openPrs = count(input.openPrs), needsMason = count(input.needsMason);
  const goals = input.goals === null ? [] : openGoals(input.goals).slice(0, 3).map(goalLine).map(g => ({ objective: clean(g.objective, 100), percentText: clean(g.percentText, 20) }));
  const lanes = (input.lanes ?? []).slice(0, 6).map(lane => clean(lane, 30));
  const release = { installed, latest, behind: installed && latest ? versionNewer(latest, installed) : null };
  const lines = [
    `Merges (24h): ${merges24h ?? 'unknown'}; open PRs: ${openPrs ?? 'unknown'}`,
    `Release: installed ${installed ?? 'unknown'}; latest published ${latest ?? 'unknown'}`,
    `Needs Mason: ${needsMason ?? 'unknown'}`,
    `Goals: ${input.goals === null ? 'unknown' : goals.length ? goals.map(g => `${g.objective} (${g.percentText})`).join('; ') : 'none'}`,
    `Lanes: ${input.lanes === null ? 'unknown' : lanes.length ? lanes.join('; ') : 'none'}`,
  ];
  return { at: new Date(now).toISOString(), merges24h, openPrs, release, needsMason, goals, lanes, text: lines.join('\n').slice(0, 700) };
}

type Reader<T> = () => T | Promise<T>;
export interface BriefReaders {
  fleet: Reader<{ merges24h: number | null; openPrs: number | null }>;
  installed: Reader<string | null>; latest: Reader<string | null>;
  needsMason: Reader<number | null>; goals: Reader<GoalSummary[] | null>; lanes: Reader<string[] | null>;
}
const defaults: BriefReaders = {
  async fleet() {
    const { buildFleetLiveSnapshot } = await import('../verse/fleet-live-api.js');
    const { snapshot } = await buildFleetLiveSnapshot();
    // The ledger's open-PR projection is limited to fleet-observed events and
    // cannot establish the total number of open PRs.
    return { merges24h: snapshot.merged24h?.length ?? null, openPrs: null };
  },
  installed: readInstalledBundleVersion,
  latest: async () => (await discoverLatestRelease('ashlrai/phantom', defaultReleasePublicReader())).version,
  // The desktop drawer combines process-local and cached producers; a CLI process
  // cannot establish that every producer is ready, so do not claim an all-clear.
  needsMason: () => null,
  goals() {
    const read = listGoalsDetailed();
    if (!read.complete || read.sourceState !== 'healthy') return null;
    return read.goals.map(g => ({ ...g, progress: { ...progressOf(g), counts: progressOf(g).byStatus } }));
  },
  async lanes() {
    const state = await readFleetRunsDirState();
    if (state.sources.status !== 'healthy') return null;
    const { subscriptionUsage } = await import('./subscription-usage.js');
    const usage = subscriptionUsage('codex');
    return [`codex usage ${usage ? `${usage.usedPercent}% ${usage.windowLabel}` : 'unknown'}`, ...state.lanes.map(l => `${l.lane} ${l.running}/${l.target}`)];
  },
};
export async function readLeaderBrief(opts: { readers?: Partial<BriefReaders>; now?: () => number } = {}): Promise<LeaderBrief> {
  const readers = { ...defaults, ...opts.readers };
  const safe = async <T>(read: Reader<T>): Promise<T | null> => { try { return await read(); } catch { return null; } };
  const [fleet, installed, latest, needsMason, goals, lanes] = await Promise.all([
    safe(readers.fleet), safe(readers.installed), safe(readers.latest), safe(readers.needsMason), safe(readers.goals), safe(readers.lanes),
  ]);
  return buildLeaderBrief({ merges24h: fleet?.merges24h ?? null, openPrs: fleet?.openPrs ?? null, installed, latest, needsMason, goals, lanes }, (opts.now ?? Date.now)());
}
