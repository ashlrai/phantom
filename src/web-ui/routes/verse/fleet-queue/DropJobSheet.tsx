import { useEffect, useRef, useState } from 'react';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { Button } from '../../../components/primitives/index.js';
import { refetchQuery } from '../../../data/cache.js';
import { readFailureReason } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { mergeBacklogQuery } from '../fleet-merges/merge-backlog-queries.js';
import { fleetSupplyQuery } from '../fleet-supply/fleet-supply-queries.js';
import { draftBytes, lanes, outcomeText, suggestId, tiers, validateDraft, type DropJobDraft } from './drop-job-model.js';
import { dropJobsQuery, postDropJob } from './drop-job-queries.js';
import { dropJobPreflight, laneLine } from './drop-job-preflight.js';
import { laneHoldsQuery } from './queue-holds-model.js';
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
  const [extracted, setExtracted] = useState<string | null>(null);
  const [pledged, setPledged] = useState('');
  const ready = open && extracted !== null;
  const backlog = useQuery(mergeBacklogQuery, { enabled: ready });
  const holds = useQuery(laneHoldsQuery, { enabled: ready });
  const supply = useQuery(fleetSupplyQuery, { enabled: ready });
  useEffect(() => {
    const timer = setTimeout(() => setExtracted(draft.body), 300);
    return () => clearTimeout(timer);
  }, [draft.body]);
  const preflight = dropJobPreflight(extracted === draft.body ? extracted : '', backlog.status === 'success' ? backlog.data : null);
  const warnings = preflight.warnings;
  const hits = preflight.hotFiles;
  const hitsKey = hits.map(hit => hit.path).join('\n');
  const oneHunk = hitsKey !== '' && pledged === hitsKey;
  const supplyData = supply.status === 'success' && supply.data && typeof supply.data === 'object' && 'lanes' in supply.data && Array.isArray(supply.data.lanes) ? supply.data.lanes : [];
  const targets = holds.status === 'success' && holds.data ? { ...holds.data, lanes: holds.data.lanes.map(row => {
    const counts: unknown = supplyData.find((item: unknown) => item && typeof item === 'object' && 'lane' in item && item.lane === row.lane);
    if (!counts || typeof counts !== 'object') return { ...row, running: undefined, queued: undefined };
    const running = 'running' in counts && typeof counts.running === 'number' ? counts.running : undefined;
    const queued = 'queued' in counts && typeof counts.queued === 'number' ? counts.queued : undefined;
    return { ...row, running, queued };
  }) } : null;
  const selected = targets?.lanes.find(row => row.lane === draft.lane);
  const blocked = selected?.held || (selected?.running !== undefined && selected.running >= selected.target) || selected?.target === 0;
  const availability = blocked ? laneLine(draft.lane, targets, Date.now()) : null;
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
      {(warnings.length > 0 || hits.length > 0 || availability) && <ul aria-label="Preflight">
        {hits.map(hit => <li key={`hot:${hit.path}`}>{hit.path} is in {hit.dirtyPrs} conflicting PRs ({hit.openPrs} open)</li>)}
        {warnings.map(warning => {
          const openPrs = Math.max(backlog.data?.hotFiles?.find(file => file.path === warning.path)?.openPrs ?? 0,
            backlog.data?.items.filter(item => item.files?.includes(warning.path)).length ?? 0);
          const numbers = warning.prNumbers.length ? ` (${warning.prNumbers.map(number => `#${number}`).join(', ')}${openPrs > warning.prNumbers.length ? ', …' : ''})` : '';
          return <li key={warning.path}>{warning.path} is in {openPrs} open {openPrs === 1 ? 'PR' : 'PRs'}{numbers} — a job that edits it will go DIRTY; name a new file instead</li>;
        })}
        {availability && <li>{availability}</li>}
      </ul>}
      {hits.length > 0 && <p><label><input type="checkbox" checked={oneHunk} disabled={sending} onChange={event => setPledged(event.target.checked ? hitsKey : '')} /> I will keep edits to these files to one hunk</label></p>}
      {!validation.ok && <ul aria-label="Draft validation">{validation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      <Button type="submit" disabled={!validation.ok || sending} busy={sending}>{hits.length > 0 && !oneHunk ? 'Drop anyway' : 'Write'}</Button>
      {outcome && <p role="status">{outcome}</p>}
    </form>
  </Sheet>;
}
