/**
 * lane-caps.ts: view model for the lane capability badges (gh, browser,
 * network, signed-in) on the fleet map and the phone lane list.
 *
 * The typed capability table (`phm lanes caps --json`, #7590) is not on this
 * branch's base yet, so `LaneCaps` is a deliberately small local shape. A
 * capability that is absent or not a boolean is "unknown": never guessed.
 */
export const LANE_CAP_KEYS = ['gh', 'browser', 'network', 'signedIn'] as const;
export type LaneCapKey = (typeof LANE_CAP_KEYS)[number];
export type LaneCaps = Partial<Record<LaneCapKey, boolean | null>>;
export type LaneCapState = 'yes' | 'no' | 'unknown';

export interface LaneCapBadge {
  key: LaneCapKey;
  state: LaneCapState;
  /** Plain words shown on the badge. */
  text: string;
  /** One-sentence explanation for hover/tap. */
  hint: string;
}

const WORDS: Record<LaneCapKey, { name: string; yes: string; no: string; unknown: string }> = {
  gh: { name: 'gh', yes: 'gh: jobs that run gh can run here.', no: 'no gh: jobs that run gh go elsewhere.', unknown: 'gh unknown: this lane has not reported whether it has gh.' },
  browser: { name: 'browser', yes: 'browser: jobs that need a browser can run here.', no: 'no browser: jobs that need a browser go elsewhere.', unknown: 'browser unknown: this lane has not reported whether it has a browser.' },
  network: { name: 'network', yes: 'network: jobs that need the internet can run here.', no: 'no network: jobs that need the internet go elsewhere.', unknown: 'network unknown: this lane has not reported whether it has network access.' },
  signedIn: { name: 'signed in', yes: 'signed in: this lane is logged in to its provider.', no: 'not signed in: this lane cannot run jobs until it is signed in.', unknown: 'signed in unknown: this lane has not reported its sign-in state.' },
};

export function laneCapBadges(caps: LaneCaps | null | undefined): LaneCapBadge[] {
  return LANE_CAP_KEYS.map((key) => {
    const raw = caps?.[key];
    const state: LaneCapState = raw === true ? 'yes' : raw === false ? 'no' : 'unknown';
    const w = WORDS[key];
    return { key, state, text: state === 'yes' ? w.name : state === 'no' ? `no ${w.name}` : `${w.name}: unknown`, hint: w[state === 'yes' ? 'yes' : state === 'no' ? 'no' : 'unknown'] };
  });
}
