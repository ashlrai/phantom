import { ageInSeconds } from '../../../lib/relative-time.js';
import { useCallback, useEffect, useId, useState } from 'react';
import styles from './FrictionFeedback.module.css';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { apiGetWithMutationToken, apiPost } from '../../../data/client.js';
import { getMutationToken } from '../../../data/auth-store.js';

/**
 * The request dialog and its submit, loaded when the rail's ⚑ is first pressed
 * (FrictionFeedback.tsx) — the button is first paint, the form is not.
 */
interface RequestHistoryItem {
  jobId: string;
  surface: string;
  ageSeconds: number;
  status: string;
  fate?: { fate: 'ingested' | 'rejected'; queued: boolean } | null;
  pr: { url: string; state: 'open' | 'merged' | 'closed' | null } | null;
}

type ChangeRequestResponse =
  | { status: 'queued'; jobId: string }
  | { status: 'duplicate'; jobId: string }
  | { status: 'deferred'; reason: 'queue-full' }
  | { status: 'refused'; reason: string };

function refusalText(reason: string): string {
  switch (reason) {
    case 'secret-shaped': return 'This request looks like it contains a secret. Remove secret-like values before submitting.';
    case 'protected-scope': return 'Requests about protected system, security, billing, or out-of-product files cannot be sent to the agent queue.';
    case 'control-characters': return 'This request contains unsupported hidden characters.';
    case 'encoded-content': return 'This request contains encoded content the agent queue cannot accept.';
    case 'invalid-signal': return 'Use a valid screen and a description of up to 2,000 characters.';
    case 'empty': return 'Write a description before submitting.';
    case 'not-actionable': return 'Please describe a specific product change.';
    case 'duplicate': return 'A matching request already exists.';
    case 'drop-job-invalid:too-large': return 'This request is too large for the agent queue.';
    case 'drop-job-invalid:denied-content': return 'This request includes a protected path.';
    default: return 'This request could not be safely queued. Review it and try again.';
  }
}

function changeRequestMessage(result: ChangeRequestResponse): string {
  if (result.status === 'queued') return `Queued for an agent as ${result.jobId}; it will open a pull request.`;
  if (result.status === 'duplicate') return `A request with this ID already exists: ${result.jobId}.`;
  if (result.status === 'deferred') return 'The agent queue is full. Try again later.';
  return refusalText(result.reason);
}

function ageLabel(seconds: number): string {
  return seconds < 60 ? 'just now' : ageInSeconds(seconds);
}

const safePrUrl = (value: string | null | undefined): string | null =>
  value && /^https:\/\/github\.com\/ashlrai\/phantom\/pull\/\d+$/.test(value) ? value : null;

function refusalReason(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { status, body } = error as { status?: unknown; body?: unknown };
  if (status !== 422 || !body || typeof body !== 'object' || Array.isArray(body) || (body as Record<string, unknown>)['status'] !== 'refused') return null;
  const reason = (body as Record<string, unknown>)['reason'];
  return typeof reason === 'string' ? reason : '';
}

