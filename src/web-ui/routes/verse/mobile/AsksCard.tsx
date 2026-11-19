/**
 * One card at the top: "Needs you (N)". One row per ask, a big button per
 * allowed answer, a short text box only for a short-value ask, the result in
 * place after a tap. No asks: no card. Unreadable ledger: says unknown.
 * Data is asks.batch.v1; answers go to the same route as `phm asks answer`.
 */
import { useState } from 'react';
import { SHORT_VALUE_MAX, type BatchAsk } from '../../../../core/fleet/asks-batch.js';
import { formatAge } from '../../../../core/fleet/asks.js';
import { readFailureReason } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import { answerAskOnPhone, asksBatchQuery } from './asks-card-queries.js';
import styles from './AsksCard.module.css';
import { Row, Section } from './ui-parts.js';
import { Button } from './ui.js';

const LABEL: Record<string, string> = { yes: 'Yes', no: 'No', done: 'Done', later: 'Later' };
type Result = { state: 'saving' } | { state: 'done'; text: string } | { state: 'error'; text: string };

function ageText(askedAt: string | null): string {
  const ms = askedAt === null ? NaN : Date.parse(askedAt);
  return Number.isFinite(ms) ? `asked ${formatAge(Math.max(0, Math.floor((Date.now() - ms) / 1000)))} ago` : 'asked (time unknown)';
}

function AskRow({ ask, result, onAnswer }: { ask: BatchAsk; result: Result | undefined; onAnswer: (ask: BatchAsk, answer: string) => void }) {
  const [text, setText] = useState('');
  const busy = result?.state === 'saving';
  return (
    <li className={styles.ask}>
      <p className={styles.question}>{ask.number}. {ask.question}</p>
      <p className={styles.meta}>{ageText(ask.askedAt)} · {ask.whatHappens}</p>
      {result?.state === 'done' ? (
        <p className={styles.result} role="status">{result.text}</p>
      ) : (
        <>
          {ask.kind === 'short-value' ? (
            <div className={styles.choices}>
              <input className={styles.input} type="text" value={text} maxLength={SHORT_VALUE_MAX} aria-label={`Answer to: ${ask.question}`}
                onChange={(event) => setText(event.target.value)} disabled={busy} />
              <Button variant="primary" disabled={busy || text.trim() === ''} onClick={() => onAnswer(ask, text.trim())}>Send</Button>
            </div>
          ) : (
            <div className={styles.choices}>
              {ask.choices.map((choice, index) => (
                <Button key={choice} variant={index === 0 ? 'primary' : 'secondary'} className={styles.choice} disabled={busy}
                  onClick={() => onAnswer(ask, choice)} aria-label={`${LABEL[choice] ?? choice}: ${ask.question}`}>
                  {LABEL[choice] ?? choice}
                </Button>
              ))}
            </div>
          )}
          {result?.state === 'error' ? <p className={styles.error} role="alert">{result.text}</p> : null}
        </>
      )}
    </li>
  );
}

export function AsksCard() {
  const query = useQuery(asksBatchQuery);
  const [results, setResults] = useState<Record<string, Result>>({});
  const batch = query.data;
  if (!batch) {
    return query.status === 'error' ? (
      <Section title="Needs you"><Row title="Asks unknown right now" subtitle={readFailureReason(query.error)} /></Section>
    ) : null;
  }
  if (batch.ledger === 'unavailable') return <Section title="Needs you"><Row title="Asks unknown: the list could not be read" /></Section>;
  if (batch.count === 0) return null;

  const answer = (ask: BatchAsk, value: string): void => {
    setResults((prev) => ({ ...prev, [ask.id]: { state: 'saving' } }));
    answerAskOnPhone(ask.id, value).then(
      () => setResults((prev) => ({ ...prev, [ask.id]: { state: 'done', text: `Got it: ${value}.` } })),
      (error: unknown) => setResults((prev) => ({ ...prev, [ask.id]: { state: 'error', text: readFailureReason(error) } })),
    );
  };
  return (
    <Section title={`Needs you (${batch.count})`}>
      <ul className={styles.list} aria-label="Needs you">
        {batch.asks.map((ask) => <AskRow key={ask.id} ask={ask} result={results[ask.id]} onAnswer={answer} />)}
      </ul>
    </Section>
  );
}
