/**
 * routes/verse/models/ModelsPane.tsx: the model registry as one table, built only on
 * `GET /api/verse/fleet/control/models` (same rows as `phm models --json`) with one
 * action per row: "Verify" (`POST …/models/verify`, same as
 * `phm models verify <id> --source <url>`). The server re-reads the official doc page
 * and refuses unless it names the exact id; that refusal is shown as written.
 * Unknown lanes, dates and sources read "Unknown", never a guess.
 */
import { useState } from 'react';
import type { ModelRegistryList, ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { Card, CardNote } from '../command/Surface.js';
import styles from './models.module.css';

const PATH = '/api/verse/fleet/control/models';

/** Another shape (an older server, a wrong route) is unreadable, not an empty registry. */
export const modelRegistryQuery: QueryDef<ModelRegistryList> = {
  key: 'verse-model-registry',
  fetch: async signal => {
    const list = await apiGet<ModelRegistryList>(PATH, signal);
    if (!list || list.schema !== 'models.registry.v1' || !Array.isArray(list.entries)) throw new Error('unexpected model registry');
    return list;
  },
};

export async function postVerifyModel(id: string, source: string): Promise<ModelRegistryRow> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock actions with the mutation token to verify models.');
  const row = await apiPost<ModelRegistryRow>(`${PATH}/verify`, { id, source }, token);
  touchMutationHold();
  return row;
}

export function statusText(row: ModelRegistryRow): string {
  return row.stale ? 'Stale (verified over 30 days ago)' : row.status === 'verified' ? 'Verified' : row.status === 'retired' ? 'Retired' : 'Unverified';
}

type RowState = { busy: true } | { done: true } | { error: string };

export function ModelsPane({ visible = true }: { visible?: boolean }) {
  const result = useQuery(modelRegistryQuery, { enabled: visible, freshMs: 60_000 });
  const refetch = useRefetch(modelRegistryQuery);
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [states, setStates] = useState<ReadonlyMap<string, RowState>>(new Map());
  const set = (id: string, state: RowState) => setStates(prev => new Map(prev).set(id, state));
  const verify = (id: string, source: string) => {
    set(id, { busy: true });
    postVerifyModel(id, source).then(() => { set(id, { done: true }); refetch(); }, (err: unknown) => set(id, {
      error: err instanceof ApiError && err.detail ? err.detail : err instanceof Error ? err.message : 'Could not verify this model.',
    }));
  };

  const rows = result.data?.entries;
  return <div className={styles.root}><Card title="Models" caption="The router only launches models whose name official docs confirm.">
    {rows === undefined ? <CardNote tone={result.status === 'error' ? 'unknown' : 'muted'}>
      {result.status === 'error' ? 'Could not read the model registry, so its state is unknown.' : 'Checking models…'}
    </CardNote> : rows.length === 0 ? <CardNote>No models are registered yet. Add one with: phm models verify &lt;id&gt; --provider &lt;name&gt; --source &lt;official doc URL&gt;</CardNote>
      : <table className={styles.table}>
        <thead><tr><th scope="col">Model</th><th scope="col">Provider</th><th scope="col">Lanes</th><th scope="col">Status</th><th scope="col">Verified on</th><th scope="col">Source</th><th scope="col">Action</th></tr></thead>
        <tbody>{rows.map(row => {
          const state = states.get(row.id), busy = state !== undefined && 'busy' in state;
          const source = row.source_url ?? urls.get(row.id)?.trim() ?? '';
          return <tr key={row.id} data-blocked={row.unverified || undefined}>
            <th scope="row">{row.id}</th>
            <td>{row.provider}</td>
            <td>{row.lanes.join(', ') || 'Unknown'}</td>
            <td>{statusText(row)}</td>
            <td>{row.verified_on ?? 'Unknown'}</td>
            <td>{row.source_url?.startsWith('https://') ? <a href={row.source_url} target="_blank" rel="noreferrer">{new URL(row.source_url).hostname}</a>
              : row.status === 'retired' ? 'Unknown'
              : <input type="url" className={styles.url} placeholder="Official doc URL" aria-label={`Official doc URL for ${row.id}`}
                value={urls.get(row.id) ?? ''} onChange={event => { const value = event.target.value; setUrls(prev => new Map(prev).set(row.id, value)); }} />}</td>
            <td>
              {row.status === 'retired' ? null : <button type="button" className={styles.action} disabled={busy || !source}
                onClick={() => verify(row.id, source)} aria-label={`${row.verified ? 'Check again' : 'Verify'}: ${row.id}`}>{row.verified ? 'Check again' : 'Verify'}</button>}
              {state && 'done' in state ? <span className={styles.note} role="status"> Confirmed by the docs today.</span> : null}
              {state && 'error' in state ? <span className={styles.bad} role="alert"> {state.error}</span> : null}
            </td>
          </tr>;
        })}</tbody>
      </table>}
  </Card></div>;
}
