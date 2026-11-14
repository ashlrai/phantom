/**
 * routes/verse/fleet-board/RecheckNowButton.tsx — runs and records one fresh
 * recheck on the server, then refreshes the history strip and the "Server
 * recheck" line. One press, one request: it never retries on its own.
 */
import { useState } from 'react';
import { ApiError, apiPost } from '../../../data/client.js';
import { useMutationHold, useRefetch } from '../../../data/hooks.js';
import { Button } from '../../../components/primitives/Button.js';
import { recheckHistoryQuery } from './recheck-history-model.js';
import { describeRecheckNow, type RecheckNowResult } from './recheck-now-model.js';
import { recheckVerdictQuery } from './recheck-verdict-query.js';
import styles from './fleet-board.module.css';

const PATH = '/api/verse/fleet/recheck/record';

/** The route's own `reason` (ApiError.detail prefers `error`, which is just "record failed"). */
function refusalReason(error: ApiError): string | null {
  const body = error.body;
  const reason = body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' && reason ? reason : error.detail;
}

export function RecheckNowButton() {
  const { token, touch } = useMutationHold();
  const refetchHistory = useRefetch(recheckHistoryQuery);
  const refetchVerdict = useRefetch(recheckVerdictQuery);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState('');

  async function run() {
    if (busy) return;
    setBusy(true);
    let result: RecheckNowResult;
    try {
      if (!token) throw new ApiError('Mutation token is missing.', 401, PATH);
      const resp = await apiPost<{ recorded?: unknown }>(PATH, {}, token);
      result = { ok: true, recorded: resp?.recorded };
    } catch (error) {
      result = error instanceof ApiError
        ? { ok: false, status: error.status, reason: refusalReason(error) }
        : { ok: false, status: 0, reason: 'the server could not be reached' };
    } finally { setBusy(false); }
    setLine(describeRecheckNow(result));
    if (result.ok) { touch(); refetchHistory(); refetchVerdict(); }
  }

  return (
    <div>
      <Button size="sm" disabled={busy} onClick={() => { void run(); }}>{busy ? 'Rechecking…' : 'Recheck now'}</Button>
      <p className={styles.recheckNote} aria-live="polite">{line}</p>
    </div>
  );
}
