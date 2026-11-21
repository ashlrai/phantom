/**
 * A Conversations card's vitals (wall-vitals.ts): the newest recorded step
 * with its age on one line, then the diff, the commands seen and the helpers
 * as small figures. `CardVitalsLine` is drawn inside the card's button, so it
 * holds no control of its own; `CardPullRequest` is the pull request link,
 * drawn beside the button because a link cannot sit inside one.
 */
import { commandsWords, diffWords, helpersWords, stepWhen, type CardVitals } from './wall-vitals.js';
import styles from './wall-vitals.module.css';

/** The diff as two stretches, added then removed, in proportion. Nothing is drawn for an empty diff. */
function DiffBar({ added, removed }: { added: number; removed: number }) {
  if (added + removed === 0) return null;
  return <i className={styles.bar} aria-hidden="true">
    {added > 0 && <i data-part="added" style={{ flexGrow: added }} />}
    {removed > 0 && <i data-part="removed" style={{ flexGrow: removed }} />}
  </i>;
}

export function CardVitalsLine({ vitals, id }: { vitals: CardVitals; id: string }) {
  const { step, diff, commands, helpers } = vitals;
  return <span id={id} className={styles.vitals} data-vitals>
    {step && <span className={styles.step} data-vital="step" title={`Latest recorded step: ${[step.event, step.summary].filter(Boolean).join(' ')}, ${stepWhen(step)}`}>
      <span className={styles.event}>{step.event}</span>
      {step.summary && <span className={styles.stepText}>{step.summary}</span>}
      <span className={styles.when} data-unknown={step.ago === null ? '' : undefined}>{stepWhen(step)}</span>
    </span>}
    {(diff !== null || commands !== null || helpers !== null) && <span className={styles.figures}>
      {diff === 'unknown' && <span data-vital="diff" data-unknown="">changed files unknown</span>}
      {diff !== null && diff !== 'unknown' && <span data-vital="diff" data-partial={diff.partial ? '' : undefined} title={diffWords(diff)}>
        <DiffBar added={diff.added} removed={diff.removed} />
        <span className={styles.added}>+{diff.added}</span> <span className={styles.removed}>−{diff.removed}</span>
        {' '}in {diff.files} {diff.files === 1 ? 'file' : 'files'}{diff.partial && ', partial'}
      </span>}
      {commands !== null && <span data-vital="commands" data-unknown={commands === 'unknown' ? '' : undefined}>{commandsWords(commands)}</span>}
      {helpers !== null && <span data-vital="helpers" data-failed={helpers.failed > 0 ? '' : undefined}>{helpersWords(helpers)}</span>}
    </span>}
  </span>;
}

export function CardPullRequest({ pr, session }: { pr: NonNullable<CardVitals['pr']>; session: string }) {
  return <a className={styles.pr} href={pr.url} target="_blank" rel="noopener noreferrer" data-card-pr={session} aria-label={`Pull request #${pr.number} for ${session}`}>
    PR #{pr.number}
  </a>;
}
