/**
 * routes/verse/fleet-router/FleetRouterPane.tsx: where every kind of fleet work would go, and
 * where recent work went. The route table is the router's own answer for each task at each
 * difficulty, one unlogged preview per cell; choosing a cell draws that answer as the order seats would
 * be tried, each with its provider mark, the share of its usage window already used and its
 * reset, then the seats held back with the router's reason. The seats board turns the table on
 * its side: a row per seat, where it stands for every kind of work. Below, the recorded decision log
 * is counted by chosen seat and drawn over time: a lane per seat, a column per equal slice of
 * the span read, each column readable on its own. The pane decides nothing.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import type { ShadowDecisionRecord } from '../../../../core/routing/budget-store.js';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { RoutingDifficulty, RoutingTask, SeatDecision } from '../../../../core/routing/types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { Button } from '../../../components/primitives/Button.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { WindowBar } from '../../../components/primitives/WindowBar.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { decisionSummary, describeEligibleAgain, eligibleAgain, heldBackText } from '../fleet/why-seat-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usedPercentText } from '../percent-text.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { formatRelative } from '../verse-model.js';
import { DecisionFlow } from './DecisionFlow.js';
import { pinMatches, type FlowPin } from './decision-flow-model.js';
import { TIMELINE_COLUMNS, columnWords, decisionTimeline, stepColumn, timelineWords } from './decision-timeline-model.js';
import styles from './fleet-router.module.css';
import { SeatPoolBoard } from './SeatPool.js';
import { ROUTER_DIFFICULTIES, ROUTER_KINDS, ROUTER_TASKS, routeAt, routeSeats, routerDecisionsQuery, routerRoutesQuery, seatBrand, summarizeDecisions, tableShares, type BudgetRoute, type RouteSeat } from './router-model.js';

const KINDS = ROUTER_KINDS;

const RECENT = 6;
const AUDIENCES = [{ value: 'fleet', label: 'Fleet work' }, { value: 'owner', label: 'Your request' }] as const;
type Audience = typeof AUDIENCES[number]['value'];
const labelOf = (view: BudgetView | null, seatId: string | null): string =>
  seatId === null ? 'No seat' : view?.seatInfo.find(seat => seat.seatId === seatId)?.label ?? seatId;
/** A column's edge on the time axis; a span of most of a day or more names the day too. */
const clock = (days: boolean) => (ms: number): string => new Date(ms).toLocaleString(undefined, days ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
const ago = (iso: string, now: number): string => { const text = formatRelative(iso, now); return text === '' ? 'time unknown' : text === 'now' ? 'just now' : `${text} ago`; };

function Usage({ seat, now }: { seat: RouteSeat; now: number }) {
  if (seat.free) return <span className={styles.usage}>Local: no usage window</span>;
  if (seat.usedPercent === null) return <span className={styles.usage}><WindowBar className={styles.meter} label={`${seat.label} usage`} valueText="Usage unknown" valueNow={null} used={null} />Usage unknown</span>;
  const text = `${usedPercentText(seat.usedPercent)} of the ${seat.window} window used`;
  return <span className={styles.usage}>
    <WindowBar className={styles.meter} label={`${seat.label} ${seat.window} window used`} valueText={text} valueNow={seat.usedPercent} used={seat.usedPercent} />
    {text}{seat.resetAt ? ` · resets ${describeResetAt(seat.resetAt, now) ?? seat.resetAt}` : ' · reset unknown'}
  </span>;
}

/** Arrow keys walk the table's cells; Home and End jump along the row. Enter or Space chooses, as on any button. */
function moveFocus(event: KeyboardEvent<HTMLTableElement>) {
  const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Home: [0, -9], End: [0, 9] };
  const delta = step[event.key], from = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]');
  if (!delta || !from) return;
  const [row, col] = from.dataset['cell']!.split('-').map(Number) as [number, number];
  const clamp = (value: number, size: number) => Math.max(0, Math.min(size - 1, value));
  const next = event.currentTarget.querySelector<HTMLElement>(`[data-cell="${clamp(row + delta[0], ROUTER_TASKS.length)}-${clamp(col + delta[1], ROUTER_DIFFICULTIES.length)}"]`);
  if (next) { event.preventDefault(); next.focus(); }
}

