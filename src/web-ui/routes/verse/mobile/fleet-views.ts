/**
 * routes/verse/mobile/fleet-views.ts — the fleet's read-only views on the
 * phone, as one short list in plain words. More ▸ "Fleet views" renders it;
 * the test walks it. Each view is backed by an API and a CLI verb that
 * already exist (named in `cli`), so an agent reads what the phone shows.
 */
import type { MobileRoute } from './mobile-router.js';

export interface FleetView {
  screen: Extract<MobileRoute['screen'], 'goals' | 'spend' | 'pools' | 'held' | 'library' | 'graph'>;
  title: string;
  subtitle: string;
  /** The CLI verb that prints the same data. */
  cli: string;
}

export const FLEET_VIEWS: readonly FleetView[] = [
  { screen: 'goals', title: 'Goals', subtitle: 'What the fleet is aiming for, and how far along each is', cli: 'phm goals --json' },
  { screen: 'spend', title: 'Spend down', subtitle: 'Each pool: used so far against the pace to its reset', cli: 'phm spend --json' },
  { screen: 'pools', title: 'Pool runway', subtitle: 'How long each pool lasts at its current pace', cli: 'phm pool runway --json' },
  { screen: 'held', title: 'Held work', subtitle: 'Jobs and lanes that are not running, and the one step that frees each', cli: 'phm fleet held --json' },
  { screen: 'library', title: 'Library', subtitle: 'Files, memory, messages and context in one search', cli: 'phm library --json' },
  { screen: 'graph', title: 'Message graph', subtitle: 'Who has been messaging whom, by organization', cli: 'phm fleet message-graph --json' },
];
