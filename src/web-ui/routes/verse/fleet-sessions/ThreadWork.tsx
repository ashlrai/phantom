/**
 * The body of an opened conversation's Summary: what the session's job was
 * asked to do, one line quoted from its brief (session-wall/WallTask.tsx,
 * the read's `task`), then what the job has
 * done as readings (the newest recorded step and how long ago, the diff, the
 * commands seen in its log, its helpers), then the summary sentences that say
 * something else. The pull request is the link in the conversation's header,
 * so its sentence steps aside with the others. The readings are the Conversations
 * card's (session-wall/wall-vitals.ts), read from the same keys of this
 * conversation's own read (`work`, `session.helpers`, `session.prUrl`), so a
 * card and the conversation it opens never disagree. A sentence is left out
 * only when its value is drawn as a reading or that link. A session with no job, or a
 * server that sends no `work`, keeps every sentence and gets no readings.
 */
import { TaskLine } from '../session-wall/WallTask.js';
import { cardVitals, commandsWords, diffWords, hasVitals, helpersWords, stepWhen, summaryLeft } from '../session-wall/wall-vitals.js';
import type { SessionThread } from './session-thread-model.js';
import threadStyles from './session-thread.module.css';
import styles from './thread-work.module.css';

const count = (value: number, word: string) => `${value.toLocaleString('en-US')} ${word}${value === 1 ? '' : 's'}`;

export function ThreadWork({ thread }: { thread: SessionThread }) {
  const { session } = thread;
  const vitals = cardVitals({ work: thread.work ?? null, session: { helpers: session.helpers ?? null, prUrl: session.prUrl } }, thread.generatedAt);
  const { step, diff, commands, helpers } = vitals;
  const drawn = hasVitals(vitals);
  const left = drawn ? summaryLeft(thread.summary, vitals) : thread.summary;
  return <>
    <TaskLine task={thread.task} place="thread" />
    {drawn && <dl className={styles.work} aria-label={`What ${session.id}'s job has done`} data-thread-work>
      {step && <div className={styles.reading} data-reading="step">
        <dt>Latest step</dt>
        <dd>
          <span className={styles.event}>{step.event}</span>
          {step.summary && <span className={styles.stepText}>{step.summary}</span>}
          <span className={styles.when} data-unknown={step.ago === null ? '' : undefined}>{stepWhen(step)}</span>
        </dd>
      </div>}
      {diff !== null && <div className={styles.reading} data-reading="diff">
        <dt>Changed</dt>
        {diff === 'unknown' ? <dd data-unknown="">unknown</dd> : <dd title={diffWords(diff)}>
          {diff.added + diff.removed > 0 && <i className={styles.bar} aria-hidden="true">
            {diff.added > 0 && <i data-part="added" style={{ flexGrow: diff.added }} />}
            {diff.removed > 0 && <i data-part="removed" style={{ flexGrow: diff.removed }} />}
          </i>}
          <span className={styles.added}>+{diff.added.toLocaleString('en-US')}</span>
          <span className={styles.removed}>−{diff.removed.toLocaleString('en-US')}</span>
          <span className={styles.quiet}>in {count(diff.files, 'file')}{diff.partial && ', partial'}</span>
        </dd>}
      </div>}
      {commands !== null && <div className={styles.reading} data-reading="commands">
        <dt>Commands</dt>
        <dd data-unknown={commands === 'unknown' ? '' : undefined} title={commands === 'unknown' ? 'The commands in its log could not be read' : `${commandsWords(commands)} seen in its log`}>
          {commands === 'unknown' ? 'unknown' : commands.toLocaleString('en-US')}
        </dd>
      </div>}
      {helpers !== null && <div className={styles.reading} data-reading="helpers">
        <dt>Helpers</dt>
        <dd data-failed={helpers.failed > 0 ? '' : undefined} title={helpersWords(helpers)}>
          {helpers.running} of {helpers.below} running{helpers.failed > 0 && `, ${helpers.failed} failed`}
        </dd>
      </div>}
      {vitals.fate !== null && <div className={styles.reading} data-reading="pr">
        <dt>Pull request</dt>
        <dd data-fate={vitals.fate.state} title={vitals.fate.title}>{vitals.fate.words[0]!.toUpperCase()}{vitals.fate.words.slice(1)}</dd>
      </div>}
    </dl>}
    {thread.summary.length === 0 && !drawn ? <p className={threadStyles.plain}>Summary unknown: the read returned none.</p>
      : left.map(line => <p key={line} className={threadStyles.plain}>{line}</p>)}
  </>;
}