function RouteTable({ routes, view, task, difficulty, onPick }: { routes: readonly BudgetRoute[]; view: BudgetView | null; task: RoutingTask; difficulty: RoutingDifficulty;
  onPick: (task: RoutingTask, difficulty: RoutingDifficulty) => void }) {
  return <table className={styles.table} aria-label="Route table" onKeyDown={moveFocus}>
    <thead><tr><td />{ROUTER_DIFFICULTIES.map(column => <th key={column.value} scope="col">{column.label}</th>)}</tr></thead>
    <tbody>{ROUTER_TASKS.map((row, r) => <tr key={row.value}>
      <th scope="row">{row.label}</th>
      {ROUTER_DIFFICULTIES.map((column, c) => {
        const decision = routeAt(routes, row.value, column.value);
        const chosen = row.value === task && column.value === difficulty;
        const kind = `${row.label}, ${column.label.toLowerCase()}`;
        // A cell the table does not hold is unknown, never "no seat".
        if (!decision) return <td key={column.value}><span className={styles.cell} data-route="unknown">Unknown</span></td>;
        const then = decision.seatId === null ? undefined : decision.candidates.find(seatId => seatId !== decision.seatId);
        return <td key={column.value}>
          <button type="button" className={styles.cell} data-cell={`${r}-${c}`} data-route={decision.seatId === null ? 'none' : 'ok'} aria-pressed={chosen}
            tabIndex={chosen ? 0 : -1} onClick={() => onPick(row.value, column.value)}
            aria-label={`${kind}: ${decision.seatId === null ? 'no seat can take it' : `goes to ${labelOf(view, decision.seatId)}`}${then ? `, then ${labelOf(view, then)}` : ''}`}>
            <span className={styles.name}>{decision.seatId === null ? null : <BrandMark brand={seatBrand(view, decision.seatId)} size={14} />}{labelOf(view, decision.seatId)}</span>
            <span className={styles.then}>{decision.seatId === null ? 'nothing eligible' : then ? `then ${labelOf(view, then)}` : 'no second seat'}</span>
          </button>
        </td>;
      })}
    </tr>)}</tbody>
  </table>;
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
  // The column being read, by its place on the time axis. Pointing reads it; a click or the keyboard keeps it.
  const [picked, setPicked] = useState<number | null>(null);
  // The name kept in the flow diagram: the list at the bottom is held to its decisions.
  const [pin, setPin] = useState<FlowPin | null>(null);
  const scrub = useRef<HTMLDivElement>(null);
  if (records.length === 0) return <p className={styles.meta}>No routing decisions are recorded yet.</p>;
  const log = summarizeDecisions(records);
  const timeline = decisionTimeline(records, now);
  const column = timeline && picked !== null ? timeline.columns[picked] ?? null : null;
  const at = clock(timeline !== null && timeline.endMs - timeline.startMs > 20 * 3_600_000);
  const label = (seatId: string | null) => labelOf(view, seatId);
  const keep = (index: number) => { setPicked(index); scrub.current?.focus(); };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Esc lets go of the column first; a second Esc is the pane's.
      if (picked !== null) { event.stopPropagation(); setPicked(null); }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = stepColumn(event.key, picked, TIMELINE_COLUMNS);
    if (next === null) return;
    event.preventDefault();
    setPicked(next);
  };
  // With a column read, the list under the chart is that column's decisions instead of the newest ones.
  const shown = column ? column.records.map(place => records[place]!) : records;
  const listed = pin ? shown.filter(record => pinMatches(pin, record)) : shown;
  const base = column ? 'In this column' : 'Latest';
  return <>
    <p className={styles.meta}>Last {log.total} recorded{log.from ? `, since ${ago(log.from, now)}` : ''}. {log.ranKnown === 0 ? 'None of them records which seat actually ran.'
      : `${log.ranKnown} record the seat that ran; ${log.ranElsewhere} of those ran on a different seat than the one chosen.`}</p>
    {/* Leaving the chart lets go of a column that was only pointed at; one kept with a click or the keyboard stays. */}
    <div className={styles.timeline} onMouseLeave={() => { if (document.activeElement !== scrub.current) setPicked(null); }}>
    <ul className={styles.bars} aria-label="Decisions by chosen seat">{log.seats.map(seat => {
      const percent = Math.round(seat.share * 100);
      const lane = timeline?.lanes.find(row => row.seatId === seat.seatId);
      return <li key={String(seat.seatId)} className={styles.bar} aria-label={`${labelOf(view, seat.seatId)}: ${seat.count} of ${log.total} decisions`}>
        <span className={styles.name}>{seat.seatId === null ? null : <BrandMark brand={seatBrand(view, seat.seatId)} size={16} />}{labelOf(view, seat.seatId)}</span>
        {/* The lane: this seat's decisions in each column, every lane against the same tallest cell. Without a readable time there is only the share. */}
        {timeline ? <span className={styles.bins} aria-hidden="true">{timeline.columns.map((_, index) => {
          const count = lane?.counts[index] ?? 0;
          return <span key={index} className={styles.bin} data-bin={index} data-picked={picked === index || undefined} data-moved={(lane?.moved[index] ?? 0) > 0 || undefined}
            onMouseEnter={() => setPicked(index)} onClick={() => keep(index)}>
            {count > 0 ? <span className={styles.stem} data-none={seat.seatId === null || undefined} style={{ height: `${count / timeline.peak * 100}%` }} /> : null}
          </span>;
        })}</span>
          : <span className={styles.track}><span className={styles.fill} data-none={seat.seatId === null || undefined} style={{ width: `${seat.share * 100}%` }} /></span>}
        <span className={styles.count}>{seat.count} · {percent === 0 ? '<1' : percent}%</span>
      </li>;
    })}</ul>
    {timeline ? <div className={styles.axis}>
      {/* The time axis is the one tab stop: a slider with a value per column, each said in full. */}
      <div ref={scrub} className={styles.scrub} role="slider" tabIndex={0} aria-label="Recorded decisions over time" aria-orientation="horizontal"
        aria-valuemin={1} aria-valuemax={TIMELINE_COLUMNS} aria-valuenow={(picked ?? TIMELINE_COLUMNS - 1) + 1}
        aria-valuetext={picked === null ? timelineWords(timeline) : columnWords(timeline, picked, label, at)}
        onKeyDown={key} onBlur={() => setPicked(null)}>
        {timeline.columns.map((tick, index) => <span key={index} className={styles.tick} data-tick={index} data-picked={picked === index || undefined}
          data-empty={tick.total === 0 || undefined} data-moved={tick.moved > 0 || undefined} onMouseEnter={() => setPicked(index)} onClick={() => setPicked(index)} />)}
      </div>
      <span className={styles.ends} aria-hidden="true"><span>{at(timeline.startMs)}</span><span>{timeline.endMs > now ? at(timeline.endMs) : 'now'}</span></span>
    </div> : null}
    </div>
    {timeline === null ? <p className={styles.caption}>None of these decisions carries a readable time, so they are not drawn over time.</p>
      : picked === null ? <p className={styles.caption}>{timelineWords(timeline)}{log.ranElsewhere > 0 ? ' An amber cap marks work that ran on another seat.' : ''} Point at a column, or use the arrow keys on the time axis, to read it.</p>
        : <p className={styles.caption} data-column={picked + 1}>{columnWords(timeline, picked, label, at)}</p>}
    {/* The same decisions as a flow: the column being read when there is one, else every decision read. */}
    <DecisionFlow records={shown} label={label} brand={seatId => seatBrand(view, seatId)} pin={pin} onPin={setPin} />
    {pin ? <div className={styles.head}><h3 className={styles.sub}>{base}: {pin.label}</h3><Button size="sm" onClick={() => setPin(null)}>Show all</Button></div>
      : <h3 className={styles.sub}>{base}</h3>}
    {column && shown.length === 0 ? <p className={styles.caption}>No decisions in this column.</p>
      : pin && listed.length === 0 ? <p className={styles.caption}>No decisions for {pin.label}{column ? ' in this column' : ''}.</p> : null}
    <ul className={styles.recent} aria-label={column ? 'Decisions in this column' : 'Latest decisions'}>{listed.slice(0, RECENT).map((record, index) => {
      const chosen = record.decision?.seatId ?? null, ran = record.actual?.seatId ?? null;
      return <li key={`${record.at}-${index}`}>
        <span className={styles.when}>{ago(record.at, now)}</span>
        <span>{record.request.difficulty} {record.request.task} · {record.source}</span>
        <span className={styles.name}>{chosen === null ? null : <BrandMark brand={seatBrand(view, chosen)} size={14} />}{labelOf(view, chosen)}</span>
        {ran !== null && ran !== chosen ? <span className={styles.ran}>ran on {labelOf(view, ran)}</span> : null}
      </li>;
    })}</ul>
    {(column || pin) && listed.length > RECENT ? <p className={styles.caption}>and {listed.length - RECENT} more{column ? ' in this column' : ''}.</p> : null}
  </>;
}

