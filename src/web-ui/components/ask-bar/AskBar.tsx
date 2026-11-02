/**
 * components/ask-bar/AskBar.tsx — the one-ask bar (VISION-V4, flag `oneAsk`).
 *
 * Type a change, press Ask: a schema-valid `ask.v1` envelope in `queued`
 * state is posted to the loopback bus (`ashlr:ask`, ask-bus.ts) and a status
 * chip appears. Chips then track `ask.status.v1` events on the same bus
 * (`ashlr:ask-status`) — queued → claimed → running → … → merged — as the
 * intake/fan-out jobs report them. The bar never claims delivery: a chip is
 * the ask's last reported state, nothing more.
 *
 * The component is the flag gate: rendered anywhere, it paints nothing while
 * `oneAsk` is off, so a mount site can never forget the gate. The flag lives
 * in Settings ▸ Workspace ("One ask"), saved per browser.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useFeatureFlag } from '../../app/desktop-state.js';
import { Button } from '../primitives/Button.js';
import { Input } from '../primitives/Input.js';
import { StatusBadge } from '../primitives/StatusBadge.js';
import { Tag } from '../primitives/Tag.js';
import {
  ASK_TEXT_MAX_CHARS,
  buildAsk,
  subscribeAskStatus,
  postAskToBus,
  type AskBudget,
  type AskStatusV1,
  type AskV1,
} from './ask-bus.js';
import styles from './AskBar.module.css';

/** Work-tier defaults; intake re-checks every cap regardless of what is sent. */
const DEFAULT_BUDGET: AskBudget = { tokens_max: 400_000, usd_max: 5, wall_s_max: 3_600 };
/** Session list bound — the chips are a glance, not a ledger. */
const ASK_BAR_LIST_LIMIT = 20;

export interface AskBarProps {
  /** The one repository the console posts asks for; intake validates it again. */
  repo?: string;
  tier?: AskV1['tier'];
  budget?: AskBudget;
  placeholder?: string;
}

interface PostedAsk {
  ask: AskV1;
  /** The newest ask.status.v1 seen for this ask, or null while it is only queued. */
  status: AskStatusV1 | null;
}

/** `RQ-ASK-20261028-7K2Q` → `7K2Q` — enough to tell today's asks apart. */
function shortId(id: string): string {
  return id.slice(id.lastIndexOf('-') + 1);
}

function chipLabel(state: string, status: AskStatusV1 | null): string {
  const pretty = state.replace(/_/g, ' ');
  return status?.pr ? `${pretty} · #${status.pr}` : pretty;
}

function chipTitle(posted: PostedAsk): string {
  const parts = [posted.ask.id, posted.ask.text];
  const status = posted.status;
  if (status?.reason) parts.push(`reason: ${status.reason}`);
  if (status?.job_id) parts.push(`job: ${status.job_id}`);
  return parts.join('\n');
}

export function AskBar({
  repo = 'ashlrai/phantom',
  tier = 'work',
  budget = DEFAULT_BUDGET,
  placeholder = 'Describe one change…',
}: AskBarProps): ReactNode {
  const enabled = useFeatureFlag('oneAsk');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<PostedAsk[]>([]);
  const knownIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    return subscribeAskStatus((status) => {
      if (!knownIds.current.has(status.ask_id)) return;
      setPosted((list) => list.map((entry) => {
        if (entry.ask.id !== status.ask_id) return entry;
        if (entry.status && Date.parse(status.ts) < Date.parse(entry.status.ts)) return entry;
        return { ...entry, status };
      }));
    });
  }, [enabled]);

  if (!enabled) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = buildAsk(text, { repo, tier, budget });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!postAskToBus(result.ask)) {
      setError('The loopback bus is not available in this window.');
      return;
    }
    knownIds.current.add(result.ask.id);
    setPosted((list) => [{ ask: result.ask, status: null }, ...list].slice(0, ASK_BAR_LIST_LIMIT));
    setText('');
    setError(null);
  };

  return (
    <section className={styles.bar} aria-label="Ask bar">
      <form className={styles.form} onSubmit={submit}>
        <Input
          aria-label="Ask"
          size="sm"
          value={text}
          placeholder={placeholder}
          maxLength={ASK_TEXT_MAX_CHARS}
          error={error ?? undefined}
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <Button type="submit" variant="primary" size="sm">Ask</Button>
      </form>
      <div className={styles.chips} aria-live="polite">
        <Tag mono size="sm" title={`Asks from this console go to ${repo} on the ${tier} tier`}>{`${repo} · ${tier}`}</Tag>
        {posted.map((entry) => {
          const state = entry.status?.state ?? entry.ask.state;
          return (
            <StatusBadge key={entry.ask.id} status={state}>
              <span className={styles.chip} title={chipTitle(entry)}>{`${shortId(entry.ask.id)} · ${chipLabel(state, entry.status)}`}</span>
            </StatusBadge>
          );
        })}
      </div>
    </section>
  );
}
