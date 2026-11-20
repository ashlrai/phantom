/**
 * routes/verse/leader/LeaderActivityCard.tsx — the "Leader" card: what the Leader did, without asking.
 * Read only. Backed by the same typed brief as `phm leader brief --json` (leader.brief.v1). Unknown
 * stays unknown with its reason, never zero or a guess. Text is drawn as plain text; links are
 * http(s) only.
 */
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { useNow } from '../autonomy/use-ticker.js';
import { triageAge } from '../fleet-inbox/gmail-triage-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './leader.module.css';

export const LEADER_ACTIVITY_PATH = '/api/verse/comms/leader-brief';
export const LEADER_ACTIVITY_POLL_MS = 5 * 60_000;
const SCHEMA = 'leader.brief.v1';
const SHOWN_BETS = 6;
const COMMAND = 'phm leader brief';

const leaderActivityQuery: QueryDef<unknown> = { key: 'verse-leader-activity', fetch: s => apiGet(LEADER_ACTIVITY_PATH, s) };

type Result = 'published' | 'no_change' | 'running' | 'queued' | 'failed';
export interface Bet { id: string; result: Result; prState: 'open' | 'merged' | null; url: string | null; gap: string | null; at: string | null }
interface Pool { id: string; hoursToReset: number | null }
type Part<T> = { known: true; value: T } | { known: false; reason: string };
export interface LeaderActivity { bets: Part<Bet[]>; bottleneck: Part<string | null>; pools: Part<Pool[]> }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const RESULTS: readonly string[] = ['published', 'no_change', 'running', 'queued', 'failed'];
const unknownPart = (section: unknown, fallback: string): { known: false; reason: string } =>
  ({ known: false, reason: (isObj(section) ? str(section.reason) : null) ?? fallback });

/** The typed brief from a payload; null when it is not ours. Defensive, never repairing. */
export function readActivity(data: unknown): LeaderActivity | null {
  if (!isObj(data) || data.schema !== SCHEMA || data.unavailable === true) return null;
  const { jobs, admission, pools } = data;

  let bets: LeaderActivity['bets'] = unknownPart(jobs, 'the brief did not say');
  if (isObj(jobs) && jobs.known === true && Array.isArray(jobs.rows)) {
    bets = { known: true, value: jobs.rows.filter(isObj).flatMap((r): Bet[] => {
      const id = str(r.id);
      if (!id || typeof r.result !== 'string' || !RESULTS.includes(r.result)) return [];
      return [{ id, result: r.result as Result, prState: r.pr_state === 'open' || r.pr_state === 'merged' ? r.pr_state : null, url: str(r.pr_url), gap: str(r.gap), at: str(r.at) }];
    }) };
  }

  let bottleneck: LeaderActivity['bottleneck'] = unknownPart(admission, 'the brief did not say');
  if (isObj(admission) && admission.known === true) bottleneck = { known: true, value: admission.state === 'closed' ? str(admission.why) : null };

  let poolPart: LeaderActivity['pools'] = unknownPart(pools, 'the brief did not say');
  if (isObj(pools) && pools.known === true && Array.isArray(pools.rows)) {
    poolPart = { known: true, value: pools.rows.filter(isObj).flatMap((r): Pool[] => {
      const id = str(r.id);
      return id ? [{ id, hoursToReset: typeof r.hours_to_reset === 'number' && Number.isFinite(r.hours_to_reset) ? r.hours_to_reset : null }] : [];
    }) };
  }
  return { bets, bottleneck, pools: poolPart };
}

/** `RQ-GIFTOPENN21SQ8` -> "Giftopen": the id without its prefix and batch suffix, in plain letters. */
export function betName(id: string): string {
  const core = id.replace(/^RQ-/i, '').replace(/N\d+[A-Z]Q8$/i, '').replace(/[-_]+/g, ' ').trim() || id;
  return core.charAt(0).toUpperCase() + core.slice(1).toLowerCase();
}

/** When the Leader last made a bet; null when no bet carries a time. */
export function lastPassAt(bets: Bet[]): string | null {
  const times = bets.map(b => b.at).filter((t): t is string => t !== null && Number.isFinite(Date.parse(t)));
  return times.length ? times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

const WORD: Record<Result, string> = { published: 'PR open', no_change: 'no change', running: 'running', queued: 'queued', failed: 'failed' };
const stateWord = (b: Bet): string => (b.result === 'published' ? (b.prState === 'merged' ? 'merged' : 'open') : WORD[b.result]);
const safeUrl = (u: string | null): string | null => (u && /^https?:\/\//i.test(u) ? u : null);
const hours = (h: number | null): string => (h === null ? 'reset unknown' : `resets in ${Math.max(0, Math.round(h))} h`);

export function LeaderActivityCard() {
  const query = useQuery(leaderActivityQuery, { freshMs: 60_000 });
  const refetch = useRefetch(leaderActivityQuery);
  const refresh = useRefresh(leaderActivityQuery);
  usePollWhileVisible(refetch, LEADER_ACTIVITY_POLL_MS);
  const now = useNow(30_000);

  if (!query || (query.status !== 'error' && query.data === undefined)) return null;
  const a = readActivity(query.data);
  const last = a && a.bets.known ? lastPassAt(a.bets.value) : null;
  const head = `Leader · ${a ? (last ? `last pass ${triageAge(last, now)}` : 'last pass unknown') : 'unavailable'}`;

  return (
    <section className={styles.activity} aria-label="Leader">
      <div className={styles.briefHead}>
        <h3 className={styles.activityTitle}>{head}</h3>
        <button type="button" className={styles.briefRefresh} onClick={refresh} disabled={query.status === 'refreshing'}>Refresh</button>
      </div>
      {!a ? (
        <p className={styles.briefLine}>Leader brief unavailable. Run <code>{COMMAND} --json</code>.</p>
      ) : (
        <div className={styles.briefBody}>
          {a.bets.known ? (
            a.bets.value.length === 0 ? <p className={styles.briefLine}>No bets in the last day.</p> : (
              <ul className={styles.activityList}>
                {a.bets.value.slice(0, SHOWN_BETS).map(b => {
                  const url = safeUrl(b.url);
                  return (
                    <li key={b.id} className={styles.activityBet}>
                      <span className={styles.activityName}>{betName(b.id)}</span>
                      <span className={styles.activityState} data-result={b.result}>{stateWord(b)}</span>
                      {url ? <a href={url} target="_blank" rel="noopener noreferrer">PR</a> : null}
                      {b.result === 'no_change' ? <span className={styles.activityWhy}>{b.gap ?? 'reason unknown'}</span> : null}
                    </li>
                  );
                })}
                {a.bets.value.length > SHOWN_BETS ? <li className={styles.briefLine}>and {a.bets.value.length - SHOWN_BETS} more</li> : null}
              </ul>
            )
          ) : <p className={styles.briefLine}>Bets unknown: {a.bets.reason}.</p>}
          {a.bottleneck.known
            ? (a.bottleneck.value ? <p className={styles.briefLine}><strong>Held back:</strong> {a.bottleneck.value}</p> : null)
            : <p className={styles.briefLine}>Bottleneck unknown: {a.bottleneck.reason}.</p>}
          {a.pools.known
            ? (a.pools.value.length ? <p className={styles.briefLine}>{a.pools.value.map(p => `${p.id} ${hours(p.hoursToReset)}`).join(' · ')}</p> : null)
            : <p className={styles.briefLine}>Pools unknown: {a.pools.reason}.</p>}
        </div>
      )}
    </section>
  );
}
