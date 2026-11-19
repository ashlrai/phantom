/**
 * routes/verse/fleet-router/FleetRouterPane.tsx: where the next piece of fleet work would go, and
 * where recent work went. Pick a task and a difficulty; the pane asks the router's own preview
 * and draws its answer as the order seats would be tried, each with its provider mark, the share
 * of its usage window already used and its reset, then the seats held back with the router's
 * reason. Below, the recorded decision log is counted by chosen seat. The pane decides nothing.
 */
import { useState } from 'react';
import type { ShadowDecisionRecord } from '../../../../core/routing/budget-store.js';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { RoutingDifficulty, RoutingTask, SeatDecision } from '../../../../core/routing/types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { decisionSummary, describeEligibleAgain, eligibleAgain, heldBackText } from '../fleet/why-seat-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usedPercentText } from '../percent-text.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { formatRelative } from '../verse-model.js';
import styles from './fleet-router.module.css';
import { ROUTER_DIFFICULTIES, ROUTER_TASKS, routeSeats, routerDecisionsQuery, routerPreviewQuery, seatBrand, summarizeDecisions, type RouteSeat } from './router-model.js';

const RECENT = 6;
const labelOf = (view: BudgetView | null, seatId: string | null): string =>
  seatId === null ? 'No seat' : view?.seatInfo.find(seat => seat.seatId === seatId)?.label ?? seatId;
const ago = (iso: string, now: number): string => { const text = formatRelative(iso, now); return text === '' ? 'time unknown' : text === 'now' ? 'just now' : `${text} ago`; };

function Usage({ seat, now }: { seat: RouteSeat; now: number }) {
  if (seat.free) return <span className={styles.usage}>Local: no usage window</span>;
  if (seat.usedPercent === null) return <span className={styles.usage}><span className={styles.track} data-unknown role="img" aria-label={`${seat.label} usage unknown`} />Usage unknown</span>;
  const used = Math.max(0, Math.min(100, seat.usedPercent));
  const text = `${usedPercentText(seat.usedPercent)} of the ${seat.window} window used`;
  return <span className={styles.usage}>
    <span className={styles.track} role="img" aria-label={`${seat.label}: ${text}`}><span className={styles.fill} data-high={used >= 90 || undefined} style={{ width: `${used}%` }} /></span>
    {text}{seat.resetAt ? ` · resets ${describeResetAt(seat.resetAt, now) ?? seat.resetAt}` : ' · reset unknown'}
  </span>;
}

function Route({ decision, view, now }: { decision: SeatDecision; view: BudgetView | null; now: number }) {
  const seats = routeSeats(decision, view);
  const tried = seats.filter(seat => seat.rank !== null), held = seats.filter(seat => seat.rank === null);
  return <>
    <p className={styles.headline} data-route={decision.seatId === null ? 'none' : 'ok'}>
      {decision.seatId === null ? 'No seat can take this right now' : <><BrandMark brand={seatBrand(view, decision.seatId)} size={18} />Goes to {labelOf(view, decision.seatId)}</>}
      <span className={styles.chip}>{decision.mode}</span>
    </p>
    <p className={styles.meta}>{decisionSummary(decision)}</p>
    {tried.length ? <ol className={styles.route} aria-label="Try order">{tried.map(seat => <li key={seat.seatId} className={styles.seat} data-first={seat.rank === 1 || undefined}>
      <span className={styles.rank} aria-hidden="true">{seat.rank}</span>
      <span className={styles.name}><BrandMark brand={seat.brand} size={16} />{seat.label}</span>
      <Usage seat={seat} now={now} />
    </li>)}</ol> : null}
    {held.length ? <>
      <h3 className={styles.sub}>Held back</h3>
      <ul className={styles.route} aria-label="Held back">{held.map(seat => <li key={seat.seatId} className={styles.seat} data-held>
        <span className={styles.rank} aria-hidden="true">–</span>
        <span className={styles.name}><BrandMark brand={seat.brand} size={16} />{seat.label}</span>
        <span className={styles.usage}>{heldBackText(seat.held!) || 'The router gave no reason.'} Eligible again: {describeEligibleAgain(eligibleAgain(seat.held!), now)}.</span>
        <Usage seat={seat} now={now} />
      </li>)}</ul>
    </> : null}
    {view ? null : <p className={styles.note}>Seat usage is unknown: the budget reading did not answer.</p>}
  </>;
}

