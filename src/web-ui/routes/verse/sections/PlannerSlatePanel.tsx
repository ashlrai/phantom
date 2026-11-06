import { useState } from 'react';
import { Button, Switch } from '../../../components/primitives/index.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { invalidate } from '../../../data/cache.js';
import { useMutationHold, useQuery, useRefresh } from '../../../data/hooks.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { Panel, SettingRow } from './SettingRow.js';
import { briefLine, failureText, presetRows, saveOutcomeText, slateSummary } from './planner-slate-model.js';
import { plannerSlateQuery, postPlannerSlate } from './planner-slate-queries.js';
import styles from './SettingsSection.module.css';

const toneColor = { ok: 'var(--status-success-fg)', warn: 'var(--status-warning-fg)', bad: 'var(--status-danger-fg)' };

export function PlannerSlatePanel() {
  const read = useQuery(plannerSlateQuery);
  const refresh = useRefresh(plannerSlateQuery);
  const { hasHold } = useMutationHold();
  const toast = useToast();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  if (read.data === null) return null;
  if (!read.data) return <Panel title="Planner logins"><p className={styles.panelNote}>{read.error ? 'Planner logins unavailable.' : 'Loading planner logins…'}</p></Panel>;
  const view = read.data;
  const rows = presetRows(view);
  const declared = rows.filter(row => row.checked).map(row => row.id);
  const selected = draft ?? declared;
  const changed = selected.length !== declared.length || selected.some(id => !declared.includes(id));
  const summary = slateSummary(view, Date.now());
  const brief = briefLine(view, Date.now());
  async function save() {
    setPending(true);
    try {
      const result = await postPlannerSlate(selected);
      toast.show(saveOutcomeText(result), result.status === 'refused' ? 'danger' : 'success');
      if (result.status !== 'refused') { setDraft(null); invalidate('verse-leader-planner-plan'); }
      refresh();
    } catch (error) { toast.show(failureText(error), 'danger'); }
    finally { setPending(false); }
  }
  return <Panel title="Planner logins">
    <p className={styles.panelNote} data-tone={summary.tone} style={{ color: toneColor[summary.tone] }} role="status">{summary.headline}</p>
    {rows.map(row => <SettingRow key={row.id} label={row.label} description={row.note}>
      <Switch aria-label={row.label} checked={selected.includes(row.id)} disabled={!row.enabled || pending}
        onChange={checked => setDraft(checked ? [...selected, row.id] : selected.filter(id => id !== row.id))} />
    </SettingRow>)}
    <p className={styles.panelNote} data-tone={brief.tone} style={{ color: toneColor[brief.tone] }}>{brief.text}</p>
    {hasHold ? <Button size="sm" disabled={!changed || selected.length === 0 || pending} onClick={() => void save()}>Save</Button>
      : <p className={styles.panelNote}>{new VerseControlLockedError().message}</p>}
  </Panel>;
}
