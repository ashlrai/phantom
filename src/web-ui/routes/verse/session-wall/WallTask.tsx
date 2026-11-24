/**
 * What a session's job was asked to do, as one line: on its Conversations
 * card, on its row beside an open conversation and at the top of the
 * conversation's Summary. The line is the read's `task` key
 * (core/fleet/session-task.ts): quoted from the job's brief, past the fleet
 * view the dispatcher puts in front of it, never written by a model. A brief
 * that opens with a heading has a title, and it is set as one; a job from the
 * router queue shows the task its queue row held; any other brief gives only
 * its opening line, labelled as that. A read that says it
 * knows no line reads "Task unknown"; a server that sends no `task` draws
 * nothing. Text only, so it can sit inside a card's button.
 */
import type { ThreadTask } from '../fleet-sessions/session-thread-model.js';
import styles from './wall-task.module.css';

export const TASK_UNKNOWN = 'Task unknown: no line of its brief could be read.';

/** The line's name: a title or a queue row is the task; any other first line is only how the brief opens. */
export const taskName = (task: ThreadTask) => (task.from === 'opening' ? 'Brief opens' : 'Task');

const FROM_WORDS: Readonly<Record<ThreadTask['from'], string>> = {
  title: 'The title of its brief', queue: 'The task its router queue row held', opening: 'The first line of its brief, which has no title',
};

/** The whole reading in words, for a tooltip and for a screen reader's description. */
export function taskHint(task: ThreadTask): string {
  return `${FROM_WORDS[task.from]}${task.truncated ? ', cut to fit' : ''}. Quoted from the record, not summarised.`;
}

export interface TaskLineProps {
  /** Undefined: the server sent no `task`. Null: it did, and knows no line. */
  task: ThreadTask | null | undefined;
  /** `rail` is one line and says nothing when no line is known; `thread` is the conversation's own heading line. */
  place: 'card' | 'rail' | 'thread';
  id?: string;
}

export function TaskLine({ task, place, id }: TaskLineProps) {
  if (task === undefined || (task === null && place === 'rail')) return null;
  if (task === null) return <span id={id} className={styles.task} data-task="unknown" data-place={place}>{TASK_UNKNOWN}</span>;
  return <span id={id} className={styles.task} data-task={task.from} data-place={place} title={taskHint(task)}>
    <span className={styles.name}>{taskName(task)}</span>
    <span className={styles.words}>{task.line}</span>
  </span>;
}
