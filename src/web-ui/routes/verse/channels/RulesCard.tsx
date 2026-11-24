/**
 * routes/verse/channels/RulesCard.tsx — which channel each kind of update
 * goes to. Rows, labels and choices come from GET /api/notify/rules
 * (phantom.notify.rules.v1), the view `phm notify rules --json` prints;
 * picking a channel posts {type, channel} to the same path.
 */
import { useState } from 'react';
import {
  NOTIFY_RULES_PATH, NOTIFY_RULES_SCHEMA,
  type NotifyChannel, type NotifyRuleType, type NotifyRulesView,
} from '../../../../core/comms/notify-rules-schema.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { useMutationHold, useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import styles from './channels.module.css';

const checked = (data: NotifyRulesView): NotifyRulesView => {
  if (data?.schema !== NOTIFY_RULES_SCHEMA || !Array.isArray(data.rules)) throw new Error(`Expected ${NOTIFY_RULES_SCHEMA}`);
  return data;
};

export const notifyRulesQuery: QueryDef<NotifyRulesView> = {
  key: 'notify-rules',
  fetch: async (signal) => checked(await apiGet<NotifyRulesView>(NOTIFY_RULES_PATH, signal)),
};

export function RulesCard({ visible }: { visible: boolean }) {
  const read = useQuery(notifyRulesQuery, { enabled: visible, freshMs: 0 });
  const { token, touch } = useMutationHold();
  const [saved, setSaved] = useState<NotifyRulesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const view = saved ?? read.data;

  async function change(type: NotifyRuleType, channel: NotifyChannel) {
    if (!token) { setNote('Unlock to change a rule.'); return; }
    setBusy(true);
    try {
      setSaved(checked(await apiPost<NotifyRulesView>(NOTIFY_RULES_PATH, { type, channel }, token)));
      touch();
      setNote('Saved.');
    } catch (error) {
      setNote(error instanceof ApiError && (error.status === 401 || error.status === 403) ? 'Unlock to change a rule.' : 'Could not save. The rule is unchanged.');
    } finally { setBusy(false); }
  }

  return <section className={styles.card} aria-label="Rules">
    <strong className={styles.name}>Rules</strong>
    {!view ? <p className={styles.message} role="status">{read.status === 'error' ? 'Rules are unavailable.' : 'Reading rules…'}</p> : <>
      <p className={styles.message}>Where each kind of update goes. Everything is also shown in the desktop app.</p>
      {view.rules.map((row) => <label key={row.type} className={styles.rule}>
        <span className={styles.ruleName}>{row.label}<small className={styles.message}>{row.note}</small></span>
        <select className={styles.select} value={row.channel} disabled={busy} aria-label={`Channel for ${row.label}`}
          onChange={(event) => { void change(row.type, event.target.value as NotifyChannel); }}>
          {view.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.label}</option>)}
        </select>
      </label>)}
      {view.problem ? <p className={styles.message} role="alert">{view.problem}</p> : null}
      {note ? <p className={styles.message} role="status">{note}</p> : null}
      <p className={styles.message}>Same data: <code>phm notify rules --json</code>.</p>
    </>}
  </section>;
}
