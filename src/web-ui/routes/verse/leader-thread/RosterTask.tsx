/**
 * The task on a "Working now" line: what the session's job was asked to do,
 * between when it last spoke and the last thing it said. One line, cut with
 * an ellipsis; the whole line and where it was quoted from are in the
 * tooltip. A title or a queue row reads as the task; a brief with neither
 * gives only its opening line, set quieter and named "Brief opens" in the
 * tooltip. No line known, or a read that does not say, draws nothing
 * (roster-task.ts). Text only, so it can sit inside the line's button.
 */
import type { ThreadTask } from '../fleet-sessions/session-thread-model.js';
import { taskHint } from '../session-wall/WallTask.js';
import { rosterTaskWords } from './roster-task.js';
import styles from './roster-task.module.css';

export function RosterTask({ task }: { task: ThreadTask | null | undefined }) {
  if (!task) return null;
  return <span className={styles.task} data-roster-task={task.from} title={`${rosterTaskWords(task)}\n${taskHint(task)}`}>{task.line}</span>;
}