function Log({ records, view, now }: { records: readonly ShadowDecisionRecord[]; view: BudgetView | null; now: number }) {
  if (records.length === 0) return <p className={styles.meta}>No routing decisions are recorded yet.</p>;
  const log = summarizeDecisions(records);
  return <>
    <p className={styles.meta}>Last {log.total} recorded{log.from ? `, since ${ago(log.from, now)}` : ''}. {log.ranKnown === 0 ? 'None of them records which seat actually ran.'
      : `${log.ranKnown} record the seat that ran; ${log.ranElsewhere} of those ran on a different seat than the one chosen.`}</p>
    <ul className={styles.bars} aria-label="Decisions by chosen seat">{log.seats.map(seat => {
      const percent = Math.round(seat.share * 100);
      return <li key={String(seat.seatId)} className={styles.bar} aria-label={`${labelOf(view, seat.seatId)}: ${seat.count} of ${log.total} decisions`}>
        <span className={styles.name}>{seat.seatId === null ? null : <BrandMark brand={seatBrand(view, seat.seatId)} size={16} />}{labelOf(view, seat.seatId)}</span>
        <span className={styles.track}><span className={styles.fill} data-none={seat.seatId === null || undefined} style={{ width: `${seat.share * 100}%` }} /></span>
        <span className={styles.count}>{seat.count} · {percent === 0 ? '<1' : percent}%</span>
      </li>;
    })}</ul>
    <h3 className={styles.sub}>Latest</h3>
    <ul className={styles.recent} aria-label="Latest decisions">{records.slice(0, RECENT).map((record, index) => {
      const chosen = record.decision?.seatId ?? null, ran = record.actual?.seatId ?? null;
      return <li key={`${record.at}-${index}`}>
        <span className={styles.when}>{ago(record.at, now)}</span>
        <span>{record.request.difficulty} {record.request.task} · {record.source}</span>
        <span className={styles.name}>{chosen === null ? null : <BrandMark brand={seatBrand(view, chosen)} size={14} />}{labelOf(view, chosen)}</span>
        {ran !== null && ran !== chosen ? <span className={styles.ran}>ran on {labelOf(view, ran)}</span> : null}
      </li>;
    })}</ul>
  </>;
}

export function FleetRouterPane({ visible }: PaneProps) {
  const [task, setTask] = useState<RoutingTask>('code');
  const [difficulty, setDifficulty] = useState<RoutingDifficulty>('medium');
  const previewQuery = routerPreviewQuery(task, difficulty);
  const preview = useQuery(previewQuery, { enabled: visible, freshMs: 0 });
  const budget = useQuery(budgetQuery, { enabled: visible, freshMs: 15_000 });
  const decisions = useQuery(routerDecisionsQuery, { enabled: visible, freshMs: 0 });
  const refetchPreview = useRefetch(previewQuery), refetchBudget = useRefetch(budgetQuery), refetchDecisions = useRefetch(routerDecisionsQuery);
  usePollWhileVisible(() => { refetchPreview(); refetchBudget(); refetchDecisions(); }, 30_000, { enabled: visible });
  const now = Date.now();
  const view = budget.data && Array.isArray(budget.data.seatInfo) && Array.isArray(budget.data.headroom) ? budget.data : null;
  const stale = <p className={styles.note} data-stale role="status">Could not refresh. Showing the last reading.</p>;
  return <section className={styles.root} aria-label="Router">
    <div className={styles.head}>
      <h2>Next {difficulty} {task} task</h2>
      <div className={styles.switches}>
        <Segmented size="sm" aria-label="Task" options={ROUTER_TASKS} value={task} onChange={setTask} />
        <Segmented size="sm" aria-label="Difficulty" options={ROUTER_DIFFICULTIES} value={difficulty} onChange={setDifficulty} />
      </div>
    </div>
    {/* The switches stay put while a combination is read, so a slow or failed read never takes the way back with it. */}
    {preview.data ? <>{preview.status === 'error' ? stale : null}<Route decision={preview.data} view={view} now={now} /></>
      : <p className={styles.meta} role="status">{preview.status === 'error' ? 'Router preview: unknown (the router did not answer).' : 'Asking the router…'}</p>}
    <p className={styles.note}>A preview for autonomous fleet work, from the usage read {view ? ago(view.sampledAt, now) : 'at an unknown time'}. Nothing is launched or reserved.</p>
    <div className={styles.head}><h2>Recorded decisions</h2></div>
    {decisions.data ? <>{decisions.status === 'error' ? stale : null}<Log records={decisions.data} view={view} now={now} /></>
      : <p className={styles.meta} role="status">{decisions.status === 'error' ? 'Decision log: unknown (it could not be read).' : 'Reading the decision log…'}</p>}
    <p className={styles.note}>A decision is the seat the router chose for a request, not proof the work ran there. Same reads: <code>GET /api/verse/budget/preview</code> and <code>GET /api/verse/budget/decisions</code>.</p>
  </section>;
}
