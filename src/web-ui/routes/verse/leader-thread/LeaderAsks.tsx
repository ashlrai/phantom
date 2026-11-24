/**
 * "The Leader is asking": the questions the Leader is waiting on Mason for,
 * pinned between the conversation and the reply box so an answer is one
 * keypress away instead of a scroll back through the thread.
 *
 * It reads the Leader thread the pane already polls (same cache key, no extra
 * request) and answers through the Leader's own question routes: the typed
 * form for a question with choices, a written answer otherwise. With nothing
 * open it renders nothing, so a quiet thread keeps its full height.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { MessageMarkdown } from '../MessageMarkdown.js';
import { useNow } from '../autonomy/use-ticker.js';
import { useTokenGate } from '../context/use-token-gate.js';
import { LeaderComposer } from '../leader/LeaderComposer.js';
import type { QuestionFormStore } from '../leader/LeaderQuestionForm.js';
import { answerLeaderQuestion, leaderThreadQuery } from '../leader/thread-data.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';
import leaderStyles from '../leader/leader.module.css';
import { askedAgo, choiceForKey, currentAsk, openLeaderAsks, stepAsk, type LeaderAsk } from './leader-asks-model.js';
import styles from './leader-asks.module.css';

const TypedQuestionForm = lazy(() => import('../leader/LeaderQuestionForm.js'));

const NO_MESSAGES: LeaderThreadMessage[] = [];
const TOKEN_REASON = 'Answering the Leader requires the dispatch token.';
const READ_ONLY_REASON = 'Read-only session — this server runs without dispatch, so answers cannot be sent.';
/** How long "Answer sent" stays after the question it closed has left the tray. */
const RECEIPT_MS = 6_000;

function typingTarget(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
  return target instanceof HTMLInputElement && target.type !== 'radio' && target.type !== 'checkbox';
}

export function LeaderAsks({ visible, readOnly }: { visible: boolean; readOnly: boolean }) {
  const thread = useQuery(leaderThreadQuery, { enabled: visible, freshMs: 5_000 });
  const refetchThread = useRefetch(leaderThreadQuery);
  const gate = useTokenGate();
  const now = useNow(30_000);
  /** Drafts live here, so stepping between questions never loses one. */
  const forms = useRef<QuestionFormStore>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [written, setWritten] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState(false);

  const asks = useMemo(() => openLeaderAsks(thread.data?.value?.messages ?? NO_MESSAGES), [thread.data]);
  const ask = currentAsk(asks, picked);

  useEffect(() => {
    if (!receipt) return;
    const id = window.setTimeout(() => setReceipt(false), RECEIPT_MS);
    return () => window.clearTimeout(id);
  }, [receipt]);

  function answered() {
    setReceipt(true);
    setFailure(null);
    refetchThread();
  }

  /** A question with no form: Mason's words go to the same answer route as plain text. */
  function sendWritten(target: LeaderAsk, text: string) {
    if (sending !== null) return;
    void gate.run(TOKEN_REASON, async () => {
      setSending(target.key);
      setFailure(null);
      try {
        await answerLeaderQuestion(target.questionId, text);
        setWritten(drafts => ({ ...drafts, [target.key]: '' }));
        answered();
      } catch (error) {
        setFailure(`${readFailureReason(error)} Your answer is kept.`);
      } finally {
        setSending(null);
      }
    });
  }

  /** 1-9 picks a choice, Cmd/Ctrl+Enter submits; neither fires while Mason is typing an answer. */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const body = bodyRef.current;
    if (!body || event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      const submit = [...body.querySelectorAll<HTMLButtonElement>('fieldset button[type="button"]')].find(button => button.textContent === 'Submit answer');
      if (!submit || submit.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      submit.click();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target)) return;
    const choices = [...body.querySelectorAll<HTMLInputElement>('fieldset:not(:disabled) input[type="radio"], fieldset:not(:disabled) input[type="checkbox"]')];
    const index = choiceForKey(event.key, choices.length);
    if (index === null) return;
    event.preventDefault();
    choices[index]!.click();
    choices[index]!.focus();
  }

  const dialog = <MutationTokenDialog {...gate.dialog} tokenHelp="the mutation token ashlr verse printed" />;
  if (!ask) {
    return <>
      {receipt ? <p className={`${styles.receipt} ${styles.alone}`} role="status">Answer sent. Nothing else is waiting on you.</p> : null}
      {dialog}
    </>;
  }

  const position = asks.findIndex(item => item.key === ask.key) + 1;
  const disabledReason = readOnly ? READ_ONLY_REASON : null;
  return <section className={styles.asks} aria-label="The Leader is asking" data-open={open || undefined}>
    <header className={styles.head}>
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.title}>The Leader is asking</span>
        <span className={styles.meta}>{asks.length > 1 ? `${position} of ${asks.length} · ` : ''}{askedAgo(ask.atMs, now)}</span>
      </button>
      {asks.length > 1 ? <span className={styles.steps}>
        <button type="button" className={styles.step} aria-label="Previous question" onClick={() => { setPicked(stepAsk(asks, ask, -1).key); setOpen(true); }}>‹</button>
        <button type="button" className={styles.step} aria-label="Next question" onClick={() => { setPicked(stepAsk(asks, ask, 1).key); setOpen(true); }}>›</button>
      </span> : null}
    </header>
    {open ? <div ref={bodyRef} key={ask.key} className={styles.body} onKeyDown={onKeyDown}>
      <div className={leaderStyles.prose}><MessageMarkdown text={ask.text} /></div>
      {ask.typed ? <>
        <Suspense fallback={<p className={styles.hint} role="status">Reading the current question…</p>}>
          <TypedQuestionForm key={ask.questionId} questionId={ask.questionId} revisionHint={ask.revision ?? undefined} store={forms.current}
            disabledReason={disabledReason} fallbackText={ask.text}
            requestSubmit={run => { void gate.run(TOKEN_REASON, run); }}
            onLegacyAnswer={async text => { await answerLeaderQuestion(ask.questionId, text); answered(); return true; }}
            onResult={answered} onReconciled={refetchThread}
            renderWrittenAnswer={props => <LeaderComposer {...props} />} />
        </Suspense>
        <p className={styles.hint}><kbd>1</kbd>–<kbd>9</kbd> choose · <kbd>⌘</kbd><kbd>↵</kbd> submit</p>
      </> : sending === ask.key
        ? <p className={styles.hint} role="status">Sending your answer…</p>
        : <LeaderComposer variant="answer" label="Answer the Leader" placeholder="Answer the Leader…" maxLines={6}
          value={written[ask.key] ?? ''} onChange={text => setWritten(drafts => ({ ...drafts, [ask.key]: text }))}
          onSend={text => sendWritten(ask, text)} disabledReason={disabledReason} />}
      {failure ? <p className={styles.failure} role="alert">{failure}</p> : null}
      {receipt ? <p className={styles.receipt} role="status">Answer sent.</p> : null}
    </div> : null}
    {dialog}
  </section>;
}
