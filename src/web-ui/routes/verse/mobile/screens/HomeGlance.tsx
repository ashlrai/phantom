/**
 * The phone opens here. Approvals come first (the same card as desktop Home,
 * built on `phm approvals`: one row per decision, one big button per option),
 * then four plain numbers from one read of `phm home --json` (home.v1, GET
 * /api/verse/fleet/runs/home), then a box to message the leader. A fact the Mac
 * could not read says Unknown with the reason, never 0.
 *
 * Writes use paths that already exist: an answer is `phm approvals answer`
 * (POST .../needs-mason/approvals/answer) and a message is the fleet inbox.
 */
import type { HomeField, HomeSummary } from '../../../../../core/fleet/home.js';
import { refetchQuery } from '../../../../data/cache.js';
import { apiGet, readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import type { QueryDef } from '../../../../data/queries.js';
import { ApprovalsCard, approvalAsksQuery } from '../../home/ApprovalsCard.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { MobileInterject } from '../MobileInterject.js';
import type { MobileRoute } from '../mobile-router.js';
import { Button, SkeletonList } from '../ui.js';
import { ui } from '../ui-parts.js';
import styles from './HomeScreen.module.css';

export const HOME_PATH = '/api/verse/fleet/runs/home';
/** Approvals drawn at once; the rest surface as these are answered, so the numbers stay on the first screen. */
export const APPROVALS_SHOWN = 2;
/** Null when the Mac answered with something that is not this home.v1 (an older build, before needsYou). */
export const homeQuery: QueryDef<HomeSummary | null> = {
  key: 'mobile-home',
  async fetch(signal) {
    const value = await apiGet<Partial<HomeSummary> | null>(HOME_PATH, signal);
    return value?.schema === 'home.v1' && !!value.running && !!value.main && !!value.mergedLastHour && !!value.merged24h && !!value.needsYou ? value as HomeSummary : null;
  },
};
export const refreshHomeGlance = (): Promise<unknown> => Promise.all([
  refetchQuery(homeQuery.key, () => homeQuery.fetch(), true).catch(() => undefined),
  refetchQuery(approvalAsksQuery.key, () => approvalAsksQuery.fetch(), true).catch(() => undefined),
]);

interface TileView { value: string; hint?: string; tone?: 'alert' | 'ok' | 'unknown' }
const unknownTile = (reason: string): TileView => ({ value: 'Unknown', hint: reason, tone: 'unknown' });
const view = <T,>(field: HomeField<T>, known: (value: T) => TileView): TileView => field.state === 'ok' ? known(field.value) : unknownTile(field.reason);

export function runningTile(running: HomeSummary['running']): TileView {
  return view(running, (lanes) => {
    const total = lanes.reduce((sum, lane) => sum + lane.running, 0);
    const wanted = lanes.every((lane) => lane.target !== null) ? lanes.reduce((sum, lane) => sum + (lane.target ?? 0), 0) : null;
    return { value: String(total), hint: wanted === null ? undefined : `of ${wanted} wanted` };
  });
}

export function mainTile(main: HomeSummary['main']): TileView {
  return view(main, (repos) => {
    const names = (state: string) => repos.filter((repo) => repo.state === state).map((repo) => repo.repo).join(', ');
    const red = names('red'), dim = names('unknown'), green = repos.filter((repo) => repo.state === 'green').length;
    return {
      value: `${green} of ${repos.length}`,
      hint: red ? `Red: ${red}` : dim ? `Not known: ${dim}` : 'Every main is green',
      tone: red ? 'alert' : dim ? 'unknown' : 'ok',
    };
  });
}

function Tile({ label, tile, onClick }: { label: string; tile: TileView; onClick: () => void }) {
  return (
    <button type="button" className={`${styles.stat} ${styles.tile}`} onClick={onClick}>
      <span className={styles.statValue} data-tone={tile.tone}>{tile.value}</span>
      <span className={styles.statLabel}>{label}</span>
      {tile.hint ? <span className={styles.statHint}>{tile.hint}</span> : null}
    </button>
  );
}

export function HomeGlance() {
  const { navigate, permissions } = useMobile();
  const read = useQuery(homeQuery);
  const refetch = useRefetch(homeQuery);
  usePollWhileVisible(refetch, 15_000);
  const home = read.data ?? null;
  const go = (screen: Extract<MobileRoute['screen'], 'agents' | 'goals' | 'feed' | 'runs' | 'fleet'>) => () => navigate({ screen });
  const merged = (field: HomeField<number>) => view(field, (count) => ({ value: String(count) }));

  if (!home) {
    const loading = read.status === 'loading' || read.status === 'idle';
    // Approvals stand on their own API: what only Mason can decide should not wait on the summary.
    return loading ? <SkeletonList rows={4} label="Loading Home" /> : (
      <>
        <ApprovalsCard from="phone" canAnswer={canShowActions(permissions)} limit={APPROVALS_SHOWN} emptyNote="Nothing needs you." />
        <section className={`${ui.card} ${styles.needs}`} role="alert">
          <p className={styles.askText}>Home is unknown. {read.error ? readFailureReason(read.error) : 'Your Mac’s build does not serve it yet. Update Phantom on your Mac.'}</p>
          <Button variant="tinted" onClick={() => refetch()}>Try again</Button>
        </section>
      </>
    );
  }
  return (
    <>
      <ApprovalsCard from="phone" canAnswer={canShowActions(permissions)} limit={APPROVALS_SHOWN} emptyNote="Nothing needs you." />
      <div className={styles.tiles}>
        <Tile label="Running now" tile={runningTile(home.running)} onClick={go('runs')} />
        <Tile label="Mains green" tile={mainTile(home.main)} onClick={go('fleet')} />
        <Tile label="Merged, last hour" tile={merged(home.mergedLastHour)} onClick={go('feed')} />
        <Tile label="Merged, 24 hours" tile={merged(home.merged24h)} onClick={go('feed')} />
      </div>
      <nav className={styles.links} aria-label="Open">
        <Button variant="tinted" onClick={go('agents')}>Sessions</Button>
        <Button variant="tinted" onClick={go('goals')}>Goals</Button>
        <Button variant="tinted" onClick={go('feed')}>PRs</Button>
      </nav>
      <MobileInterject compact title="Message the leader" placeholder="Say it in plain words." />
    </>
  );
}
