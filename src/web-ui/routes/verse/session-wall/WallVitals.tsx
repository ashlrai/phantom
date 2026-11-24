/**
 * A Conversations card's vitals (wall-vitals.ts): the newest recorded step
 * with its age on one line, then what became of its pull request (FateChip:
 * merged, closed or still open, as the job ledger records it), the diff, the
 * commands seen and the helpers as small figures. `CardVitalsLine` is drawn inside the card's button, so it
 * holds no control of its own; `CardPullRequest` is the pull request link,
 * drawn beside the button because a link cannot sit inside one.
 * `RailVitalsLine` is the one-line cut for a row beside an open conversation.
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

/** A mark and words; the words carry the meaning, the mark's fill and colour repeat it. */
function FateChip({ fate, short }: { fate: NonNullable<CardVitals['fate']>; short?: boolean }) {
  return <span data-vital="pr" data-fate={fate.state} title={fate.title}>
    <i className={styles.fateMark} aria-hidden="true" />{short ? fate.short : `PR ${fate.words}`}
  </span>;
}

export function CardVitalsLine({ vitals, id }: { vitals: CardVitals; id: string }) {
  const { step, diff, commands, helpers, fate } = vitals;
  return <span id={id} className={styles.vitals} data-vitals>
    {step && <span className={styles.step} data-vital="step" title={`Latest recorded step: ${[step.event, step.summary].filter(Boolean).join(' ')}, ${stepWhen(step)}`}>
      <span className={styles.event}>{step.event}</span>
      {step.summary && <span className={styles.stepText}>{step.summary}</span>}
      <span className={styles.when} data-unknown={step.ago === null ? '' : undefined}>{stepWhen(step)}</span>
    </span>}
    {(diff !== null || commands !== null || helpers !== null || fate !== null) && <span className={styles.figures}>
      {fate && <FateChip fate={fate} />}
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

/**
 * The same vitals cut to one line, for a row of the list beside an open conversation: the diff, then the newest step's
 * name and age at the right edge, and failed helpers when there are any. Null when the read measured none of them.
 */
export function RailVitalsLine({ vitals }: { vitals: CardVitals }) {
  const { step, diff, helpers, fate } = vitals, failed = helpers !== null && helpers.failed > 0 ? helpers.failed : 0;
  if (step === null && diff === null && failed === 0 && fate === null) return null;
  return <span className={styles.railVitals} data-vitals>
    {diff === 'unknown' && <span data-vital="diff" data-unknown="">changes unknown</span>}
    {diff !== null && diff !== 'unknown' && <span data-vital="diff" title={diffWords(diff)}>
      <DiffBar added={diff.added} removed={diff.removed} />
      <span className={styles.added}>+{diff.added}</span> <span className={styles.removed}>−{diff.removed}</span>
    </span>}
    {fate && <FateChip fate={fate} short />}
    {failed > 0 && <span data-vital="helpers" data-failed="">{failed} {failed === 1 ? 'helper' : 'helpers'} failed</span>}
    {step && <span className={styles.railStep} data-vital="step" title={`Latest recorded step: ${[step.event, step.summary].filter(Boolean).join(' ')}, ${stepWhen(step)}`}>
      <span className={styles.event}>{step.event}</span> <span data-unknown={step.ago === null ? '' : undefined}>{stepWhen(step)}</span>
    </span>}
  </span>;
}

export function CardPullRequest({ pr, session }: { pr: NonNullable<CardVitals['pr']>; session: string }) {
  return <a className={styles.pr} href={pr.url} target="_blank" rel="noopener noreferrer" data-card-pr={session} aria-label={`Pull request #${pr.number} for ${session}`}>
    PR #{pr.number}
  </a>;
}