export function FleetRouterPane({ visible }: PaneProps) {
  const [audience, setAudience] = useState<Audience>('fleet');
  const [task, setTask] = useState<RoutingTask>('code');
  const [difficulty, setDifficulty] = useState<RoutingDifficulty>('medium');
  const routesQuery = routerRoutesQuery(audience === 'fleet');
  const table = useQuery(routesQuery, { enabled: visible, freshMs: 0 });
  const budget = useQuery(budgetQuery, { enabled: visible, freshMs: 15_000 });
  const decisions = useQuery(routerDecisionsQuery, { enabled: visible, freshMs: 0 });
  const refetchRoutes = useRefetch(routesQuery), refetchBudget = useRefetch(budgetQuery), refetchDecisions = useRefetch(routerDecisionsQuery);
  usePollWhileVisible(() => { refetchRoutes(); refetchBudget(); refetchDecisions(); }, 30_000, { enabled: visible });
  const now = Date.now();
  const view = budget.data && Array.isArray(budget.data.seatInfo) && Array.isArray(budget.data.headroom) ? budget.data : null;
  const stale = <p className={styles.note} data-stale role="status">Could not refresh. Showing the last reading.</p>;
  const routes = table.data?.routes ?? null, decision = routes ? routeAt(routes, task, difficulty) : null;
  return <section className={styles.root} aria-label="Router">
    <div className={styles.head}>
      <h2>Where each kind of work goes</h2>
      <Segmented size="sm" aria-label="Routed for" options={AUDIENCES} value={audience} onChange={setAudience} />
    </div>
    {/* The audience switch stays put while a table is read, so a slow or failed read never takes the way back with it. */}
    {routes ? <>
      {table.status === 'error' ? stale : null}
      <ul className={styles.shares} aria-label="First choice by seat">{tableShares(routes).map(share => <li key={String(share.seatId)} data-none={share.seatId === null || undefined}>
        {share.seatId === null ? null : <BrandMark brand={seatBrand(view, share.seatId)} size={14} />}{labelOf(view, share.seatId)}<b>{share.count}</b>
      </li>)}<li className={styles.of}>of {routes.length} kinds of work</li></ul>
      {routes.length < KINDS ? <p className={styles.note} data-stale role="status">{KINDS - routes.length} of {KINDS} kinds of work got no answer from the router.</p> : null}
      <RouteTable routes={routes} view={view} task={task} difficulty={difficulty} onPick={(nextTask, nextDifficulty) => { setTask(nextTask); setDifficulty(nextDifficulty); }} />
      <div className={styles.head}><h2>Next {difficulty} {task} task</h2></div>
      {decision ? <Route decision={decision} view={view} now={now} /> : <p className={styles.meta}>Unknown: the route table does not hold this kind of work.</p>}
      <div className={styles.head}><h2>Seats the router balances across</h2></div>
      <SeatPoolBoard routes={routes} view={view} task={task} difficulty={difficulty} now={now} onPick={(nextTask, nextDifficulty) => { setTask(nextTask); setDifficulty(nextDifficulty); }} />
    </> : <p className={styles.meta} role="status">{table.status === 'error' ? 'Route table: unknown (the router did not answer).' : 'Asking the router…'}</p>}
    <p className={styles.note}>Routed for {audience === 'fleet' ? 'autonomous fleet work' : 'your own request'}. Seat usage was read {view && typeof view.sampledAt === 'string' ? ago(view.sampledAt, now) : 'at an unknown time'}. Nothing is launched or reserved.</p>
    <div className={styles.head}><h2>Recorded decisions</h2></div>
    {decisions.data ? <>{decisions.status === 'error' ? stale : null}<Log records={decisions.data} view={view} now={now} /></>
      : <p className={styles.meta} role="status">{decisions.status === 'error' ? 'Decision log: unknown (it could not be read).' : 'Reading the decision log…'}</p>}
    <p className={styles.note}>A decision is the seat the router chose for a request, not proof the work ran there. Same reads: <code>GET /api/verse/budget/preview</code> and <code>GET /api/verse/budget/decisions</code>.</p>
  </section>;
}
