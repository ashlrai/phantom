/**
 * One card at the top: "Asks (N)", soonest expiry first (unknown last; expired hidden). One row per ask, a big button per allowed
 * answer, one number field for a usage ask (a short text box for any other
 * short-value ask), "Recorded" in place after a tap. No asks: "Nothing needs
 * you." Unreadable ledger: says unknown. Without the unlock the buttons are
 * disabled with the reason. An answer is a record only: nothing is spent or sent.
 * Data is asks.batch.v1; answers go to the same route as `phm asks answer`.
 */
import { useState, useSyncExternalStore } from 'react';
import { formatAge, SHORT_VALUE_MAX } from '../../../../core/fleet/ask-display.js';
import type { BatchAsk } from '../../../../core/fleet/asks-batch.js';
import { hasMutationHold, subscribeAuth } from '../../../data/auth-store.js';
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

function expiryText(expires: string | null): string {
  const ms = expires === null ? NaN : Date.parse(expires);
  if (!Number.isFinite(ms)) return 'expiry unknown';
  return `expires in ${formatAge(Math.max(0, Math.floor((ms - Date.now()) / 1000)))}`;
}

const LOCKED_REASON = 'Unlock actions to answer. Only you, verified, can record an answer.';

/** A usage answer is a whole number from 0 to 100; anything else stays unsent. */
const validNumber = (text: string): boolean => /^\d{1,3}$/.test(text) && Number(text) <= 100;

function AskRow({ ask, result, verified, onAnswer }: { ask: BatchAsk; result: Result | undefined; verified: boolean; onAnswer: (ask: BatchAsk, answer: string) => void }) {
  const [text, setText] = useState('');
  const busy = result?.state === 'saving' || !verified;
  const numeric = ask.numeric === true;
  return (
    <li className={styles.ask}>
      <p className={styles.question}>{ask.number}. {ask.question}</p>
      <p className={styles.meta}>{expiryText(ask.expires)} · {ageText(ask.askedAt)} · {ask.whatHappens}</p>
      {result?.state === 'done' ? (
        <p className={styles.result} role="status">{result.text}</p>
      ) : (
        <>
          {ask.kind === 'short-value' ? (
            <div className={styles.choices}>
              <input className={styles.input} type={numeric ? 'number' : 'text'} {...(numeric ? { min: 0, max: 100, inputMode: 'numeric' as const } : { maxLength: SHORT_VALUE_MAX })}
                value={text} aria-label={numeric ? `Percent (0 to 100): ${ask.question}` : `Answer to: ${ask.question}`}
                onChange={(event) => setText(event.target.value)} disabled={busy} />
              <Button variant="primary" disabled={busy || text.trim() === '' || (numeric && !validNumber(text.trim()))} onClick={() => onAnswer(ask, text.trim())}>Send</Button>
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
          {verified ? null : <p className={styles.meta} role="note">{LOCKED_REASON}</p>}
          {result?.state === 'error' ? <p className={styles.error} role="alert">{result.text}</p> : null}
        </>
      )}
    </li>
  );
}

export function AsksCard() {
  const query = useQuery(asksBatchQuery);
  const verified = useSyncExternalStore(subscribeAuth, hasMutationHold, hasMutationHold);
  const [results, setResults] = useState<Record<string, Result>>({});
  const batch = query.data;
  if (!batch) {
    return query.status === 'error' ? (
      <Section title="Asks"><Row title="Asks unknown right now" subtitle={readFailureReason(query.error)} /></Section>
    ) : null;
  }
  if (batch.ledger === 'unavailable') return <Section title="Asks"><Row title="Asks unknown: the list could not be read" /></Section>;
  if (batch.count === 0) return <Section title="Asks"><Row title="Nothing needs you." /></Section>;

  const answer = (ask: BatchAsk, value: string): void => {
    setResults((prev) => ({ ...prev, [ask.id]: { state: 'saving' } }));
    answerAskOnPhone(ask.id, value).then(
      () => setResults((prev) => ({ ...prev, [ask.id]: { state: 'done', text: `Recorded: ${value}.` } })),
      (error: unknown) => setResults((prev) => ({ ...prev, [ask.id]: { state: 'error', text: readFailureReason(error) } })),
    );
  };
  return (
    <Section title={`Asks (${batch.count})`}>
      <ul className={styles.list} aria-label="Asks">
        {batch.asks.map((ask) => <AskRow key={ask.id} ask={ask} result={results[ask.id]} verified={verified} onAnswer={answer} />)}
      </ul>
    </Section>
  );
}