export default function FrictionDialog({ surface, description, setDescription, onClose }: {
  surface: string;
  /** Held by the button, so a cancelled flag is still there when reopened. */
  description: string;
  setDescription: (description: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const inputId = useId();
  const buildId = useId();
  const flagId = useId();
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'build' | 'flag'>('build');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [requests, setRequests] = useState<RequestHistoryItem[] | null>(null);
  const [requestsError, setRequestsError] = useState('');
  const close = () => { if (!saving) onClose(); };
  const refreshRequests = useCallback(async (token: string, signal?: AbortSignal) => {
    setRequestsError('');
    try {
      const response = await apiGetWithMutationToken<{ requests: RequestHistoryItem[] }>(
        '/api/verse/change-requests', token, signal,
      );
      setRequests(response.requests);
    } catch {
      if (!signal?.aborted) setRequestsError('Your requests could not be loaded.');
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const token = getMutationToken();
    if (!token) {
      setRequestsError('Authorize console mutations to view your requests.');
      return () => controller.abort();
    }
    void refreshRequests(token, controller.signal);
    return () => controller.abort();
  }, [refreshRequests]);

  const issueUrl = `https://github.com/ashlrai/phantom/issues/new?labels=agent-request&title=${encodeURIComponent(`Desktop request: ${description.trim().slice(0, 60)}`)}&body=${encodeURIComponent(`${description.trim()}\n\nSurface: ${surface}`)}`;

  return <Dialog open onClose={close} titleId={titleId} title="Improve this screen"
      description="Describe a change for an agent to build, or just flag what got in your way.">
      <form className={styles.form} onSubmit={async (event) => {
          event.preventDefault();
          if (saving || !description.trim()) return;
          setSaving(true); setError(''); setResult('');
          try {
            const token = getMutationToken();
            if (!token) throw new Error(`Authorize console mutations before ${mode === 'build' ? 'submitting a change request' : 'flagging friction'}.`);
            if (mode === 'build') {
              const response = await apiPost<ChangeRequestResponse>('/api/verse/change-request',
                { description: description.trim(), surface }, token);
              setResult(changeRequestMessage(response));
              if (response.status === 'queued') setDescription('');
              await refreshRequests(token);
            } else {
              await apiPost('/api/verse/feedback', { description: description.trim(), surface }, token);
              setDescription('');
              setResult('Flag saved to the local router queue.');
          }
          } catch (cause) {
            const reason = refusalReason(cause);
            if (reason !== null) {
              setResult(refusalText(reason));
            } else {
              setError(cause instanceof Error ? cause.message : 'Could not save the request. Try again.');
            }
          } finally { setSaving(false); }
        }}>
          <fieldset className={styles.modes} disabled={saving}>
            <legend>Choose what to do</legend>
            <label htmlFor={buildId}><input id={buildId} type="radio" name={titleId} checked={mode === 'build'}
              onChange={() => { setMode('build'); setError(''); setResult(''); }} />Build it</label>
            <label htmlFor={flagId}><input id={flagId} type="radio" name={titleId} checked={mode === 'flag'}
              onChange={() => { setMode('flag'); setError(''); setResult(''); }} />Just flag it</label>
          </fieldset>
          <label htmlFor={inputId}>{mode === 'build' ? 'What change would you like?' : 'What felt frustrating?'}</label>
          <textarea id={inputId} value={description} maxLength={2000} required disabled={saving}
            onChange={(event) => setDescription(event.target.value)} />
          <p>Surface: {surface}. Include only details you want stored in the request.</p>
          {error && <p role="alert">{error}</p>}
          {result && <p role="status">{result}</p>}
          <button type="button" disabled={saving} onClick={close}>Cancel</button>
          <button type="submit" disabled={saving || !description.trim()}>
            {saving ? 'Sending…' : mode === 'build' ? 'Send to agent' : 'Save flag'}
          </button>
          <a href={issueUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => {
            event.preventDefault();
            window.open(issueUrl, '_blank', 'noopener,noreferrer');
          }}>Send to Phantom maintainers</a>
      </form>
      <section className={styles.requests} aria-label="Your requests">
        <h3>Your requests</h3>
        {requestsError ? <p role="alert">{requestsError}</p>
          : requests === null ? <p>Loading requests…</p>
            : requests.length === 0 ? <p>No requests yet.</p>
              : <ul>{requests.map((request) => {
                const prUrl = safePrUrl(request.pr?.url);
                const status = request.fate?.queued ? 'queued' : request.fate?.fate ?? request.status;
                return <li key={request.jobId}>
                  <span>{request.surface}</span>
                  <span>{ageLabel(request.ageSeconds)}</span>
                  <span>{status}</span>
                  {prUrl && <a href={prUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => {
                    event.preventDefault();
                    window.open(prUrl, '_blank', 'noopener,noreferrer');
                  }}>Open pull request</a>}
                  {prUrl && request.pr?.state && <span>{request.pr.state}</span>}
                </li>;
              })}</ul>}
      </section>
    </Dialog>;
}
