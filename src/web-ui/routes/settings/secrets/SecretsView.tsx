import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { projectSecrets } from '../../../../core/workbench/secrets-model.js';

const secretsQuery = {
  key: 'workbench-secrets',
  fetch: async (signal?: AbortSignal) => {
    try { return projectSecrets(await apiGet<unknown>('/api/wb/v1/secrets', signal)); }
    catch { throw new Error('Custody metadata unavailable.'); }
  },
};
export function SecretsView() {
  const query = useQuery(secretsQuery);
  const refresh = useRefetch(secretsQuery);
  return <section aria-label="Phantom Secrets custody">
    <h1>Phantom Secrets</h1>
    <p>Custody metadata: names, scope, age and last rotation.</p>
    <button type="button" onClick={() => { void refresh(); }}>Refresh secrets</button>
    {query.status === 'loading' && <p role="status">Loading custody metadata…</p>}
    {(query.error || query.data?.state === 'unknown') && <p role="status">Custody metadata unavailable.</p>}
    {query.data?.state === 'ok' && (query.data.secrets.length === 0 ? <p>No secrets listed.</p> :
      <table><thead><tr><th>Name</th><th>Scope</th><th>Age</th><th>Last rotated</th></tr></thead>
        <tbody>{query.data.secrets.map((row, index) => <tr key={index}>
          <td>{row.name}</td><td>{row.scope ?? 'Unknown'}</td>
          <td>{row.ageMs === null ? 'Unknown' : `${Math.floor(row.ageMs / 86_400_000)} days`}</td>
          <td>{row.lastRotated ?? 'Unknown'}</td>
        </tr>)}</tbody></table>)}
  </section>;
}
