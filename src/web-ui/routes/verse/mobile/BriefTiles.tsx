/**
 * The phone's first screen: is the fleet doing well, as four big numbers, each a tap from its detail.
 * Reads the same fleet.brief.v1 as `phm status --brief --json`. A number the Mac could not read says
 * "unknown", never 0. Green or red appears only where it means something: main branches, and a plan
 * that runs out before it resets.
 */
import { FLEET_BRIEF_SCHEMA, type FleetBrief } from '../../../../core/fleet/status-brief.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useMobile } from './mobile-context.js';
import styles from './BriefTiles.module.css';

export const BRIEF_PATH = '/api/verse/fleet/runs/brief';
/** Null for anything that is not a fleet.brief.v1 (an older Mac build). */
export const briefQuery: QueryDef<FleetBrief | null> = {
  key: 'mobile-brief',
  async fetch(signal) {
    const value = await apiGet<Partial<FleetBrief> | null>(BRIEF_PATH, signal);
    return value?.schema === FLEET_BRIEF_SCHEMA && !!value.merged && !!value.main && !!value.runway ? value as FleetBrief : null;
  },
};

type Tone = 'good' | 'bad' | undefined;
interface Tile { id: string; label: string; value: string; note: string; tone: Tone }

/** Plain hours: "40 min", "5 h", "5.5 h". */
export const hoursText = (h: number): string => (h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h * 10) / 10} h`);
const num = (n: number | null, say: (n: number) => string = String): string => (n === null ? 'unknown' : say(n));

const NOTHING_READ: Pick<FleetBrief, 'merged' | 'main' | 'runway'> = {
  merged: { lastHour: null, last24h: null }, main: { green: null, total: null, red: [] },
  runway: { state: 'unknown', pool: null, hoursLeft: null, beforeReset: null },
};

/** Pure: the four tiles, in the order they are drawn. */
export function briefTiles(b: FleetBrief | null): Tile[] {
  const { merged, main, runway } = b ?? NOTHING_READ;
  const mainTone: Tone = main.green === null ? undefined : main.red.length > 0 ? 'bad' : main.green === main.total ? 'good' : undefined;
  return [
    { id: 'merged', label: 'Merged last hour', value: num(merged.lastHour), note: `${num(merged.last24h)} in 24 hours`, tone: undefined },
    { id: 'speed', label: 'Time to merge', value: num(b?.medianMergeMinutes ?? null, n => `${n} min`), note: 'typical, last 24 hours', tone: undefined },
    { id: 'main', label: 'Main branches green', value: main.green === null ? 'unknown' : `${main.green} of ${main.total}`,
      note: main.red.length ? `red: ${main.red.join(', ')}` : 'repos with a passing main', tone: mainTone },
    { id: 'runway', label: 'Plan runs out first',
      value: runway.state === 'known' ? hoursText(runway.hoursLeft!) : runway.state === 'steady' ? 'none' : 'unknown',
      note: runway.state === 'known' ? `${runway.pool}${runway.beforeReset ? ', before it resets' : ''}` : runway.state === 'steady' ? 'no plan is running down' : 'plans could not be read',
      tone: runway.state === 'known' && runway.beforeReset ? 'bad' : undefined },
  ];
}

export function BriefTilesView({ brief, onOpen }: { brief: FleetBrief | null; onOpen: () => void }) {
  return (
    <section className={styles.tiles} aria-label="Fleet at a glance">
      {briefTiles(brief).map(tile => (
        <button key={tile.id} type="button" className={styles.tile} data-tone={tile.tone} data-unknown={tile.value === 'unknown' || undefined}
          aria-label={`${tile.label}: ${tile.value}. ${tile.note}. Open details.`} onClick={onOpen}>
          <span className={styles.label}>{tile.label}</span>
          <span className={styles.value}>{tile.value}</span>
          <span className={styles.note}>{tile.note}</span>
        </button>
      ))}
    </section>
  );
}

export function BriefTiles() {
  const { navigate } = useMobile();
  const read = useQuery(briefQuery);
  const refetch = useRefetch(briefQuery);
  usePollWhileVisible(refetch, 30_000);
  return <BriefTilesView brief={read.data ?? null} onOpen={() => navigate({ screen: 'fleet' })} />;
}
