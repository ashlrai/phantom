/**
 * routes/verse/ops/OpsBoard.tsx : the board view: every task the buses know
 * about, in handoff-schema columns, with its assignee, estimate and outcome.
 *
 * Sources are the fleet queue, the team event log's handoffs and the
 * companion ledger : folded server-side into OpsBoardV1. This view renders
 * the projection; a degraded source says so rather than showing a partial
 * board as if it were whole.
 */
import { useRefetch, useQuery } from '../../../data/hooks.js';
import { Button } from '../../../components/primitives/Button.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { opsBoardQuery } from './ops-queries.js';
import type { OpsBoardColumn, OpsTaskRow } from '../../../../core/verse/ops-types.js';
import styles from './ops.module.css';

const COLUMN_TITLE: Record<OpsBoardColumn, string> = {
  next: 'Next up',
  active: 'In flight',
  held: 'Held',
  done: 'Done',
  closed: 'Closed',
};
const COLUMN_ORDER: readonly OpsBoardColumn[] = ['next', 'active', 'held', 'done', 'closed'];
const SOURCE_LABEL: Record<OpsTaskRow['source'], string> = { fleet: 'Fleet', handoff: 'Handoff', companion: 'Companion' };

function TaskCard({ task }: { task: OpsTaskRow }) {
  return (
    <article className={styles.card} data-needs-you={task.needsYou || undefined}>
      <p className={styles.cardTitle}>{task.title}</p>
      <p className={styles.cardMeta}>
        <span>{SOURCE_LABEL[task.source]}</span>
        {task.repo ? <span>{task.repo}</span> : null}
      </p>
      <p className={styles.cardMeta}>
        <span>Assignee: {task.assignee ?? 'unassigned'}</span>
      </p>
      {task.estimate ? <p className={styles.cardMeta}><span>Estimate: {task.estimate}</span></p> : null}
      {task.outcome ? <p className={styles.cardOutcome} data-state={task.outcome.state}>{task.outcome.state}{task.outcome.text ? `: ${task.outcome.text}` : ''}</p> : null}
    </article>
  );
}

export function OpsBoard() {
  const read = useQuery(opsBoardQuery, { freshMs: 8_000 });
  const refetch = useRefetch(opsBoardQuery);
  usePollWhileVisible(refetch, 15_000);
  const board = read.data;

  return (
    <section className={styles.panel} aria-labelledby="ops-board-title">
      <div className={styles.header}>
        <div>
          <h2 id="ops-board-title">Board</h2>
          <p>Every task on the buses: fleet queue, team handoffs and companion work, in one place.</p>
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={refetch}>Refresh</Button>
        </div>
      </div>
      {read.status === 'error' ? <p role="status">The board is unavailable. Refresh to reconnect.</p>
        : !board ? <p role="status">Reading the board…</p>
        : <>
            {board.sources.fleet === 'degraded' || board.sources.handoff === 'degraded' || board.sources.companion === 'degraded'
              ? <p role="status" className={styles.note}>
                  {(['fleet', 'handoff', 'companion'] as const).filter((s) => board.sources[s] === 'degraded').map((s) => SOURCE_LABEL[s]).join(', ')}
                  {' '}could not be read, so the board is incomplete.
                </p>
              : null}
            <div className={styles.boardGrid}>
              {COLUMN_ORDER.map((column) => (
                <div key={column} className={styles.boardColumn} aria-label={COLUMN_TITLE[column]}>
                  <h3 className={styles.columnTitle}>{COLUMN_TITLE[column]} <span className={styles.count}>{board.counts[column]}</span></h3>
                  {board.columns[column].length === 0
                    ? <p className={styles.empty}>Nothing here.</p>
                    : board.columns[column].map((task) => <TaskCard key={task.id} task={task} />)}
                </div>
              ))}
            </div>
          </>}
    </section>
  );
}
