/**
 * The phone opens here, and everything on it is one read: `phm home --json`
 * (home.v1, GET /api/verse/fleet/runs/home). What needs you comes first with
 * its one-word answers, then four plain numbers, then a box to message the
 * leader. A fact the Mac could not read says Unknown with the reason, never 0.
 *
 * Writes use paths that already exist: an answer is `phm asks answer`
 * (POST .../needs-mason/asks/answer) and a message is the fleet inbox.
 */
import { useState } from 'react';
import type { AskAnswer, AskAnswerResult } from '../../../../../core/fleet/asks.js';
import type { HomeField, HomeSummary } from '../../../../../core/fleet/home.js';
import { getMutationToken, touchMutationHold } from '../../../../data/auth-store.js';
import { refetchQuery } from '../../../../data/cache.js';
import { apiGet, apiPost, readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import type { QueryDef } from '../../../../data/queries.js';
import { ASKS_ANSWER_PATH } from '../../home/AsksCard.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { runMobileAction } from '../mobile-actions.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { MobileInterject } from '../MobileInterject.js';
import type { MobileRoute } from '../mobile-router.js';
import { showMobileToast } from '../mobile-toast.js';
import { Button, SkeletonList } from '../ui.js';
import { ui } from '../ui-parts.js';
import styles from './HomeScreen.module.css';

export const HOME_PATH = '/api/verse/fleet/runs/home';
/** Null when the Mac answered with something that is not this home.v1 (an older build, before needsYou). */
export const homeQuery: QueryDef<HomeSummary | null> = {
  key: 'mobile-home',
  async fetch(signal) {
    const value = await apiGet<Partial<HomeSummary> | null>(HOME_PATH, signal);
    return value?.schema === 'home.v1' && !!value.running && !!value.main && !!value.mergedLastHour && !!value.merged24h && !!value.needsYou ? value as HomeSummary : null;
  },
};
export const refreshHomeGlance = (): Promise<unknown> => refetchQuery(homeQuery.key, () => homeQuery.fetch(), true).catch(() => undefined);

const WORDS: Record<AskAnswer, string> = { yes: 'Yes', no: 'No', done: 'Done' };
/** Asks drawn at once; the rest surface as these are answered, so the numbers stay on the first screen. */
export const NEEDS_SHOWN = 2;

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

function ageText(seconds: number | null): string {
  if (seconds === null) return 'asked at an unknown time';
  if (seconds < 90) return 'asked just now';
  return seconds < 5400 ? `asked ${Math.round(seconds / 60)} min ago` : `asked ${Math.round(seconds / 3600)} h ago`;
}

function NeedsYou({ needs }: { needs: HomeSummary['needsYou'] }) {
  const { permissions } = useMobile();
  const [answered, setAnswered] = useState<string[]>([]);
  if (needs.state === 'unknown') return <p className={styles.needsNote} data-tone="unknown">Needs you: unknown. {needs.reason}</p>;
  const open = needs.value.filter((ask) => !answered.includes(ask.id));
  if (open.length === 0) return <p className={styles.needsNote}>Nothing needs you.</p>;
  const answer = (id: string, word: AskAnswer) => runMobileAction({
    title: 'Answer', consequences: '', confirmLabel: WORDS[word], confirm: false,
    run: async () => {
      const outcome = await apiPost<AskAnswerResult>(ASKS_ANSWER_PATH, { id, answer: word }, getMutationToken() ?? '');
      if (outcome.status !== 'answered' && outcome.status !== 'already-answered') throw new Error(outcome.reason ?? 'The answer was not recorded.');
      touchMutationHold();
    },
    onDone: () => {
      setAnswered((ids) => [...ids, id]);
      showMobileToast(`Sent: ${word}`, 'success');
      void refreshHomeGlance();
    },
  });
  return (
    <section className={`${ui.card} ${styles.needs}`} aria-label="Needs you">
      <h2 className={styles.needsTitle}>Needs you · {open.length}</h2>
      {open.slice(0, NEEDS_SHOWN).map((ask) => (
        <div key={ask.id} className={styles.ask}>
          <p className={styles.askText}>{ask.request}</p>
          <p className={styles.statHint}>{ageText(ask.ageSeconds)}</p>
          {canShowActions(permissions) ? (
            <div className={styles.answers} role="group" aria-label={`Answer: ${ask.request}`}>
              {ask.answers.map((word) => <Button key={word} variant={word === 'yes' ? 'primary' : 'tinted'} onClick={() => answer(ask.id, word)}>{WORDS[word]}</Button>)}
            </div>
          ) : null}
        </div>
      ))}
      {open.length > NEEDS_SHOWN ? <p className={styles.statHint}>{open.length - NEEDS_SHOWN} more after these.</p> : null}
    </section>
  );
}

export function HomeGlance() {
  const { navigate } = useMobile();
  const read = useQuery(homeQuery);
  const refetch = useRefetch(homeQuery);
  usePollWhileVisible(refetch, 15_000);
  const home = read.data ?? null;
  const go = (screen: Extract<MobileRoute['screen'], 'agents' | 'goals' | 'feed' | 'runs' | 'fleet'>) => () => navigate({ screen });
  const merged = (field: HomeField<number>) => view(field, (count) => ({ value: String(count) }));

  if (!home) {
    const loading = read.status === 'loading' || read.status === 'idle';
    return loading ? <SkeletonList rows={4} label="Loading Home" /> : (
      <section className={`${ui.card} ${styles.needs}`} role="alert">
        <p className={styles.askText}>Home is unknown. {read.error ? readFailureReason(read.error) : 'Your Mac’s build does not serve it yet. Update Phantom on your Mac.'}</p>
        <Button variant="tinted" onClick={() => refetch()}>Try again</Button>
      </section>
    );
  }
  const needsFirst = home.needsYou.state === 'ok' && home.needsYou.value.length > 0;
  const tiles = (
    <div className={styles.tiles}>
      <Tile label="Running now" tile={runningTile(home.running)} onClick={go('runs')} />
      <Tile label="Mains green" tile={mainTile(home.main)} onClick={go('fleet')} />
      <Tile label="Merged, last hour" tile={merged(home.mergedLastHour)} onClick={go('feed')} />
      <Tile label="Merged, 24 hours" tile={merged(home.merged24h)} onClick={go('feed')} />
    </div>
  );
  return (
    <>
      {needsFirst ? <NeedsYou needs={home.needsYou} /> : null}
      {tiles}
      {needsFirst ? null : <NeedsYou needs={home.needsYou} />}
      <nav className={styles.links} aria-label="Open">
        <Button variant="tinted" onClick={go('agents')}>Sessions</Button>
        <Button variant="tinted" onClick={go('goals')}>Goals</Button>
        <Button variant="tinted" onClick={go('feed')}>PRs</Button>
      </nav>
      <MobileInterject compact title="Message the leader" placeholder="Say it in plain words." />
    </>
  );
}
