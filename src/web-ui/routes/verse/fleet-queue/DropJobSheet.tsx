import { useEffect, useRef, useState } from 'react';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { Button } from '../../../components/primitives/index.js';
import { refetchQuery } from '../../../data/cache.js';
import { readFailureReason } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { draftBytes, lanes, outcomeText, suggestId, tiers, validateDraft, type DropJobDraft } from './drop-job-model.js';
import { dropJobsQuery, postDropJob } from './drop-job-queries.js';
const storageKey = 'phantom.drop-job-draft.v1';
function restore(): DropJobDraft {
  const empty = { id: '', lane: 'codex-personal', tier: 'mid', body: '' };
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (raw && typeof raw === 'object' && Object.keys(empty).every(key => key in raw && typeof (raw as Record<string, unknown>)[key] === 'string')) return raw as DropJobDraft;
  } catch { /* Storage may be unavailable. */ }
  return empty;
}
export function DropJobSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState(restore);
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const [outcome, setOutcome] = useState('');
  const validation = validateDraft(draft);
  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Keep the in-memory draft. */ }
  }, [draft]);
  function change(key: keyof DropJobDraft, value: string) {
    setDraft(previous => {
      const next = { ...previous, [key]: value };
      if (key === 'body' && !previous.id && value.trim().split(/\s+/).length >= 3) next.id = suggestId(value, Date.now());
      return next;
    });
  }
  async function write() {
    if (!validation.ok || pending.current) return;
    pending.current = true;
    setSending(true);
    setOutcome('');
    try {
      const result = await postDropJob(draft);
      setOutcome(outcomeText(result.status, result.payload));
      if (result.status === 201) {
        setDraft(previous => ({ ...previous, body: '', id: '' }));
        try { await refetchQuery(dropJobsQuery.key, () => dropJobsQuery.fetch(), true); }
        catch { setOutcome(`${outcomeText(result.status, result.payload)}. Waiting in drop could not refresh.`); }
      }
    } catch (error) {
      setOutcome(error instanceof VerseControlLockedError ? error.message : readFailureReason(error));
    } finally { pending.current = false; setSending(false); }
  }
  return <Sheet open={open} onClose={onClose} titleId="drop-job-title" title="New job">
    <form onSubmit={event => { event.preventDefault(); void write(); }}>
      <p><label>Id <input value={draft.id} disabled={sending} onChange={event => change('id', event.target.value)} /></label></p>
      <p><label>Lane <select value={draft.lane} disabled={sending} onChange={event => change('lane', event.target.value)}>{lanes.map(lane => <option key={lane}>{lane}</option>)}</select></label></p>
      <p><label>Tier <select value={draft.tier} disabled={sending} onChange={event => change('tier', event.target.value)}>{tiers.map(tier => <option key={tier}>{tier}</option>)}</select></label></p>
      <p><label>Body <textarea rows={12} value={draft.body} disabled={sending} onChange={event => change('body', event.target.value)} /></label></p>
      <p>{draftBytes(draft)} of 8000 bytes</p>
      {!validation.ok && <ul aria-label="Draft validation">{validation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      <Button type="submit" disabled={!validation.ok || sending} busy={sending}>Write</Button>
      {outcome && <p role="status">{outcome}</p>}
    </form>
  </Sheet>;
}
