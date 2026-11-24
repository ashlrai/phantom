/**
 * routes/verse/fleet-router/SeatPool.tsx: the seats the router balances across, one row each.
 * A row holds the seat's mark and name, where it stands for every kind of work in the route
 * table (one cell per kind, grouped by task, each group reading low, medium, high), the usage
 * windows the budget reading holds for it with the reset of the one that binds fleet work, and
 * what that reading says about fleet work on the seat.
 *
 * The kind of work chosen in the route table is ringed down every row, and choosing a cell here
 * chooses that kind there. The board is one tab stop; the arrows walk its cells.
 */
import type { KeyboardEvent } from 'react';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { RoutingDifficulty, RoutingTask } from '../../../../core/routing/types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import { WindowBar } from '../../../components/primitives/WindowBar.js';
import { ROUTER_DIFFICULTIES, ROUTER_KINDS, ROUTER_TASKS, type BudgetRoute } from './router-model.js';
import { cellWords, fleetWords, poolWords, seatPool, standingWords, windowWords, type PoolSeat, type SeatStanding } from './seat-pool-model.js';
import styles from './seat-pool.module.css';

const PER_TASK = ROUTER_DIFFICULTIES.length;
const KEY: ReadonlyArray<{ standing: SeatStanding; words: string }> = [
  { standing: 'first', words: 'First choice' }, { standing: 'later', words: 'A later try, with its place' }, { standing: 'held', words: 'Held back' },
  { standing: 'unnamed', words: 'Not named' }, { standing: 'unknown', words: 'No answer' },
];

/** Left and Right walk a seat's kinds of work, Up and Down keep the kind and change seat, Home and End jump along the row. */
function moveFocus(event: KeyboardEvent<HTMLUListElement>, rows: number) {
  const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Home: [0, -ROUTER_KINDS], End: [0, ROUTER_KINDS] };
  const delta = step[event.key], from = (event.target as HTMLElement).closest<HTMLElement>('[data-pool-cell]');
  if (!delta || !from || event.altKey || event.ctrlKey || event.metaKey) return;
  const [row, col] = from.dataset['poolCell']!.split('-').map(Number) as [number, number];
  const clamp = (value: number, size: number) => Math.max(0, Math.min(size - 1, value));
  const next = event.currentTarget.querySelector<HTMLElement>(`[data-pool-cell="${clamp(row + delta[0], rows)}-${clamp(col + delta[1], ROUTER_KINDS)}"]`);
  if (next) { event.preventDefault(); next.focus(); }
}

function Windows({ seat, now }: { seat: PoolSeat; now: number }) {
  if (seat.free) return <div className={styles.reading}>Local: no usage window</div>;
  if (seat.windows.length === 0) return <div className={styles.reading}>
    <WindowBar className={styles.meter} label={`${seat.label} usage`} valueText="Usage unknown" valueNow={null} used={null} />Usage unknown
  </div>;
  return <>{seat.windows.map(window => {
    const words = windowWords(window);
    // Only the binding window's reset is reported, so only that one is said.
    const reset = window.binding ? `binds fleet work · ${window.resetAt ? `resets ${describeResetAt(window.resetAt, now) ?? window.resetAt}` : 'reset unknown'}` : null;
    return <div key={window.name} className={styles.reading} data-window={window.name} data-binding={window.binding || undefined}>
      <WindowBar className={styles.meter} label={`${seat.label} ${window.name} window used`} valueText={reset ? `${words}, ${reset}` : words} valueNow={window.usedPercent} used={window.usedPercent} />
      <span>{words}{reset ? <> · <b>{reset}</b></> : null}</span>
    </div>;
  })}</>;
}

export function SeatPoolBoard({ routes, view, task, difficulty, now, onPick }: { routes: readonly BudgetRoute[]; view: BudgetView | null; task: RoutingTask; difficulty: RoutingDifficulty;
  now: number; onPick: (task: RoutingTask, difficulty: RoutingDifficulty) => void }) {
  const pool = seatPool(routes, view);
  if (pool.seats.length === 0) return <p className={styles.words}>{poolWords(pool)}</p>;
  return <>
    <p className={styles.words}>{poolWords(pool)}</p>
    <ul className={styles.pool} aria-label="Seats" onKeyDown={event => moveFocus(event, pool.seats.length)}>
      <li className={styles.tasks} aria-hidden="true"><span />{ROUTER_TASKS.map(row => <span key={row.value} data-chosen={row.value === task || undefined}>{row.label}</span>)}</li>
      {pool.seats.map((seat, r) => <li key={seat.seatId} className={styles.seat} data-seat={seat.seatId} data-idle={(seat.first === 0 && seat.later === 0) || undefined}>
        <div className={styles.who}>
          <span className={styles.name}><BrandMark brand={seat.brand} size={16} />{seat.label}</span>
          <span className={styles.standing}>{standingWords(seat, pool.answered)}</span>
        </div>
        {ROUTER_TASKS.map((row, t) => <span key={row.value} className={styles.group}>{seat.cells.slice(t * PER_TASK, (t + 1) * PER_TASK).map((cell, d) => {
          const chosen = cell.task === task && cell.difficulty === difficulty, words = cellWords(seat, cell);
          return <button key={cell.difficulty} type="button" className={styles.cell} data-pool-cell={`${r}-${t * PER_TASK + d}`} data-standing={cell.standing} data-chosen={chosen || undefined}
            aria-pressed={chosen} aria-label={words} title={words} tabIndex={chosen && r === 0 ? 0 : -1} onClick={() => onPick(cell.task, cell.difficulty)}>
            {cell.standing === 'later' ? cell.rank : cell.standing === 'held' ? '–' : null}
          </button>;
        })}</span>)}
        <div className={styles.readings}>
          <Windows seat={seat} now={now} />
          <p className={styles.fleet} data-fleet={seat.fleet === null ? 'unknown' : seat.fleet.open ? 'open' : 'closed'}>{fleetWords(seat)}</p>
        </div>
      </li>)}
    </ul>
    <p className={styles.key} data-pool-key>
      {KEY.map(item => <span key={item.standing}><i className={styles.cell} data-standing={item.standing} aria-hidden="true">{item.standing === 'later' ? 2 : item.standing === 'held' ? '–' : null}</i>{item.words}</span>)}
      <span>Each group reads low, medium, high.</span>
    </p>
  </>;
}
